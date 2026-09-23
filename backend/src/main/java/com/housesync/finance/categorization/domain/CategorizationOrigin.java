package com.housesync.finance.categorization.domain;

/**
 * Fixed assignment-origin vocabulary for categorization provenance. The database check
 * constrains the stored values; the six tokens are also the exact owner-only response vocabulary.
 * {@code LEGACY} is migration-only: it never results from a live assignment.
 */
public enum CategorizationOrigin {
  NONE,
  LEGACY,
  USER,
  OWNER_RULE,
  PROVIDER,
  INHERITED
}
