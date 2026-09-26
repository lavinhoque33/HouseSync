CREATE TABLE budget_targets (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  month CHAR(7) NOT NULL CHECK (month ~ '^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])$' AND month <= '9999-11'),
  bucket VARCHAR(32) NOT NULL CHECK (bucket IN ('OVERALL','UNCATEGORIZED','HOUSING','GROCERIES','DINING','UTILITIES','TRANSPORTATION','SHOPPING','ENTERTAINMENT','HEALTHCARE','TRAVEL','EDUCATION','PERSONAL','HOUSEHOLD_SUPPLIES','SUBSCRIPTIONS','INCOME','TRANSFERS','MISCELLANEOUS')),
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('BRL','USD','EUR','GBP','CAD','JPY','KWD')),
  amount NUMERIC(15,3) NOT NULL,
  status VARCHAR(8) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
  CONSTRAINT budget_amount CHECK (amount >= 0 AND amount < 1000000000000 AND
    CASE currency WHEN 'JPY' THEN amount = round(amount,0)
      WHEN 'KWD' THEN amount = round(amount,3)
      ELSE amount = round(amount,2) END)
);
CREATE UNIQUE INDEX budget_target_active_bucket ON budget_targets(household_id,month,currency,bucket) WHERE status='ACTIVE';
CREATE INDEX budget_target_history ON budget_targets(household_id,month,currency,bucket COLLATE "C",created_at DESC,id DESC);

CREATE TABLE budget_target_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL CHECK (operation='BUDGET_TARGET_CREATE'),
  idempotency_key UUID NOT NULL,
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  target_id UUID NOT NULL REFERENCES budget_targets(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(actor_user_id,household_id,operation,idempotency_key)
);
