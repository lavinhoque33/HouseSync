package com.housesync.finance.report.web;

import com.fasterxml.jackson.annotation.JsonSetter;

/**
 * Finance-settings write payload. Unknown JSON fields are rejected by the global Jackson setting
 * ({@code fail-on-unknown-properties}); presence flags separate omission from explicit null so both
 * answer the same safe field error.
 */
public final class FinanceSettingsRequests {

  private FinanceSettingsRequests() {}

  /** Patch body: exactly {@code reportingTimeZone} plus {@code expectedVersion}. */
  public static final class UpdateFinanceSettingsRequest {
    private String reportingTimeZone;
    private boolean reportingTimeZonePresent;
    private Integer expectedVersion;
    private boolean expectedVersionPresent;

    @JsonSetter("reportingTimeZone")
    public void setReportingTimeZone(String reportingTimeZone) {
      this.reportingTimeZonePresent = true;
      this.reportingTimeZone = reportingTimeZone;
    }

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    public String reportingTimeZone() {
      return reportingTimeZone;
    }

    public boolean reportingTimeZonePresent() {
      return reportingTimeZonePresent;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }
  }
}
