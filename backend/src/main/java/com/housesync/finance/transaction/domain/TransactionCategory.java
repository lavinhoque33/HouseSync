package com.housesync.finance.transaction.domain;

/**
 * Fixed, server-owned flat category taxonomy (ADR 0007): exactly sixteen tokens, declared in the
 * documented response order. Tokens are case-sensitive, never derived from {@code kind} or
 * visibility, and have no hierarchy, customization, or household variants. Labels are returned by
 * the server and are the only user-visible category names; clients must not derive them.
 */
public enum TransactionCategory {
  HOUSING("Housing"),
  GROCERIES("Groceries"),
  DINING("Dining"),
  UTILITIES("Utilities"),
  TRANSPORTATION("Transportation"),
  SHOPPING("Shopping"),
  ENTERTAINMENT("Entertainment"),
  HEALTHCARE("Healthcare"),
  TRAVEL("Travel"),
  EDUCATION("Education"),
  PERSONAL("Personal"),
  HOUSEHOLD_SUPPLIES("Household Supplies"),
  SUBSCRIPTIONS("Subscriptions"),
  INCOME("Income"),
  TRANSFERS("Transfers"),
  MISCELLANEOUS("Miscellaneous");

  private final String label;

  TransactionCategory(String label) {
    this.label = label;
  }

  /** Server-returned display label; not localized. */
  public String label() {
    return label;
  }
}
