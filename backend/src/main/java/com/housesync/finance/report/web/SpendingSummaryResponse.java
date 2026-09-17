package com.housesync.finance.report.web;

import java.util.List;

/**
 * Exact documented spending-summary DTO: the explicit half-open date interval, the household
 * reporting zone at read time, and one bucket per currency with authorized posted entries in the
 * interval, ordered by currency code. Totals are nonnegative exact magnitudes at the currency
 * scale; {@code netSpending = expenseTotal - refundTotal} and may be negative in a refund-heavy
 * period. A bucket introduced only by transfers carries zero values. There is no grand total and no
 * default-currency bucket: no entries yields an empty list.
 */
public record SpendingSummaryResponse(
    String from, String to, String reportingTimeZone, List<CurrencySummaryResponse> currencies) {

  /** One currency bucket with exact amount strings. */
  public record CurrencySummaryResponse(
      String currency,
      String expenseTotal,
      String refundTotal,
      String netSpending,
      String incomeTotal) {}
}
