package com.housesync.finance.report;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.application.RecurrencePolicy;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class RecurrencePolicyTest {
  @Test
  void originalCalendarAnchorPreservesEndOfMonthLeapAndDayThirty() {
    LocalDate jan31 = LocalDate.of(2024, 1, 31);
    assertThat(RecurrencePolicy.slot(jan31, "MONTHLY", "END_OF_MONTH", 1))
        .isEqualTo(LocalDate.of(2024, 2, 29));
    assertThat(RecurrencePolicy.slot(jan31, "MONTHLY", "END_OF_MONTH", 2))
        .isEqualTo(LocalDate.of(2024, 3, 31));
    LocalDate jan30 = LocalDate.of(2023, 1, 30);
    assertThat(RecurrencePolicy.slot(jan30, "MONTHLY", "DAY_OF_MONTH", 1))
        .isEqualTo(LocalDate.of(2023, 2, 28));
    assertThat(RecurrencePolicy.slot(jan30, "MONTHLY", "DAY_OF_MONTH", 2))
        .isEqualTo(LocalDate.of(2023, 3, 30));
    LocalDate leap = LocalDate.of(2024, 2, 29);
    assertThat(RecurrencePolicy.slot(leap, "ANNUAL", "END_OF_MONTH", 1))
        .isEqualTo(LocalDate.of(2025, 2, 28));
    assertThat(RecurrencePolicy.slot(leap, "ANNUAL", "END_OF_MONTH", 4))
        .isEqualTo(LocalDate.of(2028, 2, 29));
  }

  @Test
  void todayWindowClampsBeforeLowerBoundAndAtLastLedgerDate() {
    var lower = RecurrencePolicy.bounds(LocalDate.of(1899, 12, 31));
    assertThat(lower.from()).isEqualTo(RecurrencePolicy.MIN);
    assertThat(lower.to()).isEqualTo(RecurrencePolicy.MIN);
    var upper = RecurrencePolicy.bounds(LocalDate.of(9999, 12, 31));
    assertThat(upper.from()).isEqualTo(LocalDate.of(9996, 12, 30));
    assertThat(upper.to()).isEqualTo(RecurrencePolicy.END);
    assertThat(RecurrencePolicy.slot(LocalDate.of(9999, 12, 30), "WEEKLY", null, 1)).isNull();
    assertThat(
            RecurrencePolicy.approximateSlot(
                LocalDate.of(1900, 1, 1), LocalDate.of(9999, 12, 30), "ANNUAL"))
        .isBetween(8099L, 8100L);
  }

  @Test
  void positiveExactSevenCurrencyAmountsCannotRoundOrExceedInputBound() {
    assertThat(RecurrencePolicy.amount("15.99", SupportedCurrency.USD)).isEqualTo("15.99");
    assertThat(RecurrencePolicy.amount("15", SupportedCurrency.JPY)).isEqualTo("15");
    assertThat(RecurrencePolicy.amount("0.001", SupportedCurrency.KWD)).isEqualTo("0.001");
    assertThat(RecurrencePolicy.amount("999999999999.999", SupportedCurrency.KWD))
        .isEqualTo("999999999999.999");
    for (String raw : new String[] {"0", "-0", "-1", "1000000000000", "1.001", "1e3"})
      assertThatThrownBy(() -> RecurrencePolicy.amount(raw, SupportedCurrency.USD))
          .as(raw)
          .isInstanceOf(ValidationFailedException.class);
    assertThatThrownBy(() -> RecurrencePolicy.amount("1.01", SupportedCurrency.JPY))
        .isInstanceOf(ValidationFailedException.class);
    assertThatThrownBy(
            () -> RecurrencePolicy.schedule("MONTHLY", LocalDate.of(2023, 1, 30), "END_OF_MONTH"))
        .isInstanceOf(ValidationFailedException.class);
  }
}
