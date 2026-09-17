package com.housesync.finance.transaction.web;

import com.fasterxml.jackson.annotation.JsonSetter;

public final class FinancialTransactionRequests {

  private FinancialTransactionRequests() {}

  /** Money arrives as exact decimal strings; wrong scalar types fail global coercion rules. */
  public record MoneyRequest(String amount, String currency) {}

  public static final class CreateFinancialTransactionRequest {
    private String accountId;
    private String kind;
    private MoneyRequest money;
    private String occurredOn;
    private String description;
    private String visibility;
    private boolean visibilityPresent;
    private String refundOfTransactionId;
    private boolean refundOfTransactionIdPresent;

    @JsonSetter("accountId")
    public void setAccountId(String accountId) {
      this.accountId = accountId;
    }

    @JsonSetter("kind")
    public void setKind(String kind) {
      this.kind = kind;
    }

    @JsonSetter("money")
    public void setMoney(MoneyRequest money) {
      this.money = money;
    }

    @JsonSetter("occurredOn")
    public void setOccurredOn(String occurredOn) {
      this.occurredOn = occurredOn;
    }

    @JsonSetter("description")
    public void setDescription(String description) {
      this.description = description;
    }

    @JsonSetter("visibility")
    public void setVisibility(String visibility) {
      this.visibilityPresent = true;
      this.visibility = visibility;
    }

    @JsonSetter("refundOfTransactionId")
    public void setRefundOfTransactionId(String refundOfTransactionId) {
      this.refundOfTransactionIdPresent = true;
      this.refundOfTransactionId = refundOfTransactionId;
    }

    public String accountId() {
      return accountId;
    }

    public String kind() {
      return kind;
    }

    public MoneyRequest money() {
      return money;
    }

    public String occurredOn() {
      return occurredOn;
    }

    public String description() {
      return description;
    }

    public String visibility() {
      return visibility;
    }

    public boolean visibilityPresent() {
      return visibilityPresent;
    }

    public String refundOfTransactionId() {
      return refundOfTransactionId;
    }

    public boolean refundOfTransactionIdPresent() {
      return refundOfTransactionIdPresent;
    }
  }

  /** Tracks field presence so explicit null cannot be mistaken for an omitted patch field. */
  public static final class UpdateFinancialTransactionRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private MoneyPatch money;
    private boolean moneyPresent;
    private String occurredOn;
    private boolean occurredOnPresent;
    private String description;
    private boolean descriptionPresent;
    private String visibility;
    private boolean visibilityPresent;
    private String status;
    private boolean statusPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("money")
    public void setMoney(MoneyPatch money) {
      this.moneyPresent = true;
      this.money = money;
    }

    @JsonSetter("occurredOn")
    public void setOccurredOn(String occurredOn) {
      this.occurredOnPresent = true;
      this.occurredOn = occurredOn;
    }

    @JsonSetter("description")
    public void setDescription(String description) {
      this.descriptionPresent = true;
      this.description = description;
    }

    @JsonSetter("visibility")
    public void setVisibility(String visibility) {
      this.visibilityPresent = true;
      this.visibility = visibility;
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

    public MoneyPatch money() {
      return money;
    }

    public boolean moneyPresent() {
      return moneyPresent;
    }

    public String occurredOn() {
      return occurredOn;
    }

    public boolean occurredOnPresent() {
      return occurredOnPresent;
    }

    public String description() {
      return description;
    }

    public boolean descriptionPresent() {
      return descriptionPresent;
    }

    public String visibility() {
      return visibility;
    }

    public boolean visibilityPresent() {
      return visibilityPresent;
    }

    public String status() {
      return status;
    }

    public boolean statusPresent() {
      return statusPresent;
    }
  }

  /** Partial money objects are invalid; nested presence distinguishes omission from null. */
  public static final class MoneyPatch {
    private String amount;
    private boolean amountPresent;
    private String currency;
    private boolean currencyPresent;

    @JsonSetter("amount")
    public void setAmount(String amount) {
      this.amountPresent = true;
      this.amount = amount;
    }

    @JsonSetter("currency")
    public void setCurrency(String currency) {
      this.currencyPresent = true;
      this.currency = currency;
    }

    public String amount() {
      return amount;
    }

    public boolean amountPresent() {
      return amountPresent;
    }

    public String currency() {
      return currency;
    }

    public boolean currencyPresent() {
      return currencyPresent;
    }
  }
}
