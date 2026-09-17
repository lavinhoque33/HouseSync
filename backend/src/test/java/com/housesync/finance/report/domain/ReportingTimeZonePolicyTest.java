package com.housesync.finance.report.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Reporting-zone boundary: the JVM IANA region set admits documented region zones including {@code
 * Etc/UTC} and rejects bare offsets, short aliases, and malformed values without echoing them.
 */
class ReportingTimeZonePolicyTest {

  @ParameterizedTest
  @ValueSource(strings = {"Etc/UTC", "America/New_York", "Europe/Berlin", "Pacific/Auckland"})
  void acceptedRegionZonesCarryNoViolation(String zone) {
    assertThat(ReportingTimeZonePolicy.violation(zone)).isNull();
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "EST",
        "MST",
        "HST",
        "UTC",
        "Z",
        "+02:00",
        "-05:00",
        "GMT",
        "GMT+2",
        "etc/utc",
        "ETC/UTC",
        "America/Nope",
        "",
        " ",
        "America/New_York ",
        " America/New_York"
      })
  void rejectedZonesCarryASafeViolation(String zone) {
    assertThat(ReportingTimeZonePolicy.violation(zone))
        .isEqualTo("Choose a supported reporting time zone.");
  }

  @Test
  void nullAndOverlongZonesAreRejected() {
    assertThat(ReportingTimeZonePolicy.violation(null))
        .isEqualTo("Choose a supported reporting time zone.");
    assertThat(ReportingTimeZonePolicy.violation("America/" + "a".repeat(60)))
        .isEqualTo("Choose a supported reporting time zone.");
  }
}
