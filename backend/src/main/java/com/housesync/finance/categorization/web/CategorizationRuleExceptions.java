package com.housesync.finance.categorization.web;

/**
 * Owner-rule-flow failures mapped by the shared finance exception advice. Messages stay generic so
 * missing, foreign, and other-owner rules are indistinguishable, and no match key, merchant
 * evidence, submitted category, or another owner's rule existence is ever embedded.
 */
public final class CategorizationRuleExceptions {

  private CategorizationRuleExceptions() {}

  /** Missing, foreign, or other-owner rule: the privacy-preserving generic 404. */
  public static final class RuleNotFoundException extends RuntimeException {}

  /** An ACTIVE rule already exists for this owner's derived match key. */
  public static final class CategoryRuleConflictException extends RuntimeException {}

  /** Same durable create key reused with different details. */
  public static final class RuleIdempotencyConflictException extends RuntimeException {}
}
