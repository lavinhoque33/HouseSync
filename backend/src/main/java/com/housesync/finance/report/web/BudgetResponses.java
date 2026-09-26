package com.housesync.finance.report.web;

import com.housesync.finance.report.web.SpendingInsightsResponse.Period;
import com.housesync.finance.report.web.SpendingInsightsResponse.Spend;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class BudgetResponses {
  private BudgetResponses() {}

  public record Money(String amount, String currency) {}

  public record BudgetTarget(
      UUID id,
      UUID householdId,
      String month,
      String bucket,
      Money money,
      String status,
      int version,
      Instant createdAt,
      Instant updatedAt) {}

  public record Page(List<BudgetTarget> items, int limit, int offset, boolean hasMore) {}

  public record BudgetProgress(
      BudgetTarget target,
      Spend actual,
      String remaining,
      String overBy,
      String percentUsed,
      String status) {}

  public record Progress(
      String reportingTimeZone,
      String asOfDate,
      String currency,
      String policyVersion,
      String snapshot,
      Period period,
      Spend totals,
      BudgetProgress overall,
      List<BudgetProgress> categories,
      Spend untargeted) {}
}
