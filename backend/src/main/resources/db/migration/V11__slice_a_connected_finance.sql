-- M3 Slice A: CAD support and private connected-finance linking lifecycle.
--
-- Currency/source widening (forward-only; V6/V7/V9 constraints are replaced, never edited):
-- CAD (scale 2) joins the currency allowlist on accounts, transactions, allocations, and
-- allocation participants. Existing scale checks need no change: their CASE defaults treat
-- any non-JPY/non-KWD currency at scale 2, which matches CAD. Account and transaction source
-- checks widen from MANUAL-only to MANUAL/CONNECTED; the manual transaction POST stays
-- MANUAL-only through application validation, and CONNECTED rows are created only by the
-- account-selection use case.
--
-- New records (Slice A only; no sync/observation/webhook tables yet):
-- - financial_connections: one private provider Item per household owner. Raw provider Item
--   identities are never persisted; remote_item_digest is the hex SHA-256 over a stable
--   provider/environment/remote-identity string and carries the uniqueness scope.
-- - financial_connection_account_mappings: discovered provider accounts with local mapping
--   IDs for browser selection. Raw provider account identities are likewise digest-only.
-- - connection_link_attempts: expiring NEW/UPDATE link attempts with encrypted replayable
--   link tokens and encrypted short-lived public tokens erased on terminal outcome/expiry.
-- - connection_operations: durable completion/disconnect operations with explicit
--   OUTCOME_UNKNOWN for ambiguous exchange/removal results.
-- - connection_operation_idempotency_keys: durable replay storage for link/select/
--   reconnect/disconnect POSTs; authorization always runs before replay.
-- - connection_revocation_work: durable remote-removal work that survives membership loss.
--
-- All references point at households, users, connections, attempts, or accounts -- never
-- membership rows -- so departure/rejoin keeps history intact while revoking access.

ALTER TABLE financial_accounts
  DROP CONSTRAINT financial_accounts_currency_check;
ALTER TABLE financial_accounts
  ADD CONSTRAINT financial_accounts_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'CAD'));

ALTER TABLE financial_accounts
  DROP CONSTRAINT financial_accounts_source_check;
ALTER TABLE financial_accounts
  ADD CONSTRAINT financial_accounts_source_check
    CHECK (source IN ('MANUAL', 'CONNECTED'));

ALTER TABLE financial_transactions
  DROP CONSTRAINT financial_transactions_currency_check;
ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'CAD'));

ALTER TABLE financial_transactions
  DROP CONSTRAINT financial_transactions_source_check;
ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_source_check
    CHECK (source IN ('MANUAL', 'CONNECTED'));

ALTER TABLE financial_transaction_allocations
  DROP CONSTRAINT financial_transaction_allocations_currency_check;
ALTER TABLE financial_transaction_allocations
  ADD CONSTRAINT financial_transaction_allocations_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'CAD'));

ALTER TABLE financial_transaction_allocation_participants
  DROP CONSTRAINT financial_transaction_allocation_participants_currency_check;
ALTER TABLE financial_transaction_allocation_participants
  ADD CONSTRAINT financial_transaction_allocation_participants_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'CAD'));

CREATE TABLE financial_connections (
  id UUID NOT NULL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  provider VARCHAR(16) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  remote_item_digest VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  generation BIGINT NOT NULL,
  version INTEGER NOT NULL,
  encrypted_credential TEXT,
  credential_key_id VARCHAR(64),
  cursor TEXT,
  last_successful_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_connections_household_owner_id_unique
    UNIQUE (id, household_id, owner_user_id),
  CONSTRAINT financial_connections_remote_item_unique
    UNIQUE (provider, environment, remote_item_digest),
  CONSTRAINT financial_connections_provider_check CHECK (provider = 'PLAID'),
  CONSTRAINT financial_connections_environment_check
    CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  CONSTRAINT financial_connections_remote_item_digest_check
    CHECK (remote_item_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT financial_connections_state_check CHECK (state IN (
    'LINKING', 'ACTIVE', 'REAUTH_REQUIRED', 'SUSPENDED',
    'DISCONNECTING', 'DISCONNECTED', 'ERROR')),
  CONSTRAINT financial_connections_generation_check CHECK (generation >= 0),
  CONSTRAINT financial_connections_version_check CHECK (version BETWEEN 0 AND 2147483647),
  CONSTRAINT financial_connections_credential_paired CHECK (
    (encrypted_credential IS NULL) = (credential_key_id IS NULL)),
  CONSTRAINT financial_connections_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX financial_connections_owner_list_idx
  ON financial_connections (household_id, owner_user_id, created_at, id);

CREATE TABLE financial_connection_account_mappings (
  id UUID NOT NULL PRIMARY KEY,
  connection_id UUID NOT NULL,
  household_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  remote_account_digest VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  local_account_id UUID REFERENCES financial_accounts (id) ON DELETE RESTRICT,
  selected BOOLEAN NOT NULL,
  eligible BOOLEAN NOT NULL,
  exclusion_reason VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_connection_account_mappings_connection_reference
    FOREIGN KEY (connection_id, household_id, owner_user_id)
    REFERENCES financial_connections (id, household_id, owner_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT financial_connection_account_mappings_remote_unique
    UNIQUE (connection_id, remote_account_digest),
  CONSTRAINT financial_connection_account_mappings_remote_digest_check
    CHECK (remote_account_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT financial_connection_account_mappings_name_length
    CHECK (char_length(display_name) BETWEEN 1 AND 100),
  CONSTRAINT financial_connection_account_mappings_kind_check
    CHECK (kind IN ('CASH', 'CHECKING', 'SAVINGS', 'CREDIT_CARD')),
  CONSTRAINT financial_connection_account_mappings_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD', 'CAD')),
  -- Deselection keeps the admitted local account for history while blocking new
-- admission; only the selected flag gates admission, so ineligible rows stay unselected.
  CONSTRAINT financial_connection_account_mappings_selection_check CHECK (
    (NOT selected) OR eligible),
  CONSTRAINT financial_connection_account_mappings_timestamp_order
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX financial_connection_account_mappings_local_account_uidx
  ON financial_connection_account_mappings (local_account_id)
  WHERE local_account_id IS NOT NULL;

CREATE INDEX financial_connection_account_mappings_connection_list_idx
  ON financial_connection_account_mappings (connection_id, id);

CREATE TABLE connection_link_attempts (
  id UUID NOT NULL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  flow VARCHAR(8) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  connection_id UUID REFERENCES financial_connections (id) ON DELETE RESTRICT,
  state VARCHAR(32) NOT NULL,
  encrypted_link_token TEXT,
  link_token_key_id VARCHAR(64),
  link_token_expires_at TIMESTAMPTZ,
  encrypted_public_token TEXT,
  public_token_key_id VARCHAR(64),
  operation_id UUID,
  expected_generation BIGINT,
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT connection_link_attempts_flow_check CHECK (flow IN ('NEW', 'UPDATE')),
  CONSTRAINT connection_link_attempts_environment_check
    CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  CONSTRAINT connection_link_attempts_state_check CHECK (state IN (
    'LINK_TOKEN_ISSUED', 'EXCHANGING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'OUTCOME_UNKNOWN')),
  CONSTRAINT connection_link_attempts_link_token_paired CHECK (
    (encrypted_link_token IS NULL) = (link_token_key_id IS NULL)),
  CONSTRAINT connection_link_attempts_public_token_paired CHECK (
    (encrypted_public_token IS NULL) = (public_token_key_id IS NULL)),
  CONSTRAINT connection_link_attempts_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX connection_link_attempts_owner_list_idx
  ON connection_link_attempts (household_id, owner_user_id, created_at, id);

CREATE TABLE connection_operations (
  id UUID NOT NULL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  connection_id UUID REFERENCES financial_connections (id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES connection_link_attempts (id) ON DELETE RESTRICT,
  operation_type VARCHAR(32) NOT NULL,
  state VARCHAR(16) NOT NULL,
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT connection_operations_type_check
    CHECK (operation_type IN ('LINK_COMPLETE', 'DISCONNECT')),
  CONSTRAINT connection_operations_state_check
    CHECK (state IN ('PENDING', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN')),
  CONSTRAINT connection_operations_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX connection_operations_owner_list_idx
  ON connection_operations (household_id, owner_user_id, created_at, id);

CREATE TABLE connection_operation_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL,
  idempotency_key UUID NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  resource_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT connection_operation_idempotency_keys_pk
    PRIMARY KEY (actor_user_id, household_id, operation, idempotency_key),
  CONSTRAINT connection_operation_idempotency_operation_check
    CHECK (operation IN (
      'LINK_START', 'LINK_COMPLETE', 'ACCOUNTS_SELECT', 'RECONNECT', 'DISCONNECT')),
  CONSTRAINT connection_operation_idempotency_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX connection_operation_idempotency_resource_idx
  ON connection_operation_idempotency_keys (resource_id);

CREATE TABLE connection_revocation_work (
  id UUID NOT NULL PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES financial_connections (id) ON DELETE RESTRICT,
  state VARCHAR(16) NOT NULL,
  attempt_count INTEGER NOT NULL,
  next_retry_at TIMESTAMPTZ NOT NULL,
  last_error VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT connection_revocation_work_state_check
    CHECK (state IN ('QUEUED', 'IN_PROGRESS', 'DONE', 'FAILED')),
  CONSTRAINT connection_revocation_work_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT connection_revocation_work_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX connection_revocation_work_due_idx
  ON connection_revocation_work (state, next_retry_at, id);
