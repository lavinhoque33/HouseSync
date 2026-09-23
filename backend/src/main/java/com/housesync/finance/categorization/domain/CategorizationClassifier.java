package com.housesync.finance.categorization.domain;

import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import java.util.Optional;

/**
 * Deterministic classifier (ADR 0009 §3; categorization contract §3). A pure domain
 * service: no controller, JPA callback, provider SDK hook, or I/O. It receives already-authorized
 * normalized evidence and returns at most one auto-applicable assignment under the strict
 * precedence order:
 *
 * <ol>
 *   <li>explicit user category instruction — short-circuits everything (recorded {@code USER} by
 *       the caller before classification ever runs);
 *   <li>versioned provider mapping — exact reviewed code mapping only;
 *   <li>{@code NONE} — no match, and never a default token.
 * </ol>
 *
 * <p>The {@code OWNER_RULE} precedence slot between user decisions and provider mapping is a
 * deliberate seam: exact household/owner rule lookup fits here without changing this
 * contract. Unknown, malformed, or unsafe evidence yields no assignment; classification never
 * defaults to {@code MISCELLANEOUS}, never changes kind, and never matches on text similarity.
 */
public final class CategorizationClassifier {

  private CategorizationClassifier() {}

  /** One classification outcome: a mapped token with the ruleset that produced it, or nothing. */
  public record Assignment(TransactionCategory category, String rulesetVersion) {}

  /**
   * Classifies one eligible new posted non-refund entry from normalized provider evidence. Exact
   * mappings still must agree with the owner's selected transaction kind: income maps only to
   * INCOME, transfers only to TRANSFERS, and expense-like mappings only to EXPENSE. Refunds are
   * inherited and never receive an automatic assignment.
   */
  public static Optional<Assignment> classify(
      String pfcPrimaryCode, String pfcDetailCode, TransactionKind kind) {
    if (kind == TransactionKind.REFUND) {
      return Optional.empty();
    }
    return ProviderCategoryMapping.map(pfcPrimaryCode, pfcDetailCode)
        .filter(category -> compatible(kind, category))
        .map(category -> new Assignment(category, ProviderCategoryMapping.RULESET_VERSION));
  }

  private static boolean compatible(TransactionKind kind, TransactionCategory category) {
    return switch (kind) {
      case EXPENSE ->
          category != TransactionCategory.INCOME && category != TransactionCategory.TRANSFERS;
      case INCOME -> category == TransactionCategory.INCOME;
      case TRANSFER -> category == TransactionCategory.TRANSFERS;
      case REFUND -> false;
    };
  }
}
