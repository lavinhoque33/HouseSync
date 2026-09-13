-- M1 invitation slice: capability household invitations.
--
-- An invitation is an owner-mediated, single-use capability: the row carries an
-- opaque UUID plus the SHA-256 digest of 32 cryptographically random bytes. The
-- raw secret is returned once in the create response and is never persisted,
-- so owner listing and database reads cannot recover it. Email, role,
-- recipient, status enum, and delivery-provider state are deliberately absent:
-- every invitation grants MEMBER, expiry is derived from expires_at, and there
-- is no email delivery in this slice.
--
-- State is derived, never stored:
--   active:   accepted_at/revoked_at are null and now is before expires_at;
--   expired:  accepted_at/revoked_at are null and now is at or after expires_at;
--   accepted: accepted_at and accepted_by_user_id are both present;
--   revoked:  revoked_at is present.
-- Terminal rows are retained so same-actor acceptance retries resolve safely;
-- deletion and retention remain deferred, so every foreign key stays
-- restrictive. Acceptance fields must be both null or both populated, and
-- acceptance and revocation can never coexist. Expiry is exactly after
-- creation (the application sets creation + 168 hours). The partial index
-- supports the owner-scoped active list ordered by (created_at, id); the
-- application query additionally excludes expired rows.

CREATE TABLE household_invitations (
  id UUID NOT NULL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  created_by_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  secret_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT household_invitations_secret_hash_length CHECK (octet_length(secret_hash) = 32),
  CONSTRAINT household_invitations_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT household_invitations_acceptance_paired CHECK (
    (accepted_at IS NULL AND accepted_by_user_id IS NULL)
    OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)),
  CONSTRAINT household_invitations_terminal_exclusive CHECK (
    NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX household_invitations_active_list_idx
  ON household_invitations (household_id, created_at, id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
