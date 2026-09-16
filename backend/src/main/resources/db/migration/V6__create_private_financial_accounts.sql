-- M2 slice A: private manual financial accounts and durable create idempotency.
--
-- Accounts belong to a household and a stable user, not to a membership row:
-- membership removal revokes access immediately without deleting or transferring retained
-- financial history. Account metadata is private to that financial owner. The source,
-- visibility, kind, currency, status, and version checks mirror the accepted API contract.

CREATE TABLE financial_accounts (
  id UUID NOT NULL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  source VARCHAR(16) NOT NULL,
  visibility VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_accounts_household_owner_id_unique
    UNIQUE (id, household_id, owner_user_id),
  CONSTRAINT financial_accounts_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT financial_accounts_name_trimmed CHECK (
    name
      = btrim(
        name,
        E' \t\n\x0B\f\r\x1C\x1D\x1E\x1F\x20'
          || chr(133)
          || chr(160)
          || chr(5760)
          || chr(8192)
          || chr(8193)
          || chr(8194)
          || chr(8195)
          || chr(8196)
          || chr(8197)
          || chr(8198)
          || chr(8199)
          || chr(8200)
          || chr(8201)
          || chr(8202)
          || chr(8232)
          || chr(8233)
          || chr(8239)
          || chr(8287)
          || chr(12288))),
  CONSTRAINT financial_accounts_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT financial_accounts_name_no_controls CHECK (
    name !~ E'[\x01-\x1F\x7F]'
    AND name !~ ('[' || chr(128) || '-' || chr(159) || ']')),
  CONSTRAINT financial_accounts_kind_check
    CHECK (kind IN ('CASH', 'CHECKING', 'SAVINGS', 'CREDIT_CARD')),
  CONSTRAINT financial_accounts_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD')),
  CONSTRAINT financial_accounts_source_check CHECK (source = 'MANUAL'),
  CONSTRAINT financial_accounts_visibility_check CHECK (visibility = 'PRIVATE'),
  CONSTRAINT financial_accounts_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT financial_accounts_version_check CHECK (version BETWEEN 0 AND 2147483647),
  CONSTRAINT financial_accounts_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX financial_accounts_owner_list_idx
  ON financial_accounts (household_id, owner_user_id, status, created_at, id);

CREATE TABLE financial_account_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL,
  idempotency_key UUID NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  resource_id UUID NOT NULL REFERENCES financial_accounts (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_account_idempotency_keys_pk
    PRIMARY KEY (actor_user_id, household_id, operation, idempotency_key),
  CONSTRAINT financial_account_idempotency_operation_check
    CHECK (operation = 'ACCOUNT_CREATE'),
  CONSTRAINT financial_account_idempotency_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX financial_account_idempotency_resource_idx
  ON financial_account_idempotency_keys (resource_id);
