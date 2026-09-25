-- Preserve every historical allocation and idempotency fingerprint; no share recalculation.
ALTER TABLE financial_transaction_allocations
  ADD COLUMN method VARCHAR(8) NOT NULL DEFAULT 'EQUAL',
  ADD COLUMN refund_policy VARCHAR(24) NOT NULL DEFAULT 'EQUAL_V1',
  ADD CONSTRAINT financial_transaction_allocations_policy_pair_check CHECK (
    (method = 'EQUAL' AND refund_policy = 'EQUAL_V1') OR
    (method = 'EXACT' AND refund_policy = 'EXACT_JEFFERSON_V1'));
