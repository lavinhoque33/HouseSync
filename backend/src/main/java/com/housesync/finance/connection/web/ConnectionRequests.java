package com.housesync.finance.connection.web;

import com.fasterxml.jackson.annotation.JsonSetter;
import java.util.List;
import java.util.UUID;

public final class ConnectionRequests {

  private ConnectionRequests() {}

  /** Empty POST body marker; unknown fields are rejected before the handler runs. */
  public record StartLinkRequest() {}

  /** Tracks presence so an explicit null public token differs from an omitted one. */
  public static final class CompleteLinkRequest {
    private String publicToken;
    private boolean publicTokenPresent;

    @JsonSetter("publicToken")
    public void setPublicToken(String publicToken) {
      this.publicTokenPresent = true;
      this.publicToken = publicToken;
    }

    public String publicToken() {
      return publicToken;
    }

    public boolean publicTokenPresent() {
      return publicTokenPresent;
    }
  }

  /** Tracks presence so explicit null cannot be mistaken for an omitted version. */
  public static final class ExpectedVersionRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }
  }

  /** Account selection: expected version plus the explicit local mapping-ID set. */
  public static final class AccountSelectionRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private List<UUID> accountMappingIds;
    private boolean accountMappingIdsPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("accountMappingIds")
    public void setAccountMappingIds(List<UUID> accountMappingIds) {
      this.accountMappingIdsPresent = true;
      this.accountMappingIds = accountMappingIds;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public List<UUID> accountMappingIds() {
      return accountMappingIds;
    }

    public boolean accountMappingIdsPresent() {
      return accountMappingIdsPresent;
    }
  }
}
