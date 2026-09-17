package com.housesync.finance.transaction.domain;

import java.util.Optional;

/** Transaction descriptions reuse the household/account Unicode boundary policy at 200. */
public final class TransactionDescriptionPolicy {

  public static final int MAX_CODE_POINTS = 200;

  private TransactionDescriptionPolicy() {}

  public static String normalize(String raw) {
    return raw == null ? null : trimOuter(raw);
  }

  public static Optional<String> violation(String raw) {
    if (raw == null || trimOuter(raw).isEmpty()) {
      return Optional.of("Enter a description.");
    }
    String canonical = trimOuter(raw);
    if (canonical.codePointCount(0, canonical.length()) > MAX_CODE_POINTS) {
      return Optional.of("Description must be at most 200 characters.");
    }
    if (canonical.codePoints().anyMatch(cp -> Character.getType(cp) == Character.CONTROL)) {
      return Optional.of("Description must not contain control characters.");
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
