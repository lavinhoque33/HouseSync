package com.housesync.finance.report.application;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.web.BudgetResponses.BudgetProgress;
import com.housesync.finance.report.web.InsightsSummaryResponse;
import com.housesync.finance.report.web.InsightsSummaryResponse.*;
import com.housesync.finance.report.web.RecurringResponses.PlanProjection;
import com.housesync.finance.report.web.SpendingInsightsResponse.*;
import com.housesync.household.application.HouseholdService;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** All components are read under one household lifecycle lock and one database transaction. */
@Service
public class InsightsSummaryService {
  public static final String POLICY =
      "SUMMARY_V1/SPENDING_V1/RECURRENCE_V1/BUDGETS_V1/PUBLIC_DESCRIPTION_V1";
  private final HouseholdService households;
  private final SpendingInsightsService spending;
  private final BudgetTargetService budgets;
  private final RecurringInsightsService recurring;
  private final Clock clock;

  public InsightsSummaryService(
      HouseholdService households,
      SpendingInsightsService spending,
      BudgetTargetService budgets,
      RecurringInsightsService recurring,
      Clock clock) {
    this.households = households;
    this.spending = spending;
    this.budgets = budgets;
    this.recurring = recurring;
    this.clock = clock;
  }

  @Transactional
  public InsightsSummaryResponse summary(
      UUID household, UUID actor, YearMonth month, YearMonth baseline, SupportedCurrency currency) {
    households.lockForFinance(household, actor);
    String zone = households.financeSettings(household).reportingTimeZone();
    LocalDate today = LocalDate.now(clock.withZone(ZoneId.of(zone)));
    // Comparison builds and fingerprints the complete SQL-scoped group projection before
    // pagination.
    // MAX_VALUE here is an internal, unpaged projection, never an HTTP page or a truncated list.
    Comparison categories =
        spending.comparison(
            household,
            actor,
            month,
            baseline,
            currency,
            "CATEGORY",
            Integer.MAX_VALUE,
            null,
            today);
    Comparison merchants =
        spending.comparison(
            household,
            actor,
            month,
            baseline,
            currency,
            "MERCHANT",
            Integer.MAX_VALUE,
            null,
            today);
    var progress = budgets.progress(household, actor, month, currency, today);
    var plans = recurring.summary(household, actor, currency, today);
    Drivers categoryDrivers = drivers(categories.items(), categories.change().delta(), currency);
    Drivers merchantDrivers = drivers(merchants.items(), merchants.change().delta(), currency);
    Budget budget =
        new Budget(
            progress.totals(), progress.overall(), progress.categories(), progress.untargeted());
    Recurring overview =
        new Recurring(
            plans.evidenceFrom(),
            plans.evidenceTo(),
            plans.openCandidateCount(),
            plans.activePlanCount(),
            plans.items(),
            plans.hasMore());
    String snapshot;
    try (var hash = new SpendingInsightsService.Fingerprint()) {
      hash.add(
          "HouseSync:M6:summary",
          POLICY,
          household.toString(),
          month.toString(),
          baseline.toString(),
          currency.name(),
          categories.reportingTimeZone(),
          categories.asOfDate(),
          categories.snapshot(),
          merchants.snapshot(),
          progress.snapshot(),
          plans.fingerprint());
      period(hash, categories.period());
      period(hash, categories.baselinePeriod());
      hash.totals(categories.current());
      hash.totals(categories.baseline());
      hash.change(categories.change());
      drivers(hash, categoryDrivers);
      drivers(hash, merchantDrivers);
      hash.spend(budget.totals());
      progress(hash, budget.overall());
      hash.outWriteCount(budget.categories().size());
      for (BudgetProgress item : budget.categories()) progress(hash, item);
      hash.spend(budget.untargeted());
      hash.add(
          overview.evidenceFrom(),
          overview.evidenceTo(),
          overview.openCandidateCount(),
          overview.activePlanCount(),
          Boolean.toString(overview.hasMore()));
      hash.outWriteCount(overview.items().size());
      for (PlanProjection item : overview.items()) {
        var p = item.plan();
        var e = item.expectation();
        hash.add(
            p.id().toString(),
            p.householdId().toString(),
            p.label(),
            p.kind(),
            p.currency(),
            p.matchDescription(),
            p.merchantKey(),
            p.cadence(),
            p.anchorOn(),
            p.calendarAnchor(),
            p.expectedAmount(),
            p.status(),
            Integer.toString(p.version()),
            p.createdAt().toString(),
            p.updatedAt().toString(),
            e.latestExpectedOn(),
            e.latestState(),
            e.nextExpectedOn(),
            e.windowFrom(),
            e.windowTo(),
            e.matchedCount(),
            e.observedAmount());
      }
      snapshot = hash.finish();
    }
    return new InsightsSummaryResponse(
        categories.reportingTimeZone(),
        categories.asOfDate(),
        currency.name(),
        POLICY,
        snapshot,
        categories.period(),
        categories.baselinePeriod(),
        categories.current(),
        categories.baseline(),
        categories.change(),
        categoryDrivers,
        merchantDrivers,
        budget,
        overview);
  }

  static Drivers drivers(
      List<GroupComparison> all, String overallDelta, SupportedCurrency currency) {
    List<GroupComparison> increases = new ArrayList<>(5), decreases = new ArrayList<>(5);
    BigDecimal remainder = new BigDecimal(overallDelta);
    // A's complete comparison sorts by absolute exact delta descending, then key ascending.
    for (GroupComparison group : all) {
      BigDecimal delta = new BigDecimal(group.change().delta());
      List<GroupComparison> destination = delta.signum() > 0 ? increases : decreases;
      if (delta.signum() != 0 && destination.size() < 5) {
        destination.add(group);
        remainder = remainder.subtract(delta);
      }
    }
    return new Drivers(
        List.copyOf(increases),
        List.copyOf(decreases),
        RecurrencePolicy.exact(remainder, currency));
  }

  private static void period(SpendingInsightsService.Fingerprint hash, Period value) {
    hash.add(value.month(), value.from(), value.to(), value.state());
  }

  private static void drivers(SpendingInsightsService.Fingerprint hash, Drivers value) {
    for (List<GroupComparison> groups : List.of(value.increases(), value.decreases())) {
      hash.outWriteCount(groups.size());
      for (GroupComparison group : groups) {
        hash.add(group.key(), group.label());
        hash.spend(group.current());
        hash.spend(group.baseline());
        hash.change(group.change());
      }
    }
    hash.add(value.otherDelta());
  }

  private static void progress(SpendingInsightsService.Fingerprint hash, BudgetProgress value) {
    if (value == null) {
      hash.add((String) null);
      return;
    }
    var target = value.target();
    hash.add(
        target.id().toString(),
        target.householdId().toString(),
        target.month(),
        target.bucket(),
        target.money().amount(),
        target.money().currency(),
        target.status(),
        Integer.toString(target.version()),
        target.createdAt().toString(),
        target.updatedAt().toString());
    hash.spend(value.actual());
    hash.add(value.remaining(), value.overBy(), value.percentUsed(), value.status());
  }
}
