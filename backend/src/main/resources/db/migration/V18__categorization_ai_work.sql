-- No prompts, descriptions, provider payloads or credentials are retained in work rows.
CREATE TABLE categorization_ai_work (
 id UUID PRIMARY KEY,
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
 owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 transaction_id UUID NOT NULL,
 transaction_version INTEGER NOT NULL CHECK (transaction_version >= 0),
 evidence_fingerprint VARCHAR(64) NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 policy_version VARCHAR(32) NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 32),
 state VARCHAR(16) NOT NULL CHECK (state IN ('QUEUED','RUNNING','RETRY_WAIT','FAILED','SUCCEEDED','STALE')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
 fence BIGINT NOT NULL DEFAULT 0 CHECK (fence >= 0),
 due_at TIMESTAMPTZ NOT NULL,
 lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 CONSTRAINT categorization_ai_work_transaction_fk FOREIGN KEY (transaction_id, household_id, owner_user_id)
  REFERENCES financial_transactions(id, household_id, owner_user_id),
 CONSTRAINT categorization_ai_work_unique UNIQUE(transaction_id, transaction_version, evidence_fingerprint, policy_version),
 CONSTRAINT categorization_ai_work_lease CHECK ((state = 'RUNNING') = (lease_until IS NOT NULL))
);
CREATE INDEX categorization_ai_work_due ON categorization_ai_work(due_at, id)
 WHERE state IN ('QUEUED','RUNNING','RETRY_WAIT');
CREATE INDEX categorization_ai_work_owner_status ON categorization_ai_work(household_id, owner_user_id, state);
