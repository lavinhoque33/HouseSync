package com.housesync.finance.categorization.domain;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import org.junit.jupiter.api.Test;

/**
 * Pure classifier precedence rules: exact reviewed mapping, kind boundaries, unknown-code behavior,
 * and the never-default rule. No database, provider, or Spring context.
 */
class CategorizationClassifierTest {

  @Test
  void reviewedPrimaryCodesMapOnlyForCompatibleKinds() {
    assertThat(
            CategorizationClassifier.classify("GENERAL_MERCHANDISE", null, TransactionKind.EXPENSE))
        .hasValueSatisfying(
            assignment -> {
              assertThat(assignment.category()).isEqualTo(TransactionCategory.SHOPPING);
              assertThat(assignment.rulesetVersion())
                  .isEqualTo(ProviderCategoryMapping.RULESET_VERSION);
            });
    assertThat(CategorizationClassifier.classify("INCOME", null, TransactionKind.INCOME))
        .hasValueSatisfying(
            assignment -> assertThat(assignment.category()).isEqualTo(TransactionCategory.INCOME));
    assertThat(CategorizationClassifier.classify("TRANSFER_IN", null, TransactionKind.TRANSFER))
        .hasValueSatisfying(
            assignment ->
                assertThat(assignment.category()).isEqualTo(TransactionCategory.TRANSFERS));
  }

  @Test
  void reviewedDetailPairsMapWithoutBroadFallback() {
    assertThat(
            CategorizationClassifier.classify(
                "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES", TransactionKind.EXPENSE))
        .hasValueSatisfying(
            assignment ->
                assertThat(assignment.category()).isEqualTo(TransactionCategory.GROCERIES));
    assertThat(
            CategorizationClassifier.classify(
                "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT", TransactionKind.EXPENSE))
        .hasValueSatisfying(
            assignment -> assertThat(assignment.category()).isEqualTo(TransactionCategory.HOUSING));

    assertThat(
            CategorizationClassifier.classify(
                "FOOD_AND_DRINK", "FOOD_AND_DRINK_UNKNOWN_DETAIL", TransactionKind.EXPENSE))
        .isEmpty();
    assertThat(
            CategorizationClassifier.classify(
                "MEDICAL", "FOOD_AND_DRINK_GROCERIES", TransactionKind.EXPENSE))
        .isEmpty();
  }

  @Test
  void unknownMalformedAndMissingCodesNeverDefault() {
    assertThat(CategorizationClassifier.classify("SOME_NEW_CODE", null, TransactionKind.EXPENSE))
        .isEmpty();
    assertThat(CategorizationClassifier.classify(null, null, TransactionKind.EXPENSE)).isEmpty();
    assertThat(
            CategorizationClassifier.classify("", "FOOD_AND_DRINK_COFFEE", TransactionKind.EXPENSE))
        .isEmpty();
    assertThat(
            CategorizationClassifier.classify(
                "FOOD_AND_DRINK", "lowercase_detail", TransactionKind.EXPENSE))
        .isEmpty();
  }

  @Test
  void incompatibleKindsAndRefundsNeverAutoCategorize() {
    assertThat(CategorizationClassifier.classify("INCOME", null, TransactionKind.EXPENSE))
        .isEmpty();
    assertThat(
            CategorizationClassifier.classify("GENERAL_MERCHANDISE", null, TransactionKind.INCOME))
        .isEmpty();
    assertThat(CategorizationClassifier.classify("TRANSFER_OUT", null, TransactionKind.EXPENSE))
        .isEmpty();
    assertThat(
            CategorizationClassifier.classify(
                "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES", TransactionKind.REFUND))
        .isEmpty();
  }

  @Test
  void mappingVersionIsABoundedRulesetIdentifier() {
    assertThat(ProviderCategoryMapping.RULESET_VERSION).isEqualTo("PLAID_PFC_V1_V2_1");
    assertThat(ProviderCategoryMapping.RULESET_VERSION.length()).isLessThanOrEqualTo(32);
  }
}
