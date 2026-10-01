package com.housesync.finance.transaction.web;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Exact documented allocation DTO (ADR 0007): frozen ordered participant shares that sum exactly to
 * the original magnitude, plus the expense version at response time as an informational snapshot.
 * It carries no account fields, so non-owner reads need no redaction.
 */
public record FinancialAllocationResponse(
    UUID id,
    UUID transactionId,
    UUID householdId,
    UUID payerUserId,
    String currency,
    MoneyResponse originalAmount,
    List<ParticipantResponse> participants,
    String status,
    Instant createdAt,
    Instant revokedAt,
    int transactionVersion,
    String method,
    String refundPolicy,
    ImpactResponse impact) {

  /** Exact money boundary: plain decimal amount string plus uppercase currency code. */
  public record MoneyResponse(String amount, String currency) {}

  /** One frozen participant share in ascending canonical user-UUID order. */
  public record ParticipantResponse(UUID userId, MoneyResponse share) {}

  public record ImpactResponse(
      MoneyResponse cumulativeRefundAmount,
      MoneyResponse payerCredit,
      List<ImpactParticipantResponse> participants) {}

  public record ImpactParticipantResponse(
      UUID userId, MoneyResponse cumulativeRefundShare, MoneyResponse remainingObligation) {}
}
