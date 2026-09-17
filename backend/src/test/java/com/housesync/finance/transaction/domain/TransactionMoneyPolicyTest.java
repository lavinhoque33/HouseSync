package com.housesync.finance.transaction.domain;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.account.domain.SupportedCurrency;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Exact-money boundary rules: grammar, currency scale, padding, range, nonzero, and sign per kind,
 * across all six supported currencies.
 */
class TransactionMoneyPolicyTest {

  private static BigDecimal parse(String raw, SupportedCurrency currency) {
    Map<String, String> errors = new LinkedHashMap<>();
    BigDecimal parsed = TransactionMoneyPolicy.parseAmount(raw, currency, errors);
    assertThat(errors).isEmpty();
    return parsed;
  }

  private static String violation(String raw, SupportedCurrency currency) {
    Map<String, String> errors = new LinkedHashMap<>();
    BigDecimal parsed = TransactionMoneyPolicy.parseAmount(raw, currency, errors);
    assertThat(parsed).isNull();
    assertThat(errors).containsKey("money.amount");
    return errors.get("money.amount");
  }

  @Test
  void parsesAndPadsEverySupportedCurrencyToItsScale() {
    assertThat(parse("-12.34", SupportedCurrency.BRL).toPlainString()).isEqualTo("-12.34");
    assertThat(parse("-12.3", SupportedCurrency.BRL).toPlainString()).isEqualTo("-12.30");
    assertThat(parse("1", SupportedCurrency.KWD).toPlainString()).isEqualTo("1.000");
    assertThat(parse("1.5", SupportedCurrency.KWD).toPlainString()).isEqualTo("1.500");
    assertThat(parse("1.234", SupportedCurrency.KWD).toPlainString()).isEqualTo("1.234");
    assertThat(parse("1", SupportedCurrency.JPY).toPlainString()).isEqualTo("1");
    assertThat(parse("-5", SupportedCurrency.JPY).toPlainString()).isEqualTo("-5");
    assertThat(parse("9.99", SupportedCurrency.USD).toPlainString()).isEqualTo("9.99");
    assertThat(parse("0.01", SupportedCurrency.EUR).toPlainString()).isEqualTo("0.01");
    assertThat(parse("7", SupportedCurrency.GBP).toPlainString()).isEqualTo("7.00");
  }

  @Test
  void equivalentMoneyStringsNormalizeToTheSameScaledValue() {
    // "1" and "1.00" for BRL must produce the same canonical value after validation.
    assertThat(parse("1", SupportedCurrency.BRL))
        .isEqualByComparingTo(parse("1.00", SupportedCurrency.BRL));
    assertThat(parse("1", SupportedCurrency.BRL).toPlainString()).isEqualTo("1.00");
  }

  @Test
  void acceptsScaleAndRangeBoundaries() {
    assertThat(parse("-999999999999.99", SupportedCurrency.BRL)).isNotNull();
    assertThat(parse("-999999999999.999", SupportedCurrency.KWD)).isNotNull();
    assertThat(parse("999999999999", SupportedCurrency.JPY)).isNotNull();
    assertThat(parse("-999999999999", SupportedCurrency.USD)).isNotNull();
    assertThat(parse("0.005", SupportedCurrency.KWD)).isNotNull();
    // 17 characters: sign, 12 integral digits, decimal point, three fractional digits.
    assertThat("-999999999999.999").hasSize(17);
  }

  @Test
  void rejectsMalformedGrammarAndSyntax() {
    for (String raw :
        new String[] {
          "01.00", // leading zero
          "+1.00", // leading plus
          "1e5", // exponent notation
          " 1.00", // whitespace
          "1.00 ", // trailing whitespace
          "1,000", // comma
          "$5", // symbol
          "", // empty
          "-", // sign only
          "1.", // trailing point
          ".50", // no integral digit
          "1000000000000", // 13 integral digits
          "-1000000000000.00", // 13 integral digits
          "1.2.3", // double point
          "--1.00", // double sign
          "١٢", // non-ASCII digits
        }) {
      assertThat(violation(raw, SupportedCurrency.BRL)).isNotBlank();
    }
  }

  @Test
  void rejectsExcessPrecisionPerCurrencyScale() {
    assertThat(violation("1.0", SupportedCurrency.JPY)).isNotBlank();
    assertThat(violation("1.230", SupportedCurrency.BRL)).isNotBlank();
    assertThat(violation("1.234", SupportedCurrency.USD)).isNotBlank();
    assertThat(violation("1.0001", SupportedCurrency.KWD)).isNotBlank();
    // Trimming zeros would preserve value but the input precision rule stays explicit.
    assertThat(violation("1.20", SupportedCurrency.JPY)).isNotBlank();
  }

  @Test
  void rejectsZeroNegativeZeroAndOversizedInput() {
    for (String raw : new String[] {"0", "0.00", "-0", "-0.00", "0.000", "-0.000"}) {
      assertThat(violation(raw, SupportedCurrency.BRL)).isNotBlank();
      assertThat(violation(raw, SupportedCurrency.JPY)).isNotBlank();
    }
    // Bounded before parsing: 17 characters is the maximum accepted amount string.
    assertThat(violation("-999999999999.9999", SupportedCurrency.KWD)).isNotBlank();
    assertThat(violation("-9999999999999", SupportedCurrency.JPY)).isNotBlank();
  }

  @Test
  void rejectsNullAmount() {
    Map<String, String> errors = new LinkedHashMap<>();
    assertThat(TransactionMoneyPolicy.parseAmount(null, SupportedCurrency.BRL, errors)).isNull();
    assertThat(errors.get("money.amount")).isNotBlank();
  }

  @Test
  void enforcesSignConventionPerKind() {
    Map<String, String> errors = new LinkedHashMap<>();
    TransactionMoneyPolicy.checkSign(TransactionKind.EXPENSE, new BigDecimal("-1"), errors);
    TransactionMoneyPolicy.checkSign(TransactionKind.INCOME, new BigDecimal("1"), errors);
    TransactionMoneyPolicy.checkSign(TransactionKind.REFUND, new BigDecimal("1"), errors);
    TransactionMoneyPolicy.checkSign(TransactionKind.TRANSFER, new BigDecimal("-1"), errors);
    TransactionMoneyPolicy.checkSign(TransactionKind.TRANSFER, new BigDecimal("1"), errors);
    assertThat(errors).isEmpty();

    // Zero never reaches the sign check through parseAmount's nonzero rule, but the
    // standalone check rejects it for kinds with a required sign and accepts it (as any
    // sign) for transfers.
    for (TransactionKind kind : TransactionKind.values()) {
      Map<String, String> zeroErrors = new LinkedHashMap<>();
      TransactionMoneyPolicy.checkSign(kind, BigDecimal.ZERO, zeroErrors);
      if (kind == TransactionKind.TRANSFER) {
        assertThat(zeroErrors).isEmpty();
      } else {
        assertThat(zeroErrors).hasSize(1);
      }
    }

    Map<String, String> wrongSigns = new LinkedHashMap<>();
    TransactionMoneyPolicy.checkSign(TransactionKind.EXPENSE, new BigDecimal("1"), wrongSigns);
    TransactionMoneyPolicy.checkSign(TransactionKind.INCOME, new BigDecimal("-1"), wrongSigns);
    TransactionMoneyPolicy.checkSign(TransactionKind.REFUND, new BigDecimal("-1"), wrongSigns);
    // All violations name the same nested money field with a safe, non-echoing message.
    assertThat(wrongSigns).containsOnlyKeys("money.amount");
    assertThat(wrongSigns.get("money.amount")).isNotBlank();
  }

  @Test
  void responseStringsUseExactlyTheCurrencyScale() {
    assertThat(
            TransactionMoneyPolicy.toResponseString(new BigDecimal("-12.3"), SupportedCurrency.BRL))
        .isEqualTo("-12.30");
    assertThat(TransactionMoneyPolicy.toResponseString(new BigDecimal("1"), SupportedCurrency.JPY))
        .isEqualTo("1");
    assertThat(
            TransactionMoneyPolicy.toResponseString(new BigDecimal("1.5"), SupportedCurrency.KWD))
        .isEqualTo("1.500");
  }
}
