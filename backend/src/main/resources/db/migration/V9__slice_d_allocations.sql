-- M2 slice D: basic expense allocations and the durable ALLOCATION_CREATE idempotency
-- association.
--
-- An allocation covers 100% of one expense's positive magnitude, divided equally across a
-- frozen explicit subset of household users. Rows mirror their expense's household, payer
-- (the financial owner), and currency through the composite reference, so a direct write can
-- never allocate a foreign, hidden, or differently-denominated entry. Every stable reference
-- points at households, users, and transactions — never membership rows — so departure and
-- rejoin keep the recorded participants and shares intact while revoking only access.
--
-- Shares persist as exact minor units at the expense's currency scale. Equal division with
-- remainder awarding happens once at creation in ascending canonical user-UUID order and is
-- never recomputed; refund shares are derived at read time from the cumulative posted refund
-- magnitude, so no per-refund share rows exist. A share may be exactly zero: contract-valid
-- tiny magnitudes (USD 0.01 across two participants, JPY 1 across three) exhaust the remainder
-- rule before every participant, so the check admits share >= 0 while the positive original
-- magnitude keeps the allocation nonzero and the division algorithm keeps shares conserving it
-- exactly. The partial unique index enforces at most one
-- ACTIVE allocation per expense while retaining every revoked allocation for history.
--
-- Additive for existing rows: V6->V7->V8->V9 upgrades keep accounts, transactions,
-- idempotency keys, categories, and visibility data intact; the new transaction unique
-- constraint is implied by the primary key and costs only an index.

ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_id_household_owner_currency_unique
    UNIQUE (id, household_id, owner_user_id, currency);

CREATE TABLE financial_transaction_allocations (
  id UUID NOT NULL PRIMARY KEY,
  transaction_id UUID NOT NULL,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  payer_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  currency VARCHAR(3) NOT NULL,
  original_amount NUMERIC(15, 3) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT financial_transaction_allocations_id_currency_unique UNIQUE (id, currency),
  CONSTRAINT financial_transaction_allocations_expense_reference
    FOREIGN KEY (transaction_id, household_id, payer_user_id, currency)
    REFERENCES financial_transactions (id, household_id, owner_user_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT financial_transaction_allocations_status_check
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT financial_transaction_allocations_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD')),
  CONSTRAINT financial_transaction_allocations_amount_positive
    CHECK (original_amount > 0),
  CONSTRAINT financial_transaction_allocations_amount_scale_check CHECK (
    CASE currency
      WHEN 'JPY' THEN original_amount = round(original_amount, 0)
      WHEN 'KWD' THEN TRUE
      ELSE original_amount = round(original_amount, 2)
    END),
  CONSTRAINT financial_transaction_allocations_revoked_paired CHECK (
    (status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CONSTRAINT financial_transaction_allocations_revoked_after_created CHECK (
    revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX financial_transaction_allocations_one_active_idx
  ON financial_transaction_allocations (transaction_id)
  WHERE status = 'ACTIVE';

CREATE INDEX financial_transaction_allocations_household_active_idx
  ON financial_transaction_allocations (household_id)
  WHERE status = 'ACTIVE';

CREATE TABLE financial_transaction_allocation_participants (
  allocation_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  currency VARCHAR(3) NOT NULL,
  share NUMERIC(15, 3) NOT NULL,
  CONSTRAINT financial_transaction_allocation_participants_pk
    PRIMARY KEY (allocation_id, user_id),
  CONSTRAINT financial_transaction_allocation_participants_allocation_reference
    FOREIGN KEY (allocation_id, currency)
    REFERENCES financial_transaction_allocations (id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT financial_transaction_allocation_participants_currency_check
    CHECK (currency IN ('BRL', 'USD', 'EUR', 'GBP', 'JPY', 'KWD')),
  CONSTRAINT financial_transaction_allocation_participants_share_nonnegative
    CHECK (share >= 0),
  CONSTRAINT financial_transaction_allocation_participants_share_scale_check CHECK (
    CASE currency
      WHEN 'JPY' THEN share = round(share, 0)
      WHEN 'KWD' THEN TRUE
      ELSE share = round(share, 2)
    END)
);

CREATE INDEX financial_transaction_allocation_participants_user_idx
  ON financial_transaction_allocation_participants (user_id);

CREATE TABLE financial_allocation_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL,
  idempotency_key UUID NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  resource_id UUID NOT NULL REFERENCES financial_transaction_allocations (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_allocation_idempotency_keys_pk
    PRIMARY KEY (actor_user_id, household_id, operation, idempotency_key),
  CONSTRAINT financial_allocation_idempotency_operation_check
    CHECK (operation = 'ALLOCATION_CREATE'),
  CONSTRAINT financial_allocation_idempotency_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX financial_allocation_idempotency_resource_idx
  ON financial_allocation_idempotency_keys (resource_id);
