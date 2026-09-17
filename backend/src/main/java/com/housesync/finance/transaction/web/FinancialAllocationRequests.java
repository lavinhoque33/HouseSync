package com.housesync.finance.transaction.web;

import com.fasterxml.jackson.annotation.JsonSetter;
import java.util.List;

public final class FinancialAllocationRequests {

  private FinancialAllocationRequests() {}

  /**
   * Create body: exactly {@code expectedVersion} plus {@code participantUserIds}. Presence flags
   * separate omission from explicit null so both answer the same safe field error.
   */
  public static final class CreateAllocationRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private List<String> participantUserIds;
    private boolean participantUserIdsPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("participantUserIds")
    public void setParticipantUserIds(List<String> participantUserIds) {
      this.participantUserIdsPresent = true;
      this.participantUserIds = participantUserIds;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public List<String> participantUserIds() {
      return participantUserIds;
    }

    public boolean participantUserIdsPresent() {
      return participantUserIdsPresent;
    }
  }

  /** Revoke body: exactly {@code expectedVersion} plus {@code status: "REVOKED"}. */
  public static final class RevokeAllocationRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private String status;
    private boolean statusPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("status")
    public void setStatus(String status) {
      this.statusPresent = true;
      this.status = status;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public String status() {
      return status;
    }

    public boolean statusPresent() {
      return statusPresent;
    }
  }
}
