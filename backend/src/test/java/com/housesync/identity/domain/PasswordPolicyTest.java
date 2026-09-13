package com.housesync.identity.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class PasswordPolicyTest {

  @Test
  void registrationRequiresFifteenCodePointsNotChars() {
    assertThat(PasswordPolicy.registrationViolation("a".repeat(14))).isPresent();
    assertThat(PasswordPolicy.registrationViolation("a".repeat(15))).isEmpty();
    // Emoji are single code points but surrogate pairs: 15 emoji satisfy the minimum.
    assertThat(PasswordPolicy.registrationViolation("😀".repeat(14))).isPresent();
    assertThat(PasswordPolicy.registrationViolation("😀".repeat(15))).isEmpty();
  }

  @Test
  void registrationEnforcesByteLimitRatherThanTruncating() {
    String exactly72Bytes = "a".repeat(72);
    assertThat(PasswordPolicy.utf8Length(exactly72Bytes)).isEqualTo(72);
    assertThat(PasswordPolicy.registrationViolation(exactly72Bytes)).isEmpty();
    // 71 ASCII bytes plus é (2 bytes in UTF-8) = 73 bytes.
    String over72Bytes = "a".repeat(71) + "é";
    assertThat(PasswordPolicy.utf8Length(over72Bytes)).isEqualTo(73);
    assertThat(PasswordPolicy.registrationViolation(over72Bytes)).isPresent();
  }

  @Test
  void registrationRejectsNulButAllowsSpacesAndPunctuation() {
    assertThat(PasswordPolicy.registrationViolation("correct horse battery staple!")).isEmpty();
    assertThat(PasswordPolicy.registrationViolation("  padded with spaces 123")).isEmpty();
    assertThat(PasswordPolicy.registrationViolation("fifteen chars here\u0000")).isPresent();
    assertThat(PasswordPolicy.registrationViolation(null)).isPresent();
  }

  @Test
  void loginAcceptsShortPasswordsButKeepsShapeLimits() {
    assertThat(PasswordPolicy.loginViolation("short")).isEmpty();
    assertThat(PasswordPolicy.loginViolation("  spaced  ")).isEmpty();
    assertThat(PasswordPolicy.loginViolation("")).isPresent();
    assertThat(PasswordPolicy.loginViolation(null)).isPresent();
    assertThat(PasswordPolicy.loginViolation("long-enough-with-nul" + Character.toString(0)))
        .isPresent();
    assertThat(PasswordPolicy.loginViolation("a".repeat(72))).isEmpty();
    assertThat(PasswordPolicy.loginViolation("a".repeat(73))).isPresent();
  }
}
