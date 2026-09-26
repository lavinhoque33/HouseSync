package com.housesync.finance.report;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.application.BudgetTargetService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import org.junit.jupiter.api.Test;

class BudgetTargetPolicyTest {
  @Test
  void acceptsZeroAndCurrencyScaleWithoutBinaryConversion() {
    assertThat(BudgetTargetService.amount("0", SupportedCurrency.USD)).isEqualTo("0.00");
    assertThat(BudgetTargetService.amount("999999999999.999", SupportedCurrency.KWD))
        .isEqualTo("999999999999.999");
    assertThat(BudgetTargetService.amount("999999999999", SupportedCurrency.JPY))
        .isEqualTo("999999999999");
    for (String malformed :
        new String[] {"-0", "-0.00", "-0.001", "-1", "01", "+1", "1e2", "1000000000000", "1.001"})
      assertThatThrownBy(() -> BudgetTargetService.amount(malformed, SupportedCurrency.USD))
          .isInstanceOf(ValidationFailedException.class);
    assertThatThrownBy(() -> BudgetTargetService.amount("0.1", SupportedCurrency.JPY))
        .isInstanceOf(ValidationFailedException.class);
    assertThatThrownBy(() -> BudgetTargetService.amount("0.0001", SupportedCurrency.KWD))
        .isInstanceOf(ValidationFailedException.class);
  }
}
