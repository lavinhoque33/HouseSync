-- M2 slice E: household reporting settings for the dashboard slice.
--
-- Each household owns one reporting time zone plus an optimistic version for
-- owner-only updates. Existing rows keep working unchanged: both columns are
-- added NOT NULL with the documented initial values, so V1-V9 households and
-- finance data upgrade intact and read back as Etc/UTC at version 0. The zone
-- itself is validated in the application against the JVM IANA region set
-- (which must contain a '/' separator, so bare offsets and short aliases are
-- rejected); the database only bounds the stored text. The version mirrors
-- the finance version convention: nonnegative, bounded by 2147483647, bumped
-- once per state-changing update with no-op and exhaustion semantics in the
-- application. Creation support sets the same initial values for new
-- households, and the column defaults keep direct writes consistent.
--
-- Purely additive: no prior table, constraint, index, or finance row is
-- touched, so V9-to-V10 upgrades preserve accounts, transactions, categories,
-- visibility, allocations, and idempotency keys.

ALTER TABLE households
  ADD COLUMN reporting_time_zone VARCHAR(64) NOT NULL DEFAULT 'Etc/UTC',
  ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE households
  ADD CONSTRAINT households_reporting_time_zone_check
    CHECK (char_length(reporting_time_zone) BETWEEN 1 AND 64),
  ADD CONSTRAINT households_version_check
    CHECK (version BETWEEN 0 AND 2147483647);
