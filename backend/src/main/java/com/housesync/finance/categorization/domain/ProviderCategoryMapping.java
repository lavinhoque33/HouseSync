package com.housesync.finance.categorization.domain;

import com.housesync.finance.transaction.domain.TransactionCategory;
import java.util.Map;
import java.util.Optional;

/**
 * Versioned, application-owned exact mapping from provider personal-finance category codes to the
 * fixed HouseSync taxonomy (ADR 0009 §5; categorization contract §3). The table is reviewed code:
 * unknown, malformed, or newly introduced provider codes yield no assignment, and no code maps to
 * {@code MISCELLANEOUS} by default. Detail codes refine their primary and participate in the same
 * conservative ruleset; a detail that has no reviewed mapping never invents one from its primary
 * when the primary itself is unmapped.
 *
 * <p>The version identifies this ruleset, not the provider's taxonomy: changing the table requires
 * a new version so historical assignments keep explaining themselves. Owner rules share the
 * ruleset-version seam ({@code OWNER_RULE} seam) but are never applied by this mapping.
 */
public final class ProviderCategoryMapping {

  /** Bounded application ruleset version covering Plaid PFCv1 and PFCv2. */
  public static final String RULESET_VERSION = "PLAID_PFC_V1_V2_1";

  private ProviderCategoryMapping() {}

  /**
   * Exact mapping for one reviewed provider code or primary/detail pair. A supplied detail must
   * match an explicitly reviewed pair; it never falls back to a broad primary mapping. Unknown,
   * mismatched, or malformed evidence yields no assignment.
   */
  public static Optional<TransactionCategory> map(String primaryCode, String detailCode) {
    if (!isSafeCode(primaryCode, 100) || (detailCode != null && !isSafeCode(detailCode, 200))) {
      return Optional.empty();
    }
    if (detailCode != null) {
      return Optional.ofNullable(DETAIL_MAPPINGS.get(pair(primaryCode, detailCode)));
    }
    return Optional.ofNullable(PRIMARY_MAPPINGS.get(primaryCode));
  }

  private static boolean isSafeCode(String code, int maxLength) {
    if (code == null || code.isBlank() || code.length() > maxLength) {
      return false;
    }
    for (int index = 0; index < code.length(); index++) {
      char character = code.charAt(index);
      boolean allowed =
          (character >= 'A' && character <= 'Z')
              || (character >= '0' && character <= '9')
              || character == '_';
      if (!allowed) {
        return false;
      }
    }
    return true;
  }

  private static String pair(String primary, String detail) {
    return primary + ":" + detail;
  }

  /**
   * Conservative PFCv1/PFCv2 primary mappings from Plaid's published taxonomy. Ambiguous primaries
   * such as FOOD_AND_DRINK, RENT_AND_UTILITIES, and GENERAL_SERVICES require an exact reviewed
   * detail instead.
   */
  private static final Map<String, TransactionCategory> PRIMARY_MAPPINGS =
      Map.ofEntries(
          Map.entry("GENERAL_MERCHANDISE", TransactionCategory.SHOPPING),
          Map.entry("HOME_IMPROVEMENT", TransactionCategory.HOUSEHOLD_SUPPLIES),
          Map.entry("MEDICAL", TransactionCategory.HEALTHCARE),
          Map.entry("PERSONAL_CARE", TransactionCategory.PERSONAL),
          Map.entry("ENTERTAINMENT", TransactionCategory.ENTERTAINMENT),
          Map.entry("TRANSPORTATION", TransactionCategory.TRANSPORTATION),
          Map.entry("TRAVEL", TransactionCategory.TRAVEL),
          Map.entry("INCOME", TransactionCategory.INCOME),
          Map.entry("TRANSFER_IN", TransactionCategory.TRANSFERS),
          Map.entry("TRANSFER_OUT", TransactionCategory.TRANSFERS));

  /** Exact detail mappings whose primary alone is too broad for one HouseSync token. */
  private static final Map<String, TransactionCategory> DETAIL_MAPPINGS =
      Map.ofEntries(
          Map.entry(
              pair("FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"), TransactionCategory.GROCERIES),
          Map.entry(pair("FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"), TransactionCategory.DINING),
          Map.entry(pair("FOOD_AND_DRINK", "FOOD_AND_DRINK_FAST_FOOD"), TransactionCategory.DINING),
          Map.entry(
              pair("FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), TransactionCategory.DINING),
          Map.entry(
              pair("GENERAL_SERVICES", "GENERAL_SERVICES_EDUCATION"),
              TransactionCategory.EDUCATION),
          Map.entry(
              pair("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT"), TransactionCategory.HOUSING),
          Map.entry(
              pair("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY"),
              TransactionCategory.UTILITIES),
          Map.entry(
              pair("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_INTERNET_AND_CABLE"),
              TransactionCategory.UTILITIES),
          Map.entry(
              pair("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT"),
              TransactionCategory.UTILITIES),
          Map.entry(
              pair("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_TELEPHONE"),
              TransactionCategory.UTILITIES),
          Map.entry(
              pair("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_WATER"),
              TransactionCategory.UTILITIES),
          Map.entry(
              pair("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_OTHER_UTILITIES"),
              TransactionCategory.UTILITIES));
}
