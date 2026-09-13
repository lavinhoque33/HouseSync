package com.housesync.identity.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class EmailPolicyTest {

  @Test
  void normalizesByTrimmingAndLowercasingWithoutLocaleSurprises() {
    assertThat(EmailPolicy.normalize("  Person@Example.TEST  ")).isEqualTo("person@example.test");
    // Explicit ROOT policy: ASCII "I" folds to "i" regardless of the JVM default locale
    // (a Turkish default locale would otherwise produce a dotless "ı").
    assertThat(EmailPolicy.normalize("KIRPI@EXAMPLE.TEST")).isEqualTo("kirpi@example.test");
    assertThat(EmailPolicy.normalize(null)).isNull();
  }

  @Test
  void acceptsCanonicalAsciiAddress() {
    assertThat(EmailPolicy.violation("person@example.test")).isEmpty();
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "   ", "not-an-email", "a@b", "@example.test", "a b@example.test"})
  void rejectsMissingOrMalformedAddresses(String raw) {
    assertThat(EmailPolicy.violation(raw)).isPresent();
  }

  @Test
  void rejectsNonAsciiAndOverlengthAddresses() {
    assertThat(EmailPolicy.violation("persön@example.test")).isPresent();
    String overlength = "a".repeat(250) + "@b.test";
    assertThat(overlength.length()).isGreaterThan(EmailPolicy.MAX_LENGTH);
    assertThat(EmailPolicy.violation(overlength)).isPresent();
    String longest = "a".repeat(EmailPolicy.MAX_LENGTH - "@b.test".length()) + "@b.test";
    assertThat(longest.length()).isEqualTo(EmailPolicy.MAX_LENGTH);
    assertThat(EmailPolicy.violation(longest)).isEmpty();
  }
}
