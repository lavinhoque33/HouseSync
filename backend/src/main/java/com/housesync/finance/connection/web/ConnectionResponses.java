package com.housesync.finance.connection.web;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class ConnectionResponses {

  private ConnectionResponses() {}

  /**
   * Link attempt with the ephemeral browser token. The {@code provider} field tells the web client
   * whether the browser contract is Plaid Link; no production fake browser contract exists. Link
   * tokens are never persisted in plaintext and never logged.
   */
  public record LinkAttemptResponse(
      UUID id,
      String flow,
      String provider,
      UUID connectionId,
      String linkToken,
      Instant expiresAt) {}

  /** Durable operation behind the polling GET; {@code statusUrl} is the poll target. */
  public record ConnectionOperationResponse(
      UUID id,
      String operationType,
      String state,
      UUID connectionId,
      String errorCode,
      String statusUrl,
      Instant createdAt,
      Instant updatedAt) {}

  /** Owner-scoped connection; never carries credentials or provider identities. */
  public record FinancialConnectionResponse(
      UUID id,
      UUID householdId,
      String provider,
      String environment,
      String state,
      long generation,
      int version,
      Instant lastSuccessfulSyncAt,
      Instant createdAt,
      Instant updatedAt) {}

  public record FinancialConnectionListResponse(
      List<FinancialConnectionResponse> items, int limit, int offset, boolean hasMore) {}

  /** Discovered mapping behind a local ID; the browser selects local IDs only. */
  public record ConnectionAccountMappingResponse(
      UUID mappingId,
      UUID localAccountId,
      String name,
      String kind,
      String currency,
      boolean selected,
      boolean eligible,
      String exclusionReason) {}

  public record ConnectionAccountMappingListResponse(
      List<ConnectionAccountMappingResponse> items, int limit, int offset, boolean hasMore) {}

  /** Selection outcome with the admitted private CONNECTED accounts. */
  public record AccountSelectionResponse(
      UUID connectionId, int version, List<AccountSelectionItem> accounts) {}

  public record AccountSelectionItem(
      UUID id,
      String name,
      String kind,
      String currency,
      String source,
      String status,
      int version) {}
}
