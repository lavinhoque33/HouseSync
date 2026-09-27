-- Preserve household/account history while removing pilot access permanently.
ALTER TABLE users ADD COLUMN access_disabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE identity_account_audit (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(16) NOT NULL CHECK (action = 'DISABLED'),
  occurred_at TIMESTAMPTZ NOT NULL,
  actor VARCHAR(128) NOT NULL
);
