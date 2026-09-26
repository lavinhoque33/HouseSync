package com.housesync.finance.report.web;

import java.util.List;
import java.util.UUID;

/** Current disclosed ledger projections; all monetary values and counts are decimal strings. */
public final class SpendingInsightsResponse {
  private SpendingInsightsResponse() {}

  public record Period(String month, String from, String to, String state) {}

  public record Spend(
      String expenseTotal,
      String refundTotal,
      String netSpending,
      String expenseCount,
      String refundCount) {}

  public record Totals(
      String expenseTotal,
      String refundTotal,
      String netSpending,
      String expenseCount,
      String refundCount,
      String incomeTotal) {}

  public record Change(
      String delta, String direction, String percentChange, String percentUnavailableReason) {}

  public record SeriesItem(Period period, Totals totals) {}

  public record GroupComparison(
      String key, String label, Spend current, Spend baseline, Change change) {}

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

  public record Series(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      String fromMonth,
      String toMonth,
      String dimension,
      String groupKey,
      List<SeriesItem> items) {}

  public record Comparison(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      Period period,
      Period baselinePeriod,
      String dimension,
      Totals current,
      Totals baseline,
      Change change,
      List<GroupComparison> items,
      String nextCursor) {}

  public record Evidence(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      Period period,
      String dimension,
      String groupKey,
      Spend totals,
      List<EvidenceItem> items,
      String nextCursor) {}
}
