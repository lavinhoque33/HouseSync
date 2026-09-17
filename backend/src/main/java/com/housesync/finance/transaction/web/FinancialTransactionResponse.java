package com.housesync.finance.transaction.web;

import java.time.Instant;
import java.util.UUID;

/** Exact documented DTO; money is a plain decimal string with the currency's scale. */
public record FinancialTransactionResponse(
    UUID id,
    UUID householdId,
    UUID ownerUserId,
    UUID accountId,
    String kind,
    MoneyResponse money,
    String occurredOn,
    String description,
    String visibility,
    String source,
    String status,
    UUID refundOfTransactionId,
    int version,
    Instant createdAt,
    Instant updatedAt) {

  /** Exact money boundary: plain decimal amount string plus uppercase currency code. */
  public record MoneyResponse(String amount, String currency) {}
}
