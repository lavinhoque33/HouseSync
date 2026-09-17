package com.housesync.finance.transaction.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.account.domain.SupportedCurrency;
import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Exact equal-division mathematics behind allocations (ADR 0007): integer minor units at
 * the explicit currency scale, remainder awarding to the earliest ordered participants,
 * conservation of the magnitude, monotonic refund shares that exactly reverse the original shares
 * at a full refund, and canonical user-UUID string ordering.
 */
class AllocationSharesPolicyTest {

  private static final List<SupportedCurrency> ALL_CURRENCIES = List.of(SupportedCurrency.values());

  private static BigDecimal amount(String value, SupportedCurrency currency) {
    return new BigDecimal(value).setScale(currency.scale());
  }

  private static List<BigDecimal> divide(
      String magnitude, SupportedCurrency currency, int participantCount) {
    return AllocationSharesPolicy.equalShares(
        amount(magnitude, currency), currency, participantCount);
  }

  @Test
  void tenUsdAcrossThreeParticipantsIsExactRemainderShares() {
    List<BigDecimal> shares = divide("10.00", SupportedCurrency.USD, 3);
    assertThat(shares.stream().map(BigDecimal::toPlainString))
        .containsExactly("3.34", "3.33", "3.33");
    assertThat(shares.stream().reduce(BigDecimal.ZERO, BigDecimal::add))
        .isEqualByComparingTo(amount("10.00", SupportedCurrency.USD));
  }

  @Test
  void thousandJpyAcrossThreeParticipantsSplitsInWholeUnits() {
    List<BigDecimal> shares = divide("1000", SupportedCurrency.JPY, 3);
    assertThat(shares.stream().map(BigDecimal::toPlainString)).containsExactly("334", "333", "333");
  }

  @Test
  void threeScaleKwdCarriesThreeFractionalDigits() {
    List<BigDecimal> shares = divide("10.000", SupportedCurrency.KWD, 3);
    assertThat(shares.stream().map(BigDecimal::toPlainString))
        .containsExactly("3.334", "3.333", "3.333");
    assertThat(shares.stream().reduce(BigDecimal.ZERO, BigDecimal::add))
        .isEqualByComparingTo(amount("10.000", SupportedCurrency.KWD));
  }

  @Test
  void singleParticipantReceivesTheWholeMagnitude() {
    for (SupportedCurrency currency : ALL_CURRENCIES) {
      String magnitude = currency == SupportedCurrency.JPY ? "1" : "1.00";
      List<BigDecimal> shares = divide(magnitude, currency, 1);
      assertThat(shares).hasSize(1);
      assertThat(shares.get(0)).isEqualByComparingTo(amount(magnitude, currency));
    }
  }

  @Test
  void tinyContractValidAllocationsProduceOrderedZeroSharesAndStayConserved() {
    // The smallest positive magnitude across more participants than minor units exhausts the
    // remainder rule before every participant: zeros are contract-valid exact-scale shares and
    // the shares still sum exactly to the magnitude.
    List<BigDecimal> oneUsdCentAcrossTwo = divide("0.01", SupportedCurrency.USD, 2);
    assertThat(oneUsdCentAcrossTwo.stream().map(BigDecimal::toPlainString))
        .containsExactly("0.01", "0.00");
    List<BigDecimal> oneJpyAcrossThree = divide("1", SupportedCurrency.JPY, 3);
    assertThat(oneJpyAcrossThree.stream().map(BigDecimal::toPlainString))
        .containsExactly("1", "0", "0");
    List<BigDecimal> oneFilsAcrossThree = divide("0.001", SupportedCurrency.KWD, 3);
    assertThat(oneFilsAcrossThree.stream().map(BigDecimal::toPlainString))
        .containsExactly("0.001", "0.000", "0.000");

    // Conservation and scale hold for every currency's smallest magnitude at common splits.
    for (SupportedCurrency currency : ALL_CURRENCIES) {
      BigDecimal smallest = BigDecimal.valueOf(1, currency.scale());
      for (int count : List.of(2, 3, 5)) {
        List<BigDecimal> shares = AllocationSharesPolicy.equalShares(smallest, currency, count);
        assertThat(shares).hasSize(count);
        assertThat(shares.stream().reduce(BigDecimal.ZERO, BigDecimal::add))
            .as("%s smallest unit across %d participants", currency, count)
            .isEqualByComparingTo(smallest);
        assertThat(shares)
            .allSatisfy(share -> assertThat(share.signum()).isGreaterThanOrEqualTo(0));
        assertThat(shares.subList(Math.min(1, shares.size()), shares.size()))
            .allSatisfy(share -> assertThat(share.signum()).isZero());
      }
    }
  }

  @Test
  void tinyAllocationFullRefundExactlyReversesSharesIncludingZeros() {
    List<BigDecimal> original = divide("0.01", SupportedCurrency.USD, 2);
    List<BigDecimal> fullRefundShares = divide("0.01", SupportedCurrency.USD, 2);
    assertThat(subtract(original, fullRefundShares))
        .allSatisfy(obligation -> assertThat(obligation.signum()).isZero());
    // A partial 0.01 refund of the same one-cent magnitude is the full refund; a zero refund
    // derives zero refund shares, leaving every obligation at its original share.
    List<BigDecimal> zeroRefundShares = divide("0.00", SupportedCurrency.USD, 2);
    assertThat(zeroRefundShares.stream().map(BigDecimal::toPlainString))
        .containsExactly("0.00", "0.00");
    assertThat(subtract(original, zeroRefundShares)).containsExactlyElementsOf(original);
  }

  @Test
  void everyCurrencyConservesTheMagnitudeForCommonSplits() {
    for (SupportedCurrency currency : ALL_CURRENCIES) {
      for (int count : List.of(1, 2, 3, 4, 5, 7)) {
        List<BigDecimal> shares = divide("10", currency, count);
        assertThat(shares).hasSize(count);
        assertThat(shares.stream().reduce(BigDecimal.ZERO, BigDecimal::add))
            .as("%s split %d ways", currency, count)
            .isEqualByComparingTo(amount("10", currency));
        assertThat(shares).allSatisfy(share -> assertThat(share.signum()).isPositive());
      }
      // The largest documented per-record magnitude still divides in exact minor units.
      List<BigDecimal> largest =
          AllocationSharesPolicy.equalShares(
              new BigDecimal("999999999999").setScale(currency.scale()), currency, 3);
      assertThat(largest.stream().reduce(BigDecimal.ZERO, BigDecimal::add))
          .isEqualByComparingTo(new BigDecimal("999999999999").setScale(currency.scale()));
    }
  }

  @Test
  void refundSharesMatchTheDocumentedPartialAndFullRefundExamples() {
    SupportedCurrency usd = SupportedCurrency.USD;
    List<BigDecimal> original = divide("10.00", usd, 3);

    List<BigDecimal> firstRefund = divide("1.00", usd, 3);
    assertThat(firstRefund.stream().map(BigDecimal::toPlainString))
        .containsExactly("0.34", "0.33", "0.33");
    List<BigDecimal> firstObligations = subtract(original, firstRefund);
    assertThat(firstObligations.stream().map(BigDecimal::toPlainString))
        .containsExactly("3.00", "3.00", "3.00");

    List<BigDecimal> cumulativeRefund = divide("3.00", usd, 3);
    List<BigDecimal> cumulativeObligations = subtract(original, cumulativeRefund);
    assertThat(cumulativeObligations.stream().map(BigDecimal::toPlainString))
        .containsExactly("2.34", "2.33", "2.33");

    // A full refund exactly reverses the original shares, leaving zero obligations.
    List<BigDecimal> fullRefund = divide("10.00", usd, 3);
    assertThat(subtract(original, fullRefund))
        .allSatisfy(obligation -> assertThat(obligation.signum()).isZero());

    // The payer credit minus the summed obligations is exactly zero at every refund state.
    for (String refunded : List.of("0.00", "1.00", "3.00", "10.00")) {
      List<BigDecimal> shares = subtract(original, divide(refunded, usd, 3));
      BigDecimal obligationsSum = shares.stream().reduce(BigDecimal.ZERO, BigDecimal::add);
      BigDecimal payerCredit = amount("10.00", usd).subtract(amount(refunded, usd));
      assertThat(payerCredit.subtract(obligationsSum))
          .isEqualByComparingTo(BigDecimal.ZERO.setScale(2));
    }
  }

  @Test
  void refundSharesAreMonotonicAndNeverExceedOriginalShares() {
    for (SupportedCurrency currency : ALL_CURRENCIES) {
      String magnitude = currency == SupportedCurrency.JPY ? "1000" : "10.00";
      List<BigDecimal> original =
          AllocationSharesPolicy.equalShares(amount(magnitude, currency), currency, 3);
      long total = AllocationSharesPolicy.toMinorUnits(amount(magnitude, currency), currency);
      long previousFirst = -1;
      long previousSecond = -1;
      long previousThird = -1;
      for (long minor = 0; minor <= total; minor++) {
        List<BigDecimal> refundShares =
            AllocationSharesPolicy.equalShares(
                BigDecimal.valueOf(minor, currency.scale()), currency, 3);
        long first = AllocationSharesPolicy.toMinorUnits(refundShares.get(0), currency);
        long second = AllocationSharesPolicy.toMinorUnits(refundShares.get(1), currency);
        long third = AllocationSharesPolicy.toMinorUnits(refundShares.get(2), currency);
        assertThat(first).isGreaterThanOrEqualTo(previousFirst);
        assertThat(second).isGreaterThanOrEqualTo(previousSecond);
        assertThat(third).isGreaterThanOrEqualTo(previousThird);
        assertThat(first)
            .isLessThanOrEqualTo(AllocationSharesPolicy.toMinorUnits(original.get(0), currency));
        assertThat(second)
            .isLessThanOrEqualTo(AllocationSharesPolicy.toMinorUnits(original.get(1), currency));
        assertThat(third)
            .isLessThanOrEqualTo(AllocationSharesPolicy.toMinorUnits(original.get(2), currency));
        long refundedSum = Arrays.stream(new long[] {first, second, third}).sum();
        assertThat(refundedSum).isEqualTo(minor);
        previousFirst = first;
        previousSecond = second;
        previousThird = third;
      }
    }
  }

  @Test
  void canonicalUserOrderIsTheLowercaseHyphenatedStringOrder() {
    UUID highBit = UUID.fromString("ffffffff-0000-4000-8000-000000000001");
    UUID mid = UUID.fromString("80000000-0000-4000-8000-000000000001");
    UUID low = UUID.fromString("7fffffff-0000-4000-8000-000000000001");
    List<UUID> ordered =
        List.of(highBit, low, mid).stream()
            .sorted(AllocationSharesPolicy.CANONICAL_USER_ORDER)
            .toList();
    assertThat(ordered.stream().map(UUID::toString))
        .containsExactly(
            "7fffffff-0000-4000-8000-000000000001",
            "80000000-0000-4000-8000-000000000001",
            "ffffffff-0000-4000-8000-000000000001");
  }

  @Test
  void divisionRejectsAnEmptyParticipantSet() {
    assertThatThrownBy(
            () ->
                AllocationSharesPolicy.equalShares(
                    amount("10.00", SupportedCurrency.USD), SupportedCurrency.USD, 0))
        .isInstanceOf(IllegalArgumentException.class);
  }

  private static List<BigDecimal> subtract(List<BigDecimal> original, List<BigDecimal> refunds) {
    List<BigDecimal> result = new java.util.ArrayList<>();
    for (int index = 0; index < original.size(); index++) {
      result.add(original.get(index).subtract(refunds.get(index)));
    }
    return result;
  }
}
