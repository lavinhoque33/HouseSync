package com.housesync.finance.account.domain;

import java.util.Optional;

/** Private account labels use the same Unicode boundary policy as household display names. */
public final class FinancialAccountNamePolicy {

  public static final int MAX_CODE_POINTS = 100;

  private FinancialAccountNamePolicy() {}

  public static String normalize(String raw) {
    return raw == null ? null : trimOuter(raw);
  }

  public static Optional<String> violation(String raw) {
    if (raw == null || trimOuter(raw).isEmpty()) {
      return Optional.of("Enter an account name.");
    }
    String canonical = trimOuter(raw);
    if (canonical.codePointCount(0, canonical.length()) > MAX_CODE_POINTS) {
      return Optional.of("Account name must be at most 100 characters.");
    }
    if (canonical.codePoints().anyMatch(cp -> Character.getType(cp) == Character.CONTROL)) {
      return Optional.of("Account name must not contain control characters.");
    }
    return Optional.empty();
  }

  private static String trimOuter(String value) {
    int start = 0;
    int end = value.length();
    while (start < end && isOuterTrimmed(value.codePointAt(start))) {
      start += Character.charCount(value.codePointAt(start));
    }
    while (end > start && isOuterTrimmed(value.codePointBefore(end))) {
      end -= Character.charCount(value.codePointBefore(end));
    }
    return value.substring(start, end);
  }

  private static boolean isOuterTrimmed(int codePoint) {
    return Character.isWhitespace(codePoint)
        || Character.getType(codePoint) == Character.SPACE_SEPARATOR;
  }
}
