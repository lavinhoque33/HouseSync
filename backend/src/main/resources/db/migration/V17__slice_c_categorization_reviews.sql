-- Owner-private, retained review history. Neither review creation nor supersession changes ledger versions.
CREATE TABLE categorization_reviews (
 id UUID PRIMARY KEY,
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
 owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 transaction_id UUID NOT NULL,
 suggested_category VARCHAR(24) NOT NULL,
 source VARCHAR(16) NOT NULL,
 confidence VARCHAR(8) NOT NULL,
 reason_code VARCHAR(32) NOT NULL,
 policy_version VARCHAR(32) NOT NULL,
 evidence_fingerprint VARCHAR(64) NOT NULL,
 evaluated_transaction_version INTEGER NOT NULL,
 status VARCHAR(16) NOT NULL,
 version INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 CONSTRAINT categorization_reviews_transaction_fk FOREIGN KEY (transaction_id, household_id, owner_user_id)
   REFERENCES financial_transactions(id, household_id, owner_user_id),
 CONSTRAINT categorization_reviews_category_check CHECK (suggested_category IN (
 'HOUSING','GROCERIES','DINING','UTILITIES','TRANSPORTATION','SHOPPING',
 'ENTERTAINMENT','HEALTHCARE','TRAVEL','EDUCATION','PERSONAL',
 'HOUSEHOLD_SUPPLIES','SUBSCRIPTIONS','INCOME','TRANSFERS','MISCELLANEOUS')),
 CONSTRAINT categorization_reviews_source_check CHECK (source IN ('HEURISTIC','AI')),
 CONSTRAINT categorization_reviews_confidence_check CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
 CONSTRAINT categorization_reviews_status_check CHECK (status IN ('OPEN','ACCEPTED','CHOSEN','KEPT','SUPERSEDED')),
 CONSTRAINT categorization_reviews_reason_check CHECK (reason_code ~ '^[A-Z_]{1,32}$'),
 CONSTRAINT categorization_reviews_policy_check CHECK (char_length(policy_version) BETWEEN 1 AND 32),
 CONSTRAINT categorization_reviews_evidence_check CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 CONSTRAINT categorization_reviews_versions_check CHECK (version >= 0 AND evaluated_transaction_version >= 0),
 CONSTRAINT categorization_reviews_time_check CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX categorization_reviews_one_open ON categorization_reviews(transaction_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX categorization_reviews_evidence_unique ON categorization_reviews(transaction_id, evidence_fingerprint, source, policy_version);
CREATE INDEX categorization_reviews_owner_page ON categorization_reviews(household_id, owner_user_id, created_at DESC, id DESC);
CREATE INDEX categorization_reviews_owner_open ON categorization_reviews(household_id, owner_user_id) WHERE status = 'OPEN';
CREATE TABLE categorization_review_idempotency_keys (
 actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
 idempotency_key UUID NOT NULL,
 request_fingerprint VARCHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
 review_id UUID NOT NULL REFERENCES categorization_reviews(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(actor_user_id, household_id, idempotency_key)
);
