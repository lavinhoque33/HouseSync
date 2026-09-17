package com.housesync.finance.report.domain;

import java.time.DateTimeException;
import java.time.ZoneId;

/**
 * Reporting-zone boundary (ADR 0006; manual-finance API).
 *
 * <p>A zone is accepted only when it is an IANA region name in the JVM zone-ID set, which in
 * practice means the ID contains a {@code '/'} separator: this admits region zones such as {@code
 * America/New_York} and the documented initial zone {@code Etc/UTC} while rejecting bare offsets
 * ({@code +02:00}, {@code Z}, {@code UTC}) and short aliases ({@code EST}). Matching is exact and
 * case-sensitive; the stored string is the validated input itself, never a normalized variant.
 * Financial data must not appear in diagnostic logs, so violations carry only a safe message.
 */
public final class ReportingTimeZonePolicy {

  /** Stored zone text is bounded like the database check. */
  static final int MAX_LENGTH = 64;

  private ReportingTimeZonePolicy() {}

  /**
   * Records a safe {@code reportingTimeZone} violation message when the raw value is not an
   * accepted region zone, or returns {@code null} when it is accepted.
   */
  public static String violation(String rawZone) {
    if (rawZone == null || rawZone.isEmpty() || rawZone.length() > MAX_LENGTH) {
      return "Choose a supported reporting time zone.";
    }
    if (!rawZone.contains("/")) {
      // Bare offsets, UTC itself, and short aliases never carry a region separator.
      return "Choose a supported reporting time zone.";
    }
    ZoneId parsed;
    try {
      parsed = ZoneId.of(rawZone);
    } catch (DateTimeException rejected) {
      return "Choose a supported reporting time zone.";
    }
    if (!ZoneId.getAvailableZoneIds().contains(rawZone) || !parsed.getId().equals(rawZone)) {
      // ZoneId.of also resolves offset-style and legacy spellings that are not IANA region
      // names; only the exact canonical region ID is stored.
      return "Choose a supported reporting time zone.";
    }
    return null;
  }
}
