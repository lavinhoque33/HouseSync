package com.housesync.finance.transaction.domain;

import com.housesync.finance.account.domain.SupportedCurrency;
import java.math.BigDecimal;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Exact-money boundary for manual transactions (ADR 0006, manual-finance API "Money boundary").
 *
 * <p>Amounts arrive as decimal strings and are parsed once with the declared currency scale and no
 * rounding. The grammar rejects whitespace, leading plus, exponents, commas, symbols, and leading
 * zeros before any numeric parsing; scale-0 currencies reject any decimal point. Excess fractional
 * digits fail even when trimming would preserve value, and zero amounts fail for every kind, so
 * negative zero never reaches storage. Validation must complete before a database driver could
 * coerce or round a value.
 */
public final class TransactionMoneyPolicy {

  /** Sign, 12 integral digits, decimal point, three fractional digits. */
  static final int MAX_INPUT_LENGTH = 17;

  private static final Pattern AMOUNT_GRAMMAR =
      Pattern.compile("-?(0|[1-9][0-9]{0,11})(\\.[0-9]+)?");

  private TransactionMoneyPolicy() {}

  /**
   * Validates {@code rawAmount} against the currency's scale and the per-record magnitude bound and
   * records a safe {@code money.amount} field error on failure. Returns the normalized {@link
   * BigDecimal} (currency scale, no rounding needed because precision was validated first), or
   * {@code null} when a violation was recorded.
   */
  public static BigDecimal parseAmount(
      String rawAmount, SupportedCurrency currency, Map<String, String> errors) {
    if (rawAmount == null) {
      errors.put("money.amount", "Enter an amount.");
      return null;
    }
    if (rawAmount.length() > MAX_INPUT_LENGTH || !AMOUNT_GRAMMAR.matcher(rawAmount).matches()) {
      errors.put("money.amount", "Enter a supported amount.");
      return null;
    }
    BigDecimal parsed = new BigDecimal(rawAmount);
    if (parsed.scale() > currency.scale()) {
      // Excess precision, including "1.0" for JPY and "1.230" for BRL, is rejected before
      // any driver could round it; fewer digits are accepted and padded to the scale.
      errors.put(
          "money.amount",
          "Enter an amount with at most "
              + currency.scale()
              + " decimal places for "
              + currency.name()
              + ".");
      return null;
    }
    if (parsed.signum() == 0) {
      // Covers zero and negative zero for every kind.
      errors.put("money.amount", "Enter a nonzero amount.");
      return null;
    }
    return parsed.setScale(currency.scale());
  }

  /**
   * Validates the documented API sign convention and records a safe {@code money.amount} field
   * error on failure: expenses negative, income and refunds positive, transfers either.
   */
  public static void checkSign(
      TransactionKind kind, BigDecimal amount, Map<String, String> errors) {
    int signum = amount.signum();
    boolean valid =
        switch (kind) {
          case EXPENSE -> signum < 0;
          case INCOME, REFUND -> signum > 0;
          case TRANSFER -> true;
        };
    if (!valid) {
      errors.put("money.amount", "Enter an amount with the correct sign for " + kind.name() + ".");
    }
  }

  /** Returns the exact response string: plain decimal text with the currency's scale. */
  public static String toResponseString(BigDecimal amount, SupportedCurrency currency) {
    return amount.setScale(currency.scale()).toPlainString();
  }
}
