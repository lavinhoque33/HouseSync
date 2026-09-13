package com.housesync.identity.domain;

import java.nio.charset.StandardCharsets;
import java.util.Optional;

/**
 * Password rules.
 *
 * <p>Passwords are never trimmed or normalized. Registration requires at least 15 Unicode code
 * points, at most 72 UTF-8 bytes (bcrypt input limit; overlength input is rejected rather than
 * silently truncated), and no NUL characters. Login accepts any nonempty password up to 72 UTF-8
 * bytes without enforcing the registration minimum, so failure semantics stay stable for existing
 * credentials.
 */
public final class PasswordPolicy {

  public static final int MIN_CODE_POINTS = 15;
  public static final int MAX_UTF8_BYTES = 72;

  private PasswordPolicy() {}

  /** Registration-time rule: 15+ code points, at most 72 UTF-8 bytes, no NUL. */
  public static Optional<String> registrationViolation(String password) {
    if (password == null) {
      return Optional.of("Enter a password.");
    }
    if (password.indexOf('\u0000') >= 0) {
      return Optional.of("Password must not contain NUL characters.");
    }
    if (password.codePointCount(0, password.length()) < MIN_CODE_POINTS) {
      return Optional.of("Password must be at least 15 characters.");
    }
    if (utf8Length(password) > MAX_UTF8_BYTES) {
      return Optional.of("Password must be at most 72 bytes.");
    }
    return Optional.empty();
  }

  /** Login-time rule: nonempty, at most 72 UTF-8 bytes, no NUL. */
  public static Optional<String> loginViolation(String password) {
    if (password == null || password.isEmpty()) {
      return Optional.of("Enter a password.");
    }
    if (password.indexOf(0) >= 0) {
      return Optional.of("Password must not contain NUL characters.");
    }
    if (utf8Length(password) > MAX_UTF8_BYTES) {
      return Optional.of("Password must be at most 72 bytes.");
    }
    return Optional.empty();
  }

  public static int utf8Length(String password) {
    return password.getBytes(StandardCharsets.UTF_8).length;
  }
}
