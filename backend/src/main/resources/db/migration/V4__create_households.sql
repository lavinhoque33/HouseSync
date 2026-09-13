-- M1 household slice: households and membership.
--
-- A household has an opaque UUID, a non-unique display name, and a
-- server-generated creation instant. Duplicate names are valid; each row is a
-- distinct household. Name checks mirror the application policy
-- (HouseholdNamePolicy): stored names are non-null, already outer-trimmed,
-- nonempty, 1-100 characters long, and free of control characters.
-- Application validation additionally provides useful errors.
--
-- "Trimmed" covers more than ASCII spaces: the boundary set below matches
-- Java whitespace plus Unicode space separators, so visually blank names made
-- of no-break space (U+00A0), figure space (U+2007), narrow no-break space
-- (U+202F), or other separators are rejected, and padded values are rejected
-- too. Non-ASCII members are built with chr(codepoint) so this file stays
-- plain ASCII with no invisible literals:
--   E-string part: U+0020 space and ASCII whitespace controls
--     U+0009-U+000D, U+001C-U+001F (tab, LF, VT, FF, CR, FS/GS/RS/US), space
--   chr(133):   U+0085 NEL
--   chr(160):   U+00A0 no-break space
--   chr(5760):  U+1680 Ogham space mark
--   chr(8192)-chr(8202): U+2000-U+200A (en/em/thin/hair spaces and friends,
--     including U+2007 figure space)
--   chr(8232)/chr(8233): U+2028/U+2029 line/paragraph separators
--   chr(8239):  U+202F narrow no-break space
--   chr(8287):  U+205F medium mathematical space
--   chr(12288): U+3000 ideographic space
-- The control class rejects C0 controls (NUL cannot reach PostgreSQL text at
-- all), DEL, and the C1 range U+0080-U+009F (chr(128)-chr(159), spelled as a
-- dynamically built range for the same plain-ASCII reason).
--
-- Membership is identified by (household_id, user_id) with a stable role of
-- OWNER or MEMBER. The first slice creates only OWNER rows; MEMBER is
-- reserved for the invitation/join slice. Authorization always uses these
-- rows, never names or creator provenance, so there is deliberately no
-- created_by authorization source. Foreign keys stay restrictive until the
-- deletion lifecycle and retention are designed. The actor index supports
-- membership-scoped collection reads.

CREATE TABLE households (
  id UUID NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT households_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT households_name_trimmed CHECK (
    name
      = btrim(
        name,
        E' \t\n\x0B\f\r\x1C\x1D\x1E\x1F\x20'
          || chr(133)
          || chr(160)
          || chr(5760)
          || chr(8192)
          || chr(8193)
          || chr(8194)
          || chr(8195)
          || chr(8196)
          || chr(8197)
          || chr(8198)
          || chr(8199)
          || chr(8200)
          || chr(8201)
          || chr(8202)
          || chr(8232)
          || chr(8233)
          || chr(8239)
          || chr(8287)
          || chr(12288))),
  CONSTRAINT households_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT households_name_no_controls CHECK (
    name !~ E'[\x01-\x1F\x7F]'
    AND name !~ ('[' || chr(128) || '-' || chr(159) || ']'))
);

CREATE TABLE household_members (
  household_id UUID NOT NULL REFERENCES households (id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role VARCHAR(16) NOT NULL,
  CONSTRAINT household_members_pk PRIMARY KEY (household_id, user_id),
  CONSTRAINT household_members_role_check CHECK (role IN ('OWNER', 'MEMBER'))
);

CREATE INDEX household_members_actor_idx ON household_members (user_id);
