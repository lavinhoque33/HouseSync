package com.housesync.finance.categorization.domain;

/** Retained rule lifecycle; only the one-way ACTIVE to INACTIVE transition is accepted. */
public enum RuleStatus {
  ACTIVE,
  INACTIVE
}
