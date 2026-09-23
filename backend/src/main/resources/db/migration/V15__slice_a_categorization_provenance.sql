-- M4 Slice A: categorization provenance and normalized provider evidence (ADR 0009,
-- categorization contract §2). Forward-only; V1-V14 are never edited.
--
-- Assignment metadata on the ledger entry:
-- - category_origin records how the effective category was assigned: NONE, LEGACY, USER,
--   OWNER_RULE, PROVIDER, or INHERITED. Provenance describes the current category, not what the
--   latest classifier would choose.
-- - category_assigned_at is the server assignment instant (required for every state). The column
--   default only serves this migration's backfill; it is dropped at the end so every later write
--   must supply it explicitly.
-- - categorization_ruleset_version is the bounded application ruleset version for OWNER_RULE or
--   PROVIDER assignments and null otherwise.
-- - category_rule_id is a nullable internal owner-rule reference with NO foreign key: Slice B
--   creates the retained rule table and adds the reference. It is never browser-projected.
-- - categorization_evidence_fingerprint is the internal digest of the provider categorization
--   evidence that fed the assignment; it supports later stale-work rejection and never reaches a
--   browser response.
--
-- Backfill (migration time): every existing non-refund becomes LEGACY whether its category is a
-- token or null, because historical intent cannot be reconstructed; every existing refund becomes
-- INHERITED and keeps following its source. No existing category, version, or updated_at changes.
--
-- Normalized provider categorization evidence on staged deltas and observations:
-- - provider_merchant_identity_digest: hex SHA-256 of the provider-stable merchant identity bound
--   to the provider/environment scope, mirroring the transaction/account digest policy. Raw
--   provider merchant identifiers are never persisted.
-- - merchant_display_name: bounded untrusted private display text distinct from the statement
--   description.
-- - pfc_primary_code / pfc_detail_code: bounded provider personal-finance category codes.
-- - categorization_evidence_fingerprint: separate deterministic digest over the merchant identity
--   digest plus the two category codes. The M3 providerRevision stays the exact money/date/state
--   revision, so a category/name-only provider update never reopens bank reconciliation or marks
--   an admitted entry modified.

ALTER TABLE financial_transactions
  ADD COLUMN category_origin VARCHAR(16),
  ADD COLUMN category_assigned_at TIMESTAMPTZ,
  ADD COLUMN categorization_ruleset_version VARCHAR(32),
  ADD COLUMN category_rule_id UUID,
  ADD COLUMN categorization_evidence_fingerprint VARCHAR(64);

UPDATE financial_transactions
SET category_origin = CASE WHEN kind = 'REFUND' THEN 'INHERITED' ELSE 'LEGACY' END,
    category_assigned_at = CURRENT_TIMESTAMP;

ALTER TABLE financial_transactions
  ALTER COLUMN category_origin SET NOT NULL,
  ALTER COLUMN category_assigned_at SET NOT NULL;

ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_category_origin_check
    CHECK (category_origin IN
      ('NONE', 'LEGACY', 'USER', 'OWNER_RULE', 'PROVIDER', 'INHERITED')),
  ADD CONSTRAINT financial_transactions_category_origin_coherence_check CHECK (
    -- NONE means no effective category; a present category always carries a explaining origin.
    (category_origin <> 'NONE' OR category IS NULL)
    -- Refunds never classify independently: INHERITED applies exactly to refunds.
    AND (kind = 'REFUND') = (category_origin = 'INHERITED')
    -- Owner-rule assignments require the retained rule reference, a category, and a ruleset;
    -- every other origin stores no rule reference (Slice A never writes OWNER_RULE).
    AND (category_origin <> 'OWNER_RULE'
         OR (category IS NOT NULL AND category_rule_id IS NOT NULL
             AND categorization_ruleset_version IS NOT NULL))
    AND (category_rule_id IS NULL OR category_origin = 'OWNER_RULE')
    -- Ruleset version participates only in rule/provider assignments.
    AND (categorization_ruleset_version IS NULL
         OR category_origin IN ('OWNER_RULE', 'PROVIDER'))
    -- Provider assignments are always concrete mapped tokens under a version.
    AND (category_origin <> 'PROVIDER'
         OR (category IS NOT NULL AND categorization_ruleset_version IS NOT NULL))),
  ADD CONSTRAINT financial_transactions_category_ruleset_version_check CHECK (
    categorization_ruleset_version IS NULL
    OR char_length(categorization_ruleset_version) BETWEEN 1 AND 32),
  ADD CONSTRAINT financial_transactions_category_evidence_fingerprint_check CHECK (
    categorization_evidence_fingerprint IS NULL
    OR categorization_evidence_fingerprint ~ '^[0-9a-f]{64}$');

ALTER TABLE connection_sync_round_deltas
  ADD COLUMN provider_merchant_identity_digest VARCHAR(64),
  ADD COLUMN merchant_display_name VARCHAR(200),
  ADD COLUMN pfc_primary_code VARCHAR(100),
  ADD COLUMN pfc_detail_code VARCHAR(200),
  ADD COLUMN categorization_evidence_fingerprint VARCHAR(64);

ALTER TABLE connection_sync_round_deltas
  ADD CONSTRAINT connection_sync_round_deltas_merchant_digest_check CHECK (
    provider_merchant_identity_digest IS NULL
    OR provider_merchant_identity_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT connection_sync_round_deltas_evidence_fingerprint_check CHECK (
    categorization_evidence_fingerprint IS NULL
    OR categorization_evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT connection_sync_round_deltas_pfc_code_check CHECK (
    (pfc_primary_code IS NULL OR pfc_primary_code ~ '^[A-Z0-9_]{1,100}$')
    AND (pfc_detail_code IS NULL OR pfc_detail_code ~ '^[A-Z0-9_]{1,200}$')),
  -- A detail code without its primary is unsafe evidence and never stored.
  ADD CONSTRAINT connection_sync_round_deltas_pfc_pairing_check CHECK (
    pfc_detail_code IS NULL OR pfc_primary_code IS NOT NULL);

ALTER TABLE connection_observations
  ADD COLUMN provider_merchant_identity_digest VARCHAR(64),
  ADD COLUMN merchant_display_name VARCHAR(200),
  ADD COLUMN pfc_primary_code VARCHAR(100),
  ADD COLUMN pfc_detail_code VARCHAR(200),
  ADD COLUMN categorization_evidence_fingerprint VARCHAR(64);

ALTER TABLE connection_observations
  ADD CONSTRAINT connection_observations_merchant_digest_check CHECK (
    provider_merchant_identity_digest IS NULL
    OR provider_merchant_identity_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT connection_observations_evidence_fingerprint_check CHECK (
    categorization_evidence_fingerprint IS NULL
    OR categorization_evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT connection_observations_pfc_code_check CHECK (
    (pfc_primary_code IS NULL OR pfc_primary_code ~ '^[A-Z0-9_]{1,100}$')
    AND (pfc_detail_code IS NULL OR pfc_detail_code ~ '^[A-Z0-9_]{1,200}$')),
  ADD CONSTRAINT connection_observations_pfc_pairing_check CHECK (
    pfc_detail_code IS NULL OR pfc_primary_code IS NOT NULL);
