package com.housesync.finance.transaction.web;

import com.fasterxml.jackson.annotation.JsonSetter;
import java.util.List;

public final class FinancialAllocationRequests {

  private FinancialAllocationRequests() {}

  /**
   * Create or preview body: {@code expectedVersion} plus exactly one of {@code participantUserIds}
   * (EQUAL) or {@code participantShares} (EXACT). Presence flags separate omission from explicit
   * null so both answer safe field errors.
   */
  public static final class CreateAllocationRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private List<String> participantUserIds;
    private boolean participantUserIdsPresent;
    private List<ExactShareRequest> participantShares;
    private boolean participantSharesPresent;

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

    @JsonSetter("participantShares")
    public void setParticipantShares(List<ExactShareRequest> participantShares) {
      this.participantSharesPresent = true;
      this.participantShares = participantShares;
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

    public List<ExactShareRequest> participantShares() {
      return participantShares;
    }

    public boolean participantSharesPresent() {
      return participantSharesPresent;
    }
  }

  public record ExactShareRequest(String userId, MoneyRequest share) {}

  public record MoneyRequest(String amount, String currency) {}

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
