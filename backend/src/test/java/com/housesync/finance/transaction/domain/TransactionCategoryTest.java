package com.housesync.finance.transaction.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.Test;

/** The fixed taxonomy contract: exactly sixteen closed tokens in documented order with labels. */
class TransactionCategoryTest {

  @Test
  void taxonomyIsExactlyTheDocumentedSixteenTokensInOrder() {
    List<String> tokens = Arrays.stream(TransactionCategory.values()).map(Enum::name).toList();
    assertThat(tokens)
        .containsExactly(
            "HOUSING",
            "GROCERIES",
            "DINING",
            "UTILITIES",
            "TRANSPORTATION",
            "SHOPPING",
            "ENTERTAINMENT",
            "HEALTHCARE",
            "TRAVEL",
            "EDUCATION",
            "PERSONAL",
            "HOUSEHOLD_SUPPLIES",
            "SUBSCRIPTIONS",
            "INCOME",
            "TRANSFERS",
            "MISCELLANEOUS");
  }

  @Test
  void labelsAreServerOwnedDistinctDisplayText() {
    for (TransactionCategory category : TransactionCategory.values()) {
      assertThat(category.label()).isNotBlank();
      assertThat(category.label()).doesNotContain("_");
    }
    assertThat(TransactionCategory.HOUSING.label()).isEqualTo("Housing");
    assertThat(TransactionCategory.HOUSEHOLD_SUPPLIES.label()).isEqualTo("Household Supplies");
    assertThat(TransactionCategory.TRANSFERS.label()).isEqualTo("Transfers");
    assertThat(TransactionCategory.MISCELLANEOUS.label()).isEqualTo("Miscellaneous");
    long distinct =
        Arrays.stream(TransactionCategory.values())
            .map(TransactionCategory::label)
            .distinct()
            .count();
    assertThat(distinct).isEqualTo(TransactionCategory.values().length);
  }

  @Test
  void tokensAreCaseSensitiveAndBounded() {
    for (TransactionCategory category : TransactionCategory.values()) {
      assertThat(category.name()).matches("[A-Z][A-Z_]*");
      assertThat(category.name().length()).isLessThanOrEqualTo(24);
      assertThat(TransactionCategory.valueOf(category.name())).isSameAs(category);
      String lowercase = category.name().toLowerCase(Locale.ROOT);
      assertThatThrownBy(() -> TransactionCategory.valueOf(lowercase))
          .isInstanceOf(IllegalArgumentException.class);
    }
  }
}
