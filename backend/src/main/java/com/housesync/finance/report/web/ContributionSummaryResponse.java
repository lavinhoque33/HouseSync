package com.housesync.finance.report.web;

import java.util.List;
import java.util.UUID;

/** Only disclosed period contributions; repayments and account details never enter this DTO. */
public record ContributionSummaryResponse(
    String from,
    String to,
    String reportingTimeZone,
    String currency,
    String snapshot,
    Totals totals,
    List<Item> items,
    int limit,
    int offset,
    boolean hasMore) {
  public record Totals(
      String expenseTotal,
      String refundTotal,
      String netSpending,
      String allocatedCostTotal,
      String unallocatedNet) {}

  public record Item(
      UUID userId,
      String membershipStatus,
      String expensePaid,
      String refundReceived,
      String netPaid,
      String allocatedCost) {}
}
