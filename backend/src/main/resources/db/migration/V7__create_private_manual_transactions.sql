-- M2 slice B: private manual financial transactions, linked refunds, and durable
-- create idempotency for the transaction operation.
--
-- A transaction belongs to a household and a stable user, never to a membership row,
-- mirroring V6 accounts: removal revokes access immediately without deleting retained
-- financial history. Entries are private in this slice; the sharing slice widens the
-- visibility constraint in a forward migration.
--
-- The composite reference to financial_accounts enforces household, owner, and
-- currency consistency in the database itself, so a transaction can never drift from
-- its source account even through direct writes. The refund reference composes the
-- same columns against the source row, so a refund always shares its expense's
-- account, household, owner, and currency. Remaining refund rules (live source, type,
-- date ordering, and the posted-sum cap) are aggregate/stateful and are enforced
-- under transactional locks, not assumed from request validation.
--
-- Amounts persist as NUMERIC(15,3) with currency, range, nonzero, and per-kind sign
-- checks; scale versus the currency allowlist is validated in the application before
-- binding because PostgreSQL scale coercion is not a rounding policy. Descriptions
-- mirror the household/account text policy (outer-trim, no controls, 1-200 code
-- points). The refund list index is partial because only refunds carry a source.

ALTER TABLE financial_accounts
  ADD CONSTRAINT financial_accounts_id_household_owner_currency_unique
    UNIQUE (id, household_id, owner_user_id, currency);

CREATE TABLE financial_transactions (
  id UUID NOT NULL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  account_id UUID NOT NULL,
  kind VARCHAR(16) NOT NULL,
  amount NUMERIC(15, 3) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  occurred_on DATE NOT NULL,
  description VARCHAR(200) NOT NULL,
  source VARCHAR(16) NOT NULL,
  visibility VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  refund_of_transaction_id UUID,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_transactions_account_consistency_unique
    UNIQUE (id, account_id, household_id, owner_user_id, currency),
  CONSTRAINT financial_transactions_account_reference
    FOREIGN KEY (account_id, household_id, owner_user_id, currency)
    REFERENCES financial_accounts (id, household_id, owner_user_id, currency),
  CONSTRAINT financial_transactions_refund_reference
    FOREIGN KEY (refund_of_transaction_id, account_id, household_id, owner_user_id, currency)
    REFERENCES financial_transactions (id, account_id, household_id, owner_user_id, currency),
  CONSTRAINT financial_transactions_kind_check
    CHECK (kind IN ('EXPENSE', 'INCOME', 'REFUND', 'TRANSFER')),
  CONSTRAINT financial_transactions_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT financial_transactions_kind_sign_check CHECK (
    (kind = 'EXPENSE' AND amount < 0)
    OR (kind IN ('INCOME', 'REFUND') AND amount > 0)
    OR (kind = 'TRANSFER')),
  CONSTRAINT financial_transactions_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD')),
  CONSTRAINT financial_transactions_amount_scale_check CHECK (
    CASE currency
      WHEN 'JPY' THEN amount = round(amount, 0)
      WHEN 'KWD' THEN TRUE
      ELSE amount = round(amount, 2)
    END),
  CONSTRAINT financial_transactions_occurred_on_range_check
    CHECK (occurred_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-30'),
  CONSTRAINT financial_transactions_description_length CHECK (char_length(description) BETWEEN 1 AND 200),
  CONSTRAINT financial_transactions_description_trimmed CHECK (
    description
      = btrim(
        description,
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
  CONSTRAINT financial_transactions_description_nonblank CHECK (btrim(description) <> ''),
  CONSTRAINT financial_transactions_description_no_controls CHECK (
    description !~ E'[\x01-\x1F\x7F]'
    AND description !~ ('[' || chr(128) || '-' || chr(159) || ']')),
  CONSTRAINT financial_transactions_source_check CHECK (source = 'MANUAL'),
  CONSTRAINT financial_transactions_visibility_check CHECK (visibility = 'PRIVATE'),
  CONSTRAINT financial_transactions_status_check CHECK (status IN ('POSTED', 'VOIDED')),
  CONSTRAINT financial_transactions_refund_field_check CHECK (
    (kind = 'REFUND') = (refund_of_transaction_id IS NOT NULL)),
  CONSTRAINT financial_transactions_version_check CHECK (version BETWEEN 0 AND 2147483647),
  CONSTRAINT financial_transactions_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX financial_transactions_owner_list_idx
  ON financial_transactions (household_id, owner_user_id, status, occurred_on DESC, created_at DESC, id DESC);

CREATE INDEX financial_transactions_refund_source_idx
  ON financial_transactions (refund_of_transaction_id)
  WHERE refund_of_transaction_id IS NOT NULL;

CREATE TABLE financial_transaction_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL,
  idempotency_key UUID NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  resource_id UUID NOT NULL REFERENCES financial_transactions (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_transaction_idempotency_keys_pk
    PRIMARY KEY (actor_user_id, household_id, operation, idempotency_key),
  CONSTRAINT financial_transaction_idempotency_operation_check
    CHECK (operation = 'TRANSACTION_CREATE'),
  CONSTRAINT financial_transaction_idempotency_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX financial_transaction_idempotency_resource_idx
  ON financial_transaction_idempotency_keys (resource_id);
