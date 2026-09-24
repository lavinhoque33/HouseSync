package com.housesync.finance.categorization.domain;

import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import java.util.Map;
import java.util.Optional;

/** Versioned, intentionally small exact merchant allowlist. Never an automatic assignment. */
public final class CategorizationHeuristic {
  public static final String POLICY_VERSION = "exact-merchant-v1";
  private static final Map<String, TransactionCategory> MERCHANTS =
      Map.of(
          "aldi", TransactionCategory.GROCERIES,
          "trader joe's", TransactionCategory.GROCERIES,
          "whole foods market", TransactionCategory.GROCERIES,
          "netflix", TransactionCategory.SUBSCRIPTIONS,
          "spotify", TransactionCategory.SUBSCRIPTIONS,
          "uber", TransactionCategory.TRANSPORTATION);

  private CategorizationHeuristic() {}

  public static Optional<TransactionCategory> suggest(TransactionKind kind, String text) {
    if (kind != TransactionKind.EXPENSE) return Optional.empty();
    return RuleTextNormalizer.normalize(text).map(MERCHANTS::get);
  }
}
