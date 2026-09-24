-- M4 Slice B: owner-private categorization rules (ADR 0009 §4, categorization contract §4).
-- Forward-only; V1-V15 are never edited.
--
-- A categorization rule belongs to one household and one financial owner, referencing stable
-- user IDs (never membership rows) so departure preserves retained history while current
-- membership alone gates access. A household OWNER role confers no access to another user's
-- rules: every read and write is scoped by owner_user_id, and the list/patch authorizations
-- resolve through that scope.
--
-- Match evidence:
-- - match_type PROVIDER_MERCHANT stores a provider-stable merchant identity as its scope-bound
--   SHA-256 hex digest in match_key; raw provider identifiers are never persisted.
-- - match_type NORMALIZED_TEXT stores the conservative text key (NFKC, locale-independent
--   lowercase, collapsed Unicode whitespace, trimmed, punctuation/digits/order preserved) in
--   match_key. Empty or over-limit normalizations can never become rules.
-- - match_key is the private match key and never reaches a browser response; match_label is the
--   bounded private display label (description or merchant display name).
-- - ruleset_version identifies the owner-rule policy generation that produced the key, so
--   normalizer/digest behavior cannot drift silently.
-- - source_transaction_id records the owner-posted entry the rule was learned from; the composite
--   reference enforces same household and owner in the database.
--
-- The ledger's Slice A category_rule_id column gains its retained reference here: OWNER_RULE
-- provenance keeps pointing at the retained rule after deactivation, and the reference binds
-- household AND financial owner (ledger row owner_user_id = rule owner_user_id) through the
-- rule's (id, household_id, owner_user_id) unique, so one owner's ledger row can never carry
-- another owner's rule reference. ON DELETE RESTRICT mirrors the no-hard-delete policy.
-- Deactivation is a one-way status move; reactivation, bulk apply, import, export, and
-- cross-owner sharing are not M4 routes.

CREATE TABLE categorization_rules (
  id UUID NOT NULL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  source_transaction_id UUID NOT NULL,
  match_type VARCHAR(17) NOT NULL,
  match_key VARCHAR(200) NOT NULL,
  match_label VARCHAR(200) NOT NULL,
  category VARCHAR(24) NOT NULL,
  status VARCHAR(16) NOT NULL,
  version INTEGER NOT NULL,
  ruleset_version VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT categorization_rules_household_owner_unique
    UNIQUE (id, household_id, owner_user_id),
  CONSTRAINT categorization_rules_match_type_check
    CHECK (match_type IN ('PROVIDER_MERCHANT', 'NORMALIZED_TEXT')),
  CONSTRAINT categorization_rules_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT categorization_rules_category_check
    CHECK (category IN (
      'HOUSING',
      'GROCERIES',
      'DINING',
      'UTILITIES',
      'TRANSPORTATION',
      'SHOPPING',
      'ENTERTAINMENT',
      'HEALTHCARE',
      'TRAVEL',
      'EDUCATION',
      'PERSONAL',
      'HOUSEHOLD_SUPPLIES',
      'SUBSCRIPTIONS',
      'INCOME',
      'TRANSFERS',
      'MISCELLANEOUS')),
  -- A provider merchant rule keys on the scope-bound digest; a text rule keys the normalized
  -- text. Neither form may carry control characters, and text keys are bounded like
  -- descriptions.
  CONSTRAINT categorization_rules_match_key_check CHECK (
    (match_type = 'PROVIDER_MERCHANT' AND match_key ~ '^[0-9a-f]{64}$')
    OR (match_type = 'NORMALIZED_TEXT'
        AND char_length(match_key) BETWEEN 1 AND 200
        AND match_key !~ E'[\x01-\x1F\x7F]'
        AND match_key !~ ('[' || chr(128) || '-' || chr(159) || ']'))),
  CONSTRAINT categorization_rules_match_label_length CHECK (
    char_length(match_label) BETWEEN 1 AND 200),
  CONSTRAINT categorization_rules_match_label_no_controls CHECK (
    match_label !~ E'[\x01-\x1F\x7F]'
    AND match_label !~ ('[' || chr(128) || '-' || chr(159) || ']')),
  CONSTRAINT categorization_rules_version_check CHECK (version BETWEEN 0 AND 2147483647),
  CONSTRAINT categorization_rules_ruleset_version_check CHECK (
    char_length(ruleset_version) BETWEEN 1 AND 32),
  CONSTRAINT categorization_rules_timestamp_order CHECK (updated_at >= created_at)
);

-- At most one active rule per owner/match key; deactivation retains history and frees the key.
CREATE UNIQUE INDEX categorization_rules_owner_key_active_unique
  ON categorization_rules (household_id, owner_user_id, match_type, match_key)
  WHERE status = 'ACTIVE';

-- Owner-private management page ordering (updatedAt DESC, id DESC).
CREATE INDEX categorization_rules_owner_list_idx
  ON categorization_rules (household_id, owner_user_id, updated_at DESC, id DESC);

-- The source ledger entry reference enforces household/owner consistency, exactly like the
-- refund reference. One rule row per source constraint is not added: a retained rule can be
-- superseded by a later rule learned from the same entry.
ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_household_owner_unique
    UNIQUE (id, household_id, owner_user_id),
  ADD CONSTRAINT financial_transactions_category_rule_reference
    FOREIGN KEY (category_rule_id, household_id, owner_user_id)
    REFERENCES categorization_rules (id, household_id, owner_user_id);

ALTER TABLE categorization_rules
  ADD CONSTRAINT categorization_rules_source_entry_reference
    FOREIGN KEY (source_transaction_id, household_id, owner_user_id)
    REFERENCES financial_transactions (id, household_id, owner_user_id);

CREATE TABLE categorization_rule_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL,
  idempotency_key UUID NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  resource_id UUID NOT NULL REFERENCES categorization_rules (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT categorization_rule_idempotency_keys_pk
    PRIMARY KEY (actor_user_id, household_id, operation, idempotency_key),
  CONSTRAINT categorization_rule_idempotency_operation_check
    CHECK (operation = 'CATEGORIZATION_RULE_CREATE'),
  CONSTRAINT categorization_rule_idempotency_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX categorization_rule_idempotency_resource_idx
  ON categorization_rule_idempotency_keys (resource_id);
