package com.housesync.finance.settlement;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.transaction.web.MemberBalancesResponse.MemberBalanceResponse;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class SettlementPlanTest {
  private static final UUID HOME = UUID.fromString("00000000-0000-0000-0000-000000000010");
  private static final String A = "00000000-0000-0000-0000-000000000001";
  private static final String B = "00000000-0000-0000-0000-000000000002";
  private static final String C = "00000000-0000-0000-0000-000000000003";
  private static final String D = "00000000-0000-0000-0000-000000000004";

  private static MemberBalanceResponse row(String id, String status, String amount) {
    return new MemberBalanceResponse(id, status, amount);
  }

  @Test
  void greedyAlternatingUuidTiesAndDepartedResidualAreExact() {
    var rows =
        List.of(
            row(A, "CURRENT", "-6.00"),
            row(B, "CURRENT", "5.00"),
            row(C, "CURRENT", "-4.00"),
            row(D, "CURRENT", "3.00"),
            row("00000000-0000-0000-0000-000000000005", "DEPARTED", "2.00"));
    var plan = SettlementPlan.calculate(HOME, SupportedCurrency.CAD, rows);
    var result = plan.page(SupportedCurrency.CAD, 0, 100, null);
    assertThat(result.items())
        .containsExactly(
            new SettlementPlan.Edge(A, B, new SettlementPlan.Money("5.00", "CAD")),
            new SettlementPlan.Edge(A, D, new SettlementPlan.Money("1.00", "CAD")),
            new SettlementPlan.Edge(C, D, new SettlementPlan.Money("2.00", "CAD")));
    assertThat(result.residuals())
        .isEqualTo(new SettlementPlan.Residuals("2.00", "0.00", "0.00", "2.00"));
    assertThat(plan.snapshot())
        .isEqualTo(SettlementPlan.calculate(HOME, SupportedCurrency.CAD, rows).snapshot());
    assertThat(
            SettlementPlan.calculate(
                    HOME,
                    SupportedCurrency.CAD,
                    List.of(
                        row(A, "CURRENT", "-6.01"),
                        row(B, "CURRENT", "5.01"),
                        row(C, "CURRENT", "-4.00"),
                        row(D, "CURRENT", "3.00"),
                        row("00000000-0000-0000-0000-000000000005", "DEPARTED", "2.00")))
                .snapshot())
        .isNotEqualTo(plan.snapshot());
    assertThat(SettlementPlan.calculate(HOME, SupportedCurrency.USD, List.of()).snapshot())
        .isNotEqualTo(SettlementPlan.calculate(HOME, SupportedCurrency.JPY, List.of()).snapshot());
  }

  @Test
  void signedCurrencyScalesAndEmptyVector() {
    for (var pair :
        List.of(
            new String[] {"JPY", "3"},
            new String[] {"KWD", "0.003"},
            new String[] {"CAD", "0.03"})) {
      var currency = SupportedCurrency.valueOf(pair[0]);
      var plan =
          SettlementPlan.calculate(
              HOME,
              currency,
              List.of(row(A, "CURRENT", "-" + pair[1]), row(B, "CURRENT", pair[1])));
      assertThat(plan.page(currency, 0, 50, null).items())
          .containsExactly(
              new SettlementPlan.Edge(A, B, new SettlementPlan.Money(pair[1], pair[0])));
      String zero =
          currency == SupportedCurrency.JPY
              ? "0"
              : currency == SupportedCurrency.KWD ? "0.000" : "0.00";
      assertThat(plan.page(currency, 0, 50, null).residuals())
          .isEqualTo(new SettlementPlan.Residuals(zero, zero, zero, zero));
      assertThat(
              SettlementPlan.calculate(HOME, currency, List.of())
                  .page(currency, 0, 50, null)
                  .items())
          .isEmpty();
    }
  }
}
