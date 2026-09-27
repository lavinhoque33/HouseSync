-- Operator-issued bearer grants: only SHA-256 digests are persisted, never bearer secrets.
CREATE TABLE identity_grants (
  id UUID PRIMARY KEY,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('ENROLLMENT', 'RECOVERY')),
  recipient_email VARCHAR(254) NOT NULL,
  user_id UUID REFERENCES users(id),
  token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > issued_at),
  CHECK ((kind = 'ENROLLMENT' AND user_id IS NULL) OR (kind = 'RECOVERY' AND user_id IS NOT NULL))
);
CREATE INDEX identity_grants_recipient_idx ON identity_grants (recipient_email, kind);
CREATE TABLE identity_grant_audit (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES identity_grants(id),
  action VARCHAR(16) NOT NULL CHECK (action IN ('ISSUED', 'REVOKED', 'CONSUMED')),
  occurred_at TIMESTAMPTZ NOT NULL,
  actor VARCHAR(128) NOT NULL
);
-- A 30-day absolute cap applies to existing rows using their original creation timestamp.
CREATE INDEX spring_session_absolute_expiry_idx ON SPRING_SESSION (CREATION_TIME);
