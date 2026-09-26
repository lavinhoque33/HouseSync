package com.housesync.finance.report.web;

import com.housesync.finance.report.web.BudgetResponses.BudgetProgress;
import com.housesync.finance.report.web.RecurringResponses.PlanProjection;
import com.housesync.finance.report.web.SpendingInsightsResponse.*;
import java.util.List;

/** One current, authorized household snapshot; monetary amounts and counts are decimal strings. */
public record InsightsSummaryResponse(
    String reportingTimeZone,
    String asOfDate,
    String currency,
    String policyVersion,
    String snapshot,
    Period period,
    Period baselinePeriod,
    Totals current,
    Totals baseline,
    Change change,
    Drivers categoryDrivers,
    Drivers merchantDrivers,
    Budget budget,
    Recurring recurring) {
  public record Drivers(
      List<GroupComparison> increases, List<GroupComparison> decreases, String otherDelta) {}

  public record Budget(
      Spend totals, BudgetProgress overall, List<BudgetProgress> categories, Spend untargeted) {}

  public record Recurring(
      String evidenceFrom,
      String evidenceTo,
      String openCandidateCount,
      String activePlanCount,
      List<PlanProjection> items,
      boolean hasMore) {}
}
