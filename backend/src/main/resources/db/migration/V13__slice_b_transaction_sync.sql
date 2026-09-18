-- M3 Slice B: durable fenced transaction sync, verified webhook ingress, private bank-activity
-- observations, and idempotent one-time CONNECTED ledger admission. Forward-only; V1-V12 are never
-- edited.
--
-- New records:
-- - connection_sync_work: one durable coalescing demand row per connection. demand_sequence is
--   monotonic, so a webhook that arrives while a round is running forces another round instead of
--   being lost when work is marked complete. Runs carry a lease owner, expiry, and monotonically
--   increasing fence; a superseded worker cannot commit.
-- - connection_sync_rounds / connection_sync_round_deltas: fenced page staging. A round records the
--   original committed cursor, the working next cursor, its generation and lease fence. Only the
--   final page atomically applies staged deltas and advances the Item-wide cursor; abandoned rounds
--   keep their original cursor and are scrubbed after 24 hours.
-- - connection_observations: private, versioned provider transaction facts keyed by
--   (connection_id, remote_transaction_digest). Pending, posted, removed, and quarantined-invalid
--   rows stay owner-private and never enter reporting. No raw provider payload is archived.
-- - connection_ledger_associations: observation-to-ledger provenance with at most one CURRENT
--   association per observation enforced by a partial unique index, plus one association per ledger
--   entry. Slice C resolution/replacement is not implemented here; the shape only reserves history.
-- - provider_webhook_events: replay fingerprint (provider, environment, signed-JWT hash, body hash)
--   retained at least 24 hours; admission commits before a 200 is returned.
--
-- Connection sync state and initial/historical readiness are stored separately from lifecycle
-- state: ACTIVE never means fresh, so the browser derives staleness from last_successful_sync_at.

ALTER TABLE financial_connections
  ADD COLUMN sync_state VARCHAR(16) NOT NULL DEFAULT 'IDLE',
  ADD COLUMN history_ready BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE financial_connections
  ADD CONSTRAINT financial_connections_sync_state_check
    CHECK (sync_state IN ('IDLE', 'QUEUED', 'RUNNING', 'RETRY_WAIT', 'FAILED'));

-- Per-mapping history coverage: selecting a mapping that was never covered by a committed import
-- resets the Item-wide cursor so the provider replays from the beginning for that account.
ALTER TABLE financial_connection_account_mappings
  ADD COLUMN history_imported BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE connection_sync_work (
  id UUID NOT NULL PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES financial_connections (id) ON DELETE RESTRICT,
  state VARCHAR(16) NOT NULL DEFAULT 'IDLE',
  demand_sequence BIGINT NOT NULL DEFAULT 0,
  committed_sequence BIGINT NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  lease_owner VARCHAR(64),
  lease_expires_at TIMESTAMPTZ,
  lease_fence BIGINT NOT NULL DEFAULT 0,
  last_error VARCHAR(64),
  last_manual_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT connection_sync_work_connection_unique UNIQUE (connection_id),
  CONSTRAINT connection_sync_work_state_check
    CHECK (state IN ('IDLE', 'QUEUED', 'RUNNING', 'RETRY_WAIT', 'FAILED')),
  CONSTRAINT connection_sync_work_sequence_check CHECK (
    demand_sequence >= 0 AND committed_sequence >= 0 AND committed_sequence <= demand_sequence),
  CONSTRAINT connection_sync_work_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT connection_sync_work_fence_check CHECK (lease_fence >= 0),
  CONSTRAINT connection_sync_work_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX connection_sync_work_due_idx
  ON connection_sync_work (state, next_retry_at, id);

CREATE TABLE connection_sync_rounds (
  id UUID NOT NULL PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES financial_connections (id) ON DELETE RESTRICT,
  generation BIGINT NOT NULL,
  lease_fence BIGINT NOT NULL,
  original_cursor TEXT,
  next_cursor TEXT,
  has_more BOOLEAN NOT NULL DEFAULT TRUE,
  delta_count INTEGER NOT NULL DEFAULT 0,
  byte_count BIGINT NOT NULL DEFAULT 0,
  history_ready BOOLEAN NOT NULL DEFAULT FALSE,
  state VARCHAR(16) NOT NULL DEFAULT 'STAGING',
  failure_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT connection_sync_rounds_state_check
    CHECK (state IN ('STAGING', 'APPLIED', 'ABANDONED')),
  CONSTRAINT connection_sync_rounds_counts_check CHECK (delta_count >= 0 AND byte_count >= 0),
  CONSTRAINT connection_sync_rounds_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX connection_sync_rounds_connection_idx
  ON connection_sync_rounds (connection_id, created_at, id);

CREATE INDEX connection_sync_rounds_scrub_idx
  ON connection_sync_rounds (state, updated_at, id);

CREATE TABLE connection_sync_round_deltas (
  round_id UUID NOT NULL REFERENCES connection_sync_rounds (id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  remote_transaction_digest VARCHAR(64) NOT NULL,
  remote_account_digest VARCHAR(64),
  removed BOOLEAN NOT NULL DEFAULT FALSE,
  pending BOOLEAN NOT NULL DEFAULT FALSE,
  provider_revision VARCHAR(64),
  amount NUMERIC(15, 3),
  currency VARCHAR(3),
  occurred_on DATE,
  authorized_on DATE,
  description VARCHAR(500),
  description_valid BOOLEAN NOT NULL DEFAULT FALSE,
  pending_predecessor_digest VARCHAR(64),
  invalid_reason VARCHAR(64),
  PRIMARY KEY (round_id, sequence),
  CONSTRAINT connection_sync_round_deltas_sequence_check CHECK (sequence >= 1),
  CONSTRAINT connection_sync_round_deltas_transaction_digest_check
    CHECK (remote_transaction_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connection_sync_round_deltas_account_digest_check
    CHECK (remote_account_digest IS NULL OR remote_account_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE connection_observations (
  id UUID NOT NULL PRIMARY KEY,
  connection_id UUID NOT NULL,
  household_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  account_mapping_id UUID REFERENCES financial_connection_account_mappings (id) ON DELETE RESTRICT,
  remote_transaction_digest VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  review_state VARCHAR(16) NOT NULL DEFAULT 'UNREVIEWED',
  change_state VARCHAR(16),
  provider_revision VARCHAR(64),
  admitted_revision VARCHAR(64),
  amount NUMERIC(15, 3),
  currency VARCHAR(3),
  occurred_on DATE,
  authorized_on DATE,
  provider_description VARCHAR(500),
  description_valid BOOLEAN NOT NULL DEFAULT FALSE,
  pending_predecessor_digest VARCHAR(64),
  invalid_reason VARCHAR(64),
  dismissed_reason VARCHAR(32),
  dismissed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 0,
  tombstone BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT connection_observations_connection_reference
    FOREIGN KEY (connection_id, household_id, owner_user_id)
    REFERENCES financial_connections (id, household_id, owner_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT connection_observations_identity_unique
    UNIQUE (connection_id, remote_transaction_digest),
  -- Composite identity target so ledger associations cannot mix household or owner.
  CONSTRAINT connection_observations_id_household_owner_unique
    UNIQUE (id, household_id, owner_user_id),
  CONSTRAINT connection_observations_transaction_digest_check
    CHECK (remote_transaction_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connection_observations_state_check
    CHECK (state IN ('PENDING', 'POSTED', 'REMOVED', 'INVALID')),
  CONSTRAINT connection_observations_review_check
    CHECK (review_state IN ('UNREVIEWED', 'CONFIRMED', 'DISMISSED')),
  CONSTRAINT connection_observations_change_check
    CHECK (change_state IS NULL OR change_state IN ('MODIFIED', 'REMOVED')),
  CONSTRAINT connection_observations_currency_check
    CHECK (currency IS NULL OR currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'CAD')),
  CONSTRAINT connection_observations_tombstone_check
    CHECK ((NOT tombstone) OR state = 'REMOVED'),
  -- Confirmable candidates always carry the complete normalized facts; removed, admitted-retained,
  -- and quarantined rows may keep partial evidence.
  CONSTRAINT connection_observations_facts_check CHECK (
    state IN ('REMOVED', 'INVALID')
    OR (amount IS NOT NULL AND currency IS NOT NULL AND occurred_on IS NOT NULL
        AND account_mapping_id IS NOT NULL)),
  CONSTRAINT connection_observations_version_check
    CHECK (version BETWEEN 0 AND 2147483647),
  CONSTRAINT connection_observations_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX connection_observations_owner_inbox_idx
  ON connection_observations (household_id, owner_user_id, created_at DESC, id DESC);

CREATE INDEX connection_observations_connection_idx
  ON connection_observations (connection_id, id);

CREATE TABLE connection_ledger_associations (
  id UUID NOT NULL PRIMARY KEY,
  observation_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  account_id UUID NOT NULL,
  currency VARCHAR(3) NOT NULL,
  admitted_revision VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'CURRENT',
  created_at TIMESTAMPTZ NOT NULL,
  -- Composite references mirror the accepted contract: the association binds an observation and a
  -- ledger entry of the same household/owner, account, and currency (the observation is admitted
  -- into the entry's own account), so direct writes cannot create cross-household provenance or
  -- attach an account or currency the entry does not use.
  CONSTRAINT connection_ledger_associations_observation_reference
    FOREIGN KEY (observation_id, household_id, owner_user_id)
    REFERENCES connection_observations (id, household_id, owner_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT connection_ledger_associations_account_reference
    FOREIGN KEY (account_id, household_id, owner_user_id, currency)
    REFERENCES financial_accounts (id, household_id, owner_user_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT connection_ledger_associations_transaction_reference
    FOREIGN KEY (transaction_id, account_id, household_id, owner_user_id, currency)
    REFERENCES financial_transactions (id, account_id, household_id, owner_user_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT connection_ledger_associations_transaction_unique UNIQUE (transaction_id),
  CONSTRAINT connection_ledger_associations_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'CAD')),
  CONSTRAINT connection_ledger_associations_state_check CHECK (state IN ('CURRENT', 'VOIDED')),
  CONSTRAINT connection_ledger_associations_timestamp_check
    CHECK (admitted_revision ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX connection_ledger_associations_current_observation_uidx
  ON connection_ledger_associations (observation_id)
  WHERE state = 'CURRENT';

CREATE TABLE provider_webhook_events (
  id UUID NOT NULL PRIMARY KEY,
  provider VARCHAR(16) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  signed_jwt_hash VARCHAR(64) NOT NULL,
  body_hash VARCHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT provider_webhook_events_replay_unique
    UNIQUE (provider, environment, signed_jwt_hash, body_hash),
  CONSTRAINT provider_webhook_events_provider_check CHECK (provider = 'PLAID'),
  CONSTRAINT provider_webhook_events_environment_check
    CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  CONSTRAINT provider_webhook_events_hash_check CHECK (
    signed_jwt_hash ~ '^[0-9a-f]{64}$' AND body_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX provider_webhook_events_scrub_idx
  ON provider_webhook_events (received_at, id);

-- Slice B widens durable operation replay with sync and bank-activity operations; ledger admission
-- never creates connection_operations rows.
ALTER TABLE connection_operations
  DROP CONSTRAINT connection_operations_type_check;

ALTER TABLE connection_operations
  ADD CONSTRAINT connection_operations_type_check
    CHECK (operation_type IN ('LINK_COMPLETE', 'DISCONNECT', 'SYNC'));

ALTER TABLE connection_operation_idempotency_keys
  DROP CONSTRAINT connection_operation_idempotency_operation_check;

ALTER TABLE connection_operation_idempotency_keys
  ADD CONSTRAINT connection_operation_idempotency_operation_check CHECK (operation IN (
    'LINK_START', 'LINK_COMPLETE', 'ACCOUNTS_SELECT', 'RECONNECT', 'DISCONNECT',
    'SYNC', 'BANK_ACTIVITY_CONFIRM', 'BANK_ACTIVITY_DISMISS'));
