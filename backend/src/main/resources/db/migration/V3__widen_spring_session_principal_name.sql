-- M1 follow-up: Spring Session stores the canonical login email as the session
-- principal name, and EmailPolicy allows up to 254 ASCII characters. The
-- official schema adopted in V2 declares SPRING_SESSION.PRINCIPAL_NAME as
-- VARCHAR(100), so a valid long email could register yet fail when the
-- login session is saved. Widen the column to the full identifier length.
-- Forward-only fix; V1 and V2 stay immutable.

ALTER TABLE spring_session ALTER COLUMN principal_name TYPE VARCHAR(254);
