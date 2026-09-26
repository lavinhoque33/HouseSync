package com.housesync.finance.report.web;

import java.util.List;
import java.util.UUID;

/** Exact shared HTTP shapes for independently authored plans and current recurring evidence. */
public final class RecurringResponses {
  private RecurringResponses() {}

  public record Money(String amount, String currency) {}

  public record EvidenceItem(
      UUID id,
      int version,
      String kind,
      String occurredOn,
      Money money,
      String description,
      String category,
      UUID refundOfTransactionId) {}

  public record Candidate(
      String merchantKey,
      String label,
      String cadence,
      String anchorOn,
      String calendarAnchor,
      String occurrenceCount,
      String firstOccurredOn,
      String lastOccurredOn,
      String minAmount,
      String medianAmount,
      String maxAmount,
      String amountPattern,
      String suggestedKind,
      String nextExpectedOn,
      String expectationState,
      String candidateFingerprint,
      String reviewStatus,
      int reviewVersion,
      UUID activePlanId) {}

  public record CandidatePage(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      String evidenceFrom,
      String evidenceTo,
      List<Candidate> items,
      String nextCursor) {}

  public record EvidencePage(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      String evidenceFrom,
      String evidenceTo,
      String merchantKey,
      Candidate candidate,
      List<EvidenceItem> items,
      String nextCursor) {}

  public record Review(
      String merchantKey, String currency, String reviewStatus, int reviewVersion) {}

  public record Plan(
      UUID id,
      UUID householdId,
      String label,
      String kind,
      String currency,
      String matchDescription,
      String merchantKey,
      String cadence,
      String anchorOn,
      String calendarAnchor,
      String expectedAmount,
      String status,
      int version,
      java.time.Instant createdAt,
      java.time.Instant updatedAt) {}

  public record PlanPage(List<Plan> items, int limit, int offset, boolean hasMore) {}

  public record Expectation(
      String latestExpectedOn,
      String latestState,
      String nextExpectedOn,
      String windowFrom,
      String windowTo,
      String matchedCount,
      String observedAmount) {}

  public record PlanProjection(Plan plan, Expectation expectation) {}

  public record ActivePlanPage(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      String evidenceFrom,
      String evidenceTo,
      List<PlanProjection> items,
      String nextCursor) {}

  public record ObservationPage(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      String evidenceFrom,
      String evidenceTo,
      Plan plan,
      Expectation expectation,
      List<EvidenceItem> items,
      String nextCursor) {}
}
