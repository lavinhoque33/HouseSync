package com.housesync.finance.activity.web;

import com.fasterxml.jackson.annotation.JsonSetter;

public final class BankActivityRequests {

  private BankActivityRequests() {}

  /**
   * Confirm request with presence tracking for the optional/omittable fields. Strict unknown-field
   * handling on the shared mapper rejects client-supplied {@code accountId}, {@code money}, {@code
   * occurredOn}, {@code owner}, {@code source}, and {@code visibility}: every one of those derives
   * from the current observation. Duplicate keys are rejected globally as malformed input.
   */
  public static final class ConfirmBankActivityRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private String kind;
    private boolean kindPresent;
    private String description;
    private boolean descriptionPresent;
    private String category;
    private boolean categoryPresent;
    private String refundOfTransactionId;
    private boolean refundOfTransactionIdPresent;
    private Boolean acknowledgeDisclosure;
    private boolean acknowledgeDisclosurePresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("kind")
    public void setKind(String kind) {
      this.kindPresent = true;
      this.kind = kind;
    }

    @JsonSetter("description")
    public void setDescription(String description) {
      this.descriptionPresent = true;
      this.description = description;
    }

    @JsonSetter("category")
    public void setCategory(String category) {
      this.categoryPresent = true;
      this.category = category;
    }

    @JsonSetter("refundOfTransactionId")
    public void setRefundOfTransactionId(String refundOfTransactionId) {
      this.refundOfTransactionIdPresent = true;
      this.refundOfTransactionId = refundOfTransactionId;
    }

    @JsonSetter("acknowledgeDisclosure")
    public void setAcknowledgeDisclosure(Boolean acknowledgeDisclosure) {
      this.acknowledgeDisclosurePresent = true;
      this.acknowledgeDisclosure = acknowledgeDisclosure;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public String kind() {
      return kind;
    }

    public boolean kindPresent() {
      return kindPresent;
    }

    public String description() {
      return description;
    }

    public boolean descriptionPresent() {
      return descriptionPresent;
    }

    public String category() {
      return category;
    }

    public boolean categoryPresent() {
      return categoryPresent;
    }

    public String refundOfTransactionId() {
      return refundOfTransactionId;
    }

    public boolean refundOfTransactionIdPresent() {
      return refundOfTransactionIdPresent;
    }

    public Boolean acknowledgeDisclosure() {
      return acknowledgeDisclosure;
    }

    public boolean acknowledgeDisclosurePresent() {
      return acknowledgeDisclosurePresent;
    }
  }

  /** Dismiss request: current observation version plus a closed safe reason token. */
  public static final class DismissBankActivityRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private String reason;
    private boolean reasonPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("reason")
    public void setReason(String reason) {
      this.reasonPresent = true;
      this.reason = reason;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public String reason() {
      return reason;
    }

    public boolean reasonPresent() {
      return reasonPresent;
    }
  }
}
