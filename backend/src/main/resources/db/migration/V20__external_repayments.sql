-- External transfer assertions are independent of financial accounts, ledger transactions and membership rows.
CREATE TABLE external_repayments (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency VARCHAR(3) NOT NULL,
  amount NUMERIC NOT NULL,
  occurred_on DATE NOT NULL,
  status VARCHAR(16) NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  amendment_action VARCHAR(8),
  amendment_proposer UUID REFERENCES users(id) ON DELETE RESTRICT,
  amendment_amount NUMERIC,
  amendment_occurred_on DATE,
  amendment_created_at TIMESTAMPTZ,
  CONSTRAINT repayment_distinct_parties CHECK (sender_user_id <> recipient_user_id),
  CONSTRAINT repayment_currency CHECK (currency IN ('BRL','USD','EUR','GBP','CAD','JPY','KWD')),
  CONSTRAINT repayment_money CHECK (amount > 0 AND amount < 1000000000000 AND
    (CASE currency WHEN 'JPY' THEN amount = round(amount,0)
      WHEN 'KWD' THEN amount = round(amount,3) ELSE amount = round(amount,2) END)),
  CONSTRAINT repayment_date CHECK (occurred_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-30'),
  CONSTRAINT repayment_version CHECK (version >= 0),
  CONSTRAINT repayment_status CHECK (status IN ('PENDING','CONFIRMED','REJECTED','CANCELLED','VOIDED')),
  CONSTRAINT repayment_times CHECK (updated_at >= created_at AND
    (confirmed_at IS NULL OR confirmed_at >= created_at) AND
    (voided_at IS NULL OR (confirmed_at IS NOT NULL AND voided_at >= confirmed_at))),
  CONSTRAINT repayment_state CHECK ((
    (status = 'PENDING' AND version = 0 AND confirmed_at IS NULL AND voided_at IS NULL) OR
    (status IN ('REJECTED','CANCELLED') AND version = 1 AND confirmed_at IS NULL AND voided_at IS NULL) OR
    (status = 'CONFIRMED' AND version >= 1 AND confirmed_at IS NOT NULL AND voided_at IS NULL) OR
    (status = 'VOIDED' AND version >= 3 AND confirmed_at IS NOT NULL AND voided_at IS NOT NULL)) IS TRUE),
  CONSTRAINT repayment_amendment CHECK ((
    (amendment_action IS NULL AND amendment_proposer IS NULL AND amendment_amount IS NULL AND
      amendment_occurred_on IS NULL AND amendment_created_at IS NULL) OR
    (status = 'CONFIRMED' AND amendment_action = 'VOID' AND
      amendment_proposer IN (sender_user_id,recipient_user_id) AND amendment_amount IS NULL AND
      amendment_occurred_on IS NULL AND amendment_created_at IS NOT NULL) OR
    (status = 'CONFIRMED' AND amendment_action = 'REPLACE' AND
      amendment_proposer IN (sender_user_id,recipient_user_id) AND
      amendment_amount > 0 AND amendment_amount < 1000000000000 AND
      (CASE currency WHEN 'JPY' THEN amendment_amount = round(amendment_amount,0)
        WHEN 'KWD' THEN amendment_amount = round(amendment_amount,3) ELSE amendment_amount = round(amendment_amount,2) END) AND
      amendment_occurred_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-30' AND
      amendment_created_at IS NOT NULL)) IS TRUE)
);
CREATE INDEX repayment_sender_list ON external_repayments (household_id,sender_user_id,created_at DESC,id DESC);
CREATE INDEX repayment_recipient_list ON external_repayments (household_id,recipient_user_id,created_at DESC,id DESC);
CREATE INDEX repayment_confirmed_vector ON external_repayments (household_id,currency) WHERE status = 'CONFIRMED';

CREATE TABLE external_repayment_events (
  repayment_id UUID NOT NULL REFERENCES external_repayments(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 0),
  event_type VARCHAR(24) NOT NULL CHECK (event_type IN ('CREATED','CONFIRMED','REJECTED','CANCELLED',
    'AMENDMENT_PROPOSED','AMENDMENT_CONFIRMED','AMENDMENT_REJECTED','AMENDMENT_CANCELLED')),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('PENDING','CONFIRMED','REJECTED','CANCELLED','VOIDED')),
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('BRL','USD','EUR','GBP','CAD','JPY','KWD')),
  amount NUMERIC NOT NULL CHECK (amount > 0 AND amount < 1000000000000),
  occurred_on DATE NOT NULL CHECK (occurred_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-30'),
  amendment_action VARCHAR(8),
  amendment_proposer UUID REFERENCES users(id) ON DELETE RESTRICT,
  amendment_amount NUMERIC,
  amendment_occurred_on DATE,
  amendment_created_at TIMESTAMPTZ,
  PRIMARY KEY (repayment_id,version),
  CONSTRAINT repayment_event_amount_scale CHECK (CASE currency WHEN 'JPY' THEN amount = round(amount,0)
    WHEN 'KWD' THEN amount = round(amount,3) ELSE amount = round(amount,2) END),
  CONSTRAINT repayment_event_amendment CHECK ((
    (amendment_action IS NULL AND amendment_proposer IS NULL AND amendment_amount IS NULL AND
      amendment_occurred_on IS NULL AND amendment_created_at IS NULL) OR
    (amendment_action = 'VOID' AND amendment_proposer IS NOT NULL AND amendment_amount IS NULL AND
      amendment_occurred_on IS NULL AND amendment_created_at IS NOT NULL) OR
    (amendment_action = 'REPLACE' AND amendment_proposer IS NOT NULL AND amendment_amount > 0 AND
      amendment_amount < 1000000000000 AND
      (CASE currency WHEN 'JPY' THEN amendment_amount = round(amendment_amount,0)
        WHEN 'KWD' THEN amendment_amount = round(amendment_amount,3) ELSE amendment_amount = round(amendment_amount,2) END) AND
      amendment_occurred_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-30' AND
      amendment_created_at IS NOT NULL)) IS TRUE)
);

-- Append-only audit facts: correction writes a new version, never edits or deletes an old event.
CREATE FUNCTION reject_repayment_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'repayment events are immutable';
END;
$$;
CREATE TRIGGER repayment_event_immutable BEFORE UPDATE OR DELETE ON external_repayment_events
  FOR EACH ROW EXECUTE FUNCTION reject_repayment_event_mutation();

CREATE TABLE external_repayment_idempotency_keys (
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  operation VARCHAR(32) NOT NULL CHECK (operation = 'REPAYMENT_CREATE'),
  idempotency_key UUID NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  repayment_id UUID NOT NULL REFERENCES external_repayments(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_user_id,household_id,operation,idempotency_key)
);
CREATE INDEX repayment_key_resource ON external_repayment_idempotency_keys (repayment_id);
