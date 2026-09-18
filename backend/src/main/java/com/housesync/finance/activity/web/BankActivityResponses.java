package com.housesync.finance.activity.web;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class BankActivityResponses {

  private BankActivityResponses() {}

  public record MoneyResponse(String amount, String currency) {}

  /**
   * Owner-private observation projection: local HouseSync IDs, exact money text, normalized dates,
   * and private provider evidence. No provider cursor, credential, or raw identity is exposed.
   */
  public record BankActivityResponse(
      UUID id,
      UUID connectionId,
      UUID accountMappingId,
      UUID localAccountId,
      String state,
      String reviewState,
      String changeState,
      MoneyResponse money,
      String occurredOn,
      String authorizedOn,
      String providerDescription,
      boolean descriptionValid,
      UUID pendingPredecessorId,
      String invalidReason,
      String dismissedReason,
      int version,
      UUID ledgerTransactionId,
      Instant createdAt,
      Instant updatedAt) {}

  /** Owner-only counts shown beside the inbox; never part of household aggregates. */
  public record BankActivityListResponse(
      List<BankActivityResponse> items,
      int limit,
      int offset,
      boolean hasMore,
      long unreviewedCount,
      long changedCount) {}

  /** Decision outcome for both confirm and dismiss. */
  public record BankActivityDecisionResponse(
      BankActivityResponse activity, UUID transactionId, Integer transactionVersion) {}
}
