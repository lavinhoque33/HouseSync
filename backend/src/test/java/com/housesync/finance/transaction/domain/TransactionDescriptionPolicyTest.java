package com.housesync.finance.transaction.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

/** Description text boundary: outer trim, controls, and the 200 code point bound. */
class TransactionDescriptionPolicyTest {

  @Test
  void normalizesOuterUnicodeWhitespace() {
    assertThat(TransactionDescriptionPolicy.normalize("  Groceries  ")).isEqualTo("Groceries");
    assertThat(TransactionDescriptionPolicy.normalize("\u2028 Card \u2029")).isEqualTo("Card");
    assertThat(TransactionDescriptionPolicy.normalize("Fee\u00A0line")).isEqualTo("Fee\u00A0line");
  }

  @Test
  void acceptsInteriorTextAndUpToTwoHundredCodePoints() {
    String twoHundred =
        IntStream.range(0, 199).mapToObj(i -> "a").reduce("", (a, b) -> a + b) + "😀";
    // 199 'a' code points plus one surrogate pair = 200 code points (201 chars).
    assertThat(twoHundred.codePointCount(0, twoHundred.length())).isEqualTo(200);
    assertThat(TransactionDescriptionPolicy.violation(twoHundred)).isEmpty();
  }

  @Test
  void rejectsBlankTooLongAndControlCharacters() {
    assertThat(TransactionDescriptionPolicy.violation(null)).isPresent();
    assertThat(TransactionDescriptionPolicy.violation("   ")).isPresent();
    assertThat(TransactionDescriptionPolicy.violation("\u00A0")).isPresent();

    String tooLong = "a".repeat(201);
    assertThat(TransactionDescriptionPolicy.violation(tooLong)).isPresent();

    assertThat(TransactionDescriptionPolicy.violation("line\nbreak")).isPresent();
    assertThat(TransactionDescriptionPolicy.violation("tab\there")).isPresent();
    assertThat(TransactionDescriptionPolicy.violation("del\u007Fhere")).isPresent();
    assertThat(TransactionDescriptionPolicy.violation("c1\u009Fhere")).isPresent();
  }
}
