package com.housesync.finance.account.web;

import com.fasterxml.jackson.annotation.JsonSetter;

public final class FinancialAccountRequests {

  private FinancialAccountRequests() {}

  public record CreateFinancialAccountRequest(String name, String kind, String currency) {}

  /** Tracks field presence so explicit null cannot be mistaken for an omitted patch field. */
  public static final class UpdateFinancialAccountRequest {
    private Integer expectedVersion;
    private String name;
    private String status;
    private boolean expectedVersionPresent;
    private boolean namePresent;
    private boolean statusPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("name")
    public void setName(String name) {
      this.namePresent = true;
      this.name = name;
    }

    @JsonSetter("status")
    public void setStatus(String status) {
      this.statusPresent = true;
      this.status = status;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public String name() {
      return name;
    }

    public String status() {
      return status;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public boolean namePresent() {
      return namePresent;
    }

    public boolean statusPresent() {
      return statusPresent;
    }
  }
}
