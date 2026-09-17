-- M3 Slice A review hardening (forward-only; V11 is never edited).
--
-- Durable revocation leases: IN_PROGRESS work carries a monotonically increasing fence, a
-- lease owner, and a lease expiry. A crashed worker's lease expires and becomes reclaimable;
-- the fence lets a late loser detect that its lease was superseded before committing.
ALTER TABLE connection_revocation_work
  ADD COLUMN lease_fence BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN lease_owner VARCHAR(64),
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT connection_revocation_work_lease_fence_check CHECK (lease_fence >= 0);

-- Stable completion fingerprints across encryption-key rotation: the HMAC key id active at
-- reservation time is stored beside the fingerprint so replays recompute with the same key.
ALTER TABLE connection_operation_idempotency_keys
  ADD COLUMN hmac_key_id VARCHAR(64);

-- Honest discovery classification: ineligible provider accounts keep a null kind/currency
-- with an explicit exclusion reason instead of fabricated USD/CHECKING fallbacks. NULL
-- passes CHECK constraints implicitly; the narrowed kind list drops the unreachable CASH
-- allowance the adapter can never produce.
ALTER TABLE financial_connection_account_mappings
  ALTER COLUMN kind DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL;

ALTER TABLE financial_connection_account_mappings
  DROP CONSTRAINT financial_connection_account_mappings_kind_check;

ALTER TABLE financial_connection_account_mappings
  ADD CONSTRAINT financial_connection_account_mappings_kind_check
    CHECK (kind IN ('CHECKING', 'SAVINGS', 'CREDIT_CARD'));

CREATE INDEX connection_revocation_work_lease_due_idx
  ON connection_revocation_work (state, lease_expires_at, next_retry_at, id);
