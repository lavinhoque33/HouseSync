package com.housesync.finance.categorization.domain;

/**
 * Owner-rule policy identity (categorization contract §4). The version covers the exact matching
 * pipeline an owner rule was learned and applied under — the conservative text normalizer and the
 * scope-bound provider merchant digest — so a future behavior change ships under a new version
 * instead of silently reinterpreting retained rules. Assignments record the rule's own ruleset
 * version; historical provenance never follows a later bump.
 */
public final class CategorizationRulePolicy {

  /** Bounded application ruleset version for owner rules. */
  public static final String RULESET_VERSION = "OWNER_RULE_V1";

  private CategorizationRulePolicy() {}
}
