CREATE TABLE recurring_plans (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  label VARCHAR(400) NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('BILL','SUBSCRIPTION','RECURRING_EXPENSE')),
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('BRL','USD','EUR','GBP','CAD','JPY','KWD')),
  match_description VARCHAR(800) NOT NULL,
  merchant_key CHAR(64) NOT NULL CHECK (merchant_key ~ '^[0-9a-f]{64}$'),
  cadence VARCHAR(12) NOT NULL CHECK (cadence IN ('WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
  anchor_on DATE NOT NULL CHECK (anchor_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-30'),
  calendar_anchor VARCHAR(12),
  expected_amount NUMERIC(15,3),
  status VARCHAR(8) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
  CONSTRAINT recurring_label CHECK (char_length(btrim(label)) BETWEEN 1 AND 100 AND label = btrim(label)),
  CONSTRAINT recurring_match_description CHECK (char_length(btrim(match_description)) BETWEEN 1 AND 200 AND match_description = btrim(match_description)),
  CONSTRAINT recurring_anchor CHECK ((cadence IN ('WEEKLY','BIWEEKLY') AND calendar_anchor IS NULL) OR
    (cadence IN ('MONTHLY','QUARTERLY','ANNUAL') AND calendar_anchor IN ('DAY_OF_MONTH','END_OF_MONTH') AND
      (calendar_anchor <> 'END_OF_MONTH' OR anchor_on = (date_trunc('month',anchor_on)::date + INTERVAL '1 month - 1 day')::date))),
  CONSTRAINT recurring_expected_amount CHECK (expected_amount IS NULL OR
    (expected_amount > 0 AND expected_amount < 1000000000000 AND
      (CASE currency WHEN 'JPY' THEN expected_amount = round(expected_amount,0)
        WHEN 'KWD' THEN expected_amount = round(expected_amount,3)
        ELSE expected_amount = round(expected_amount,2) END)))
);
CREATE UNIQUE INDEX recurring_active_match ON recurring_plans(household_id,currency,merchant_key) WHERE status='ACTIVE';
CREATE INDEX recurring_history ON recurring_plans(household_id,currency,created_at DESC,id DESC);

CREATE TABLE recurring_review_preferences (
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('BRL','USD','EUR','GBP','CAD','JPY','KWD')),
  merchant_key CHAR(64) NOT NULL CHECK (merchant_key ~ '^[0-9a-f]{64}$'),
  status VARCHAR(9) NOT NULL CHECK (status IN ('OPEN','DISMISSED')),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(household_id,actor_user_id,currency,merchant_key)
);
CREATE INDEX recurring_review_eviction ON recurring_review_preferences(household_id,actor_user_id,updated_at,merchant_key);

CREATE TABLE recurring_plan_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL CHECK (operation='RECURRING_PLAN_CREATE'),
  idempotency_key UUID NOT NULL,
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  plan_id UUID NOT NULL REFERENCES recurring_plans(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(actor_user_id,household_id,operation,idempotency_key)
);
