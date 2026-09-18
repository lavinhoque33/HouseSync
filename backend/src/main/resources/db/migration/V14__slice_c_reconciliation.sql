-- M3 Slice C: reconciliation and recovery without new tables. Forward-only; V1-V13 are
-- never edited.
--
-- - Widens the durable operation idempotency CHECK with BANK_ACTIVITY_RESOLVE and
--   BANK_ACTIVITY_REPLACE so explicit review decisions and atomic replacements replay under the
--   same actor/household/operation/key contract as confirm/dismiss. No new tables: KEEP_LEDGER
--   updates the observation's admitted_revision, and replacement history is retained through
--   VOIDED connection_ledger_associations rows.
-- - Version-guard parity needs no change: connection_observations.version already carries the
--   same 0..2147483647 CHECK as financial_connections.version and financial_transactions.version,
--   and the Slice C services reject exhausted counters with RESOURCE_VERSION_EXHAUSTED before
--   any write.

ALTER TABLE connection_operation_idempotency_keys
  DROP CONSTRAINT connection_operation_idempotency_operation_check;

ALTER TABLE connection_operation_idempotency_keys
  ADD CONSTRAINT connection_operation_idempotency_operation_check CHECK (operation IN (
    'LINK_START', 'LINK_COMPLETE', 'ACCOUNTS_SELECT', 'RECONNECT', 'DISCONNECT',
    'SYNC', 'BANK_ACTIVITY_CONFIRM', 'BANK_ACTIVITY_DISMISS',
    'BANK_ACTIVITY_RESOLVE', 'BANK_ACTIVITY_REPLACE'));
