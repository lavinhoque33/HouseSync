-- M1 identity slice: application users.
--
-- Email is stored in canonical form (trimmed, lowercased with a
-- locale-independent policy, ASCII only, at most 254 characters) and must be
-- unique so concurrent registrations cannot create duplicates. Passwords are
-- never stored in clear text; password_hash holds the Spring delegating
-- encoder output (for example "{bcrypt}$2a$12$...") and is never returned
-- through the API.

CREATE TABLE users (
  id UUID NOT NULL PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 1 AND 254)
);

CREATE UNIQUE INDEX users_email_unique ON users (email);
