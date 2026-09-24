package com.housesync.finance.categorization.domain;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import org.junit.jupiter.api.Test;

class CategorizationHeuristicTest {
  @Test
  void onlyExactNormalizedExpenseMerchantsProduceReviewCandidates() {
    assertThat(CategorizationHeuristic.suggest(TransactionKind.EXPENSE, " ＮＥＴＦＬＩＸ "))
        .contains(TransactionCategory.SUBSCRIPTIONS);
    assertThat(CategorizationHeuristic.suggest(TransactionKind.EXPENSE, "Netflix #19")).isEmpty();
    assertThat(CategorizationHeuristic.suggest(TransactionKind.EXPENSE, "Uber Eats")).isEmpty();
    assertThat(CategorizationHeuristic.suggest(TransactionKind.INCOME, "Netflix")).isEmpty();
    assertThat(CategorizationHeuristic.suggest(TransactionKind.REFUND, "Netflix")).isEmpty();
  }
}
