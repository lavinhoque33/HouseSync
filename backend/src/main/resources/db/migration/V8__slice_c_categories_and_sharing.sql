-- M2 slice C: fixed category taxonomy and selected transaction sharing.
--
-- Category is a nullable descriptive field on the ledger entry, null meaning
-- uncategorized. The token list is a closed, server-owned taxonomy of exactly
-- sixteen entries checked in the database so no direct write can introduce a
-- foreign token; case sensitivity follows from the exact literal list. Category
-- never interacts with kind, visibility, sign, or money.
--
-- Visibility widens from the slice-B PRIVATE-only rule to the selected-sharing
-- allowlist PRIVATE/HOUSEHOLD. Every V7 row is PRIVATE, so the widened check
-- accepts the upgraded data unchanged while blocking anything beyond the two
-- documented tokens. Household feeds still resolve authorization in SQL through
-- the membership join; this index supports that page scan with the same
-- occurred_on/created_at/id ordering as the owner list index.
--
-- Both changes are purely additive for existing rows: V6->V7->V8 upgrades keep
-- accounts, transactions, and idempotency keys intact.

ALTER TABLE financial_transactions
  ADD COLUMN category VARCHAR(24),
  ADD CONSTRAINT financial_transactions_category_check
    CHECK (category IS NULL OR category IN (
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
      'MISCELLANEOUS'));

ALTER TABLE financial_transactions
  DROP CONSTRAINT financial_transactions_visibility_check;

ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_visibility_check
    CHECK (visibility IN ('PRIVATE', 'HOUSEHOLD'));

CREATE INDEX financial_transactions_household_feed_idx
  ON financial_transactions (household_id, visibility, status, occurred_on DESC, created_at DESC, id DESC);
