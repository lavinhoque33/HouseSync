package com.housesync.household.domain;

import java.util.Optional;

/**
 * Household display-name policy.
 *
 * <p>The server trims leading/trailing whitespace at the outer boundary, preserves interior
 * content, and requires 1-100 Unicode code points with no control characters. Duplicate names are
 * valid; each household is distinct by ID.
 *
 * <p>Trimming covers Java whitespace plus Unicode space separators, so visually blank names made of
 * no-break spaces (U+00A0), figure space (U+2007), narrow no-break space (U+202F), or other
 * separators are rejected as blank, and such characters are trimmed at the outer boundary while
 * interior spacing is preserved.
 */
public final class HouseholdNamePolicy {

  public static final int MAX_CODE_POINTS = 100;

  private HouseholdNamePolicy() {}

  /** Trims the outer boundary; returns {@code null} for {@code null} input. */
  public static String normalize(String raw) {
    if (raw == null) {
      return null;
    }
    return trimOuter(raw);
  }

  /**
   * Returns a safe user-facing violation message, or empty when the raw value normalizes to an
   * acceptable stored name.
   */
  public static Optional<String> violation(String raw) {
    if (raw == null || trimOuter(raw).isEmpty()) {
      return Optional.of("Enter a household name.");
    }
    String canonical = trimOuter(raw);
    if (canonical.codePointCount(0, canonical.length()) > MAX_CODE_POINTS) {
      return Optional.of("Household name must be at most 100 characters.");
    }
    if (containsControl(canonical)) {
      return Optional.of("Household name must not contain control characters.");
    }
    return Optional.empty();
  }

  /**
   * Strips leading/trailing Java whitespace and Unicode space separators (both are outer boundary,
   * never interior content). {@link String#strip()} alone leaves the non-breaking spaces U+00A0,
   * U+2007, and U+202F in place.
   */
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

  private static boolean containsControl(String value) {
    return value
        .codePoints()
        .anyMatch(codePoint -> Character.getType(codePoint) == Character.CONTROL);
  }
}
