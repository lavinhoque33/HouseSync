package com.housesync.identity.domain;

import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Canonical login-identifier policy.
 *
 * <p>The identifier is an ASCII email, trimmed and lowercased with a locale-independent policy, at
 * most 254 characters. The canonical form is what is stored and compared, so uniqueness in
 * PostgreSQL is case-insensitive by construction. Email is an unverified login identifier; it must
 * not be treated as proof of ownership (for example of a household invitation).
 */
public final class EmailPolicy {

  public static final int MAX_LENGTH = 254;

  private static final Pattern ASCII_EMAIL =
      Pattern.compile(
          "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}$");

  private EmailPolicy() {}

  /** Trims and lowercases with {@link Locale#ROOT}; returns {@code null} for {@code null} input. */
  public static String normalize(String raw) {
    if (raw == null) {
      return null;
    }
    return raw.strip().toLowerCase(Locale.ROOT);
  }

  /**
   * Returns a safe user-facing violation message, or empty when the raw value normalizes to an
   * acceptable canonical identifier.
   */
  public static Optional<String> violation(String raw) {
    if (raw == null || raw.strip().isEmpty()) {
      return Optional.of("Enter an email address.");
    }
    String canonical = normalize(raw);
    if (canonical.length() > MAX_LENGTH) {
      return Optional.of("Email address must be at most 254 characters.");
    }
    if (!isAscii(canonical) || !ASCII_EMAIL.matcher(canonical).matches()) {
      return Optional.of("Enter a valid email address.");
    }
    return Optional.empty();
  }

  private static boolean isAscii(String value) {
    for (int i = 0; i < value.length(); i++) {
      if (value.charAt(i) > 127) {
        return false;
      }
    }
    return true;
  }
}
