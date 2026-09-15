package com.housesync.household.domain;

import java.util.Optional;

/**
 * Strict lifecycle role policy. Only the exact canonical role names bind: {@code null}, lowercase
 * spellings, whitespace padding, and unknown values are violations. Role values never act as
 * authorization evidence; authorization resolves current membership separately.
 */
public final class MemberRolePolicy {

  public static final String ROLE_ERROR = "Choose owner or member.";

  private MemberRolePolicy() {}

  /**
   * Returns a safe user-facing violation message, or empty when the raw value names a stable role
   * exactly.
   */
  public static Optional<String> violation(String raw) {
    if (raw == null) {
      return Optional.of(ROLE_ERROR);
    }
    try {
      MemberRole.valueOf(raw);
      return Optional.empty();
    } catch (IllegalArgumentException invalidRole) {
      return Optional.of(ROLE_ERROR);
    }
  }
}
