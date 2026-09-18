package com.housesync.finance.activity.web;

import com.fasterxml.jackson.annotation.JsonSetter;
import java.util.List;

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

  /**
   * Resolve request with presence tracking. Strict unknown-field handling on the shared mapper
   * rejects client-supplied ledger facts: only the action plus, for APPLY_BANK, the subset of bank
   * facts ({@code amount}, {@code occurredOn}, {@code description}) may be named.
   */
  public static final class ResolveBankActivityRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private Integer expectedLedgerVersion;
    private boolean expectedLedgerVersionPresent;
    private String action;
    private boolean actionPresent;
    private List<String> fields;
    private boolean fieldsPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("expectedLedgerVersion")
    public void setExpectedLedgerVersion(Integer expectedLedgerVersion) {
      this.expectedLedgerVersionPresent = true;
      this.expectedLedgerVersion = expectedLedgerVersion;
    }

    @JsonSetter("action")
    public void setAction(String action) {
      this.actionPresent = true;
      this.action = action;
    }

    @JsonSetter("fields")
    public void setFields(List<String> fields) {
      this.fieldsPresent = true;
      this.fields = fields;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public Integer expectedLedgerVersion() {
      return expectedLedgerVersion;
    }

    public boolean expectedLedgerVersionPresent() {
      return expectedLedgerVersionPresent;
    }

    public String action() {
      return action;
    }

    public boolean actionPresent() {
      return actionPresent;
    }

    public List<String> fields() {
      return fields;
    }

    public boolean fieldsPresent() {
      return fieldsPresent;
    }
  }

  /**
   * Replace request with presence tracking for the optional/omittable fields. Like confirmation,
   * account, money, currency, date, source, and visibility derive from the current observation and
   * are rejected as unknown fields; kind/description/category/refund follow the owner's correction.
   */
  public static final class ReplaceBankActivityRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private Integer expectedLedgerVersion;
    private boolean expectedLedgerVersionPresent;
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
    private Boolean acknowledgeAllocationRemoval;
    private boolean acknowledgeAllocationRemovalPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("expectedLedgerVersion")
    public void setExpectedLedgerVersion(Integer expectedLedgerVersion) {
      this.expectedLedgerVersionPresent = true;
      this.expectedLedgerVersion = expectedLedgerVersion;
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

    @JsonSetter("acknowledgeAllocationRemoval")
    public void setAcknowledgeAllocationRemoval(Boolean acknowledgeAllocationRemoval) {
      this.acknowledgeAllocationRemovalPresent = true;
      this.acknowledgeAllocationRemoval = acknowledgeAllocationRemoval;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public Integer expectedLedgerVersion() {
      return expectedLedgerVersion;
    }

    public boolean expectedLedgerVersionPresent() {
      return expectedLedgerVersionPresent;
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

    public Boolean acknowledgeAllocationRemoval() {
      return acknowledgeAllocationRemoval;
    }

    public boolean acknowledgeAllocationRemovalPresent() {
      return acknowledgeAllocationRemovalPresent;
    }
  }
}
