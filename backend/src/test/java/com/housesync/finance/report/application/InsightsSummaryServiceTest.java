package com.housesync.finance.report.application;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.web.SpendingInsightsResponse.*;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.junit.jupiter.api.Test;

class InsightsSummaryServiceTest {
  @Test
  void independentlyRanksBothSignsAcrossTheCompleteGroupPopulationAndReconcilesExactly() {
    List<GroupComparison> groups = new ArrayList<>();
    BigDecimal total = BigDecimal.ZERO;
    for (int i = 0; i < 120; i++) {
      BigDecimal delta = new BigDecimal(i < 110 ? "10.00" : "-7.00");
      total = total.add(delta);
      String key = String.format("group-%03d", i);
      Spend zero = new Spend("0.00", "0.00", "0.00", "0", "0");
      groups.add(
          new GroupComparison(
              key,
              key,
              zero,
              zero,
              new Change(
                  delta.toPlainString(),
                  delta.signum() > 0 ? "INCREASE" : "DECREASE",
                  null,
                  "BASELINE_ZERO")));
    }
    groups.sort(
        Comparator.comparing((GroupComparison g) -> new BigDecimal(g.change().delta()).abs())
            .reversed()
            .thenComparing(GroupComparison::key));
    var drivers =
        InsightsSummaryService.drivers(groups, total.toPlainString(), SupportedCurrency.USD);
    assertThat(drivers.increases())
        .extracting(GroupComparison::key)
        .containsExactly("group-000", "group-001", "group-002", "group-003", "group-004");
    assertThat(drivers.decreases())
        .extracting(GroupComparison::key)
        .containsExactly("group-110", "group-111", "group-112", "group-113", "group-114");
    BigDecimal shown =
        drivers.increases().stream()
            .map(g -> new BigDecimal(g.change().delta()))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    shown =
        drivers.decreases().stream()
            .map(g -> new BigDecimal(g.change().delta()))
            .reduce(shown, BigDecimal::add);
    assertThat(shown.add(new BigDecimal(drivers.otherDelta()))).isEqualByComparingTo(total);
    assertThat(drivers.otherDelta()).isEqualTo("1015.00");
  }
}
