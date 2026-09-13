package com.housesync.household.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class HouseholdNamePolicyTest {

  @Test
  void acceptsSimpleNameUnchanged() {
    assertThat(HouseholdNamePolicy.violation("Elm Street home")).isEmpty();
    assertThat(HouseholdNamePolicy.normalize("Elm Street home")).isEqualTo("Elm Street home");
  }

  @Test
  void trimsOuterBoundaryAndPreservesInterior() {
    assertThat(HouseholdNamePolicy.violation("  Elm  Street  ")).isEmpty();
    assertThat(HouseholdNamePolicy.normalize("  Elm  Street  ")).isEqualTo("Elm  Street");
  }

  @Test
  void unicodeSpaceSeparatorsAreBlankAndTrimmedAtTheBoundary() {
    char nbsp = (char) 160;
    char figureSpace = (char) 0x2007;
    char narrowNbsp = (char) 0x202F;
    assertThat(HouseholdNamePolicy.violation("" + nbsp)).contains("Enter a household name.");
    assertThat(HouseholdNamePolicy.violation("" + figureSpace)).contains("Enter a household name.");
    assertThat(HouseholdNamePolicy.violation("" + narrowNbsp + figureSpace + nbsp))
        .contains("Enter a household name.");
    assertThat(HouseholdNamePolicy.violation("" + nbsp + "Elm" + figureSpace)).isEmpty();
    assertThat(HouseholdNamePolicy.normalize("" + nbsp + "Elm" + figureSpace)).isEqualTo("Elm");
    assertThat(HouseholdNamePolicy.normalize(" \t" + nbsp + "Elm  Street" + nbsp + " "))
        .isEqualTo("Elm  Street");
  }

  @Test
  void interiorUnicodeSpacingIsPreserved() {
    char nbsp = (char) 160;
    String name = "Elm" + nbsp + "Street";
    assertThat(HouseholdNamePolicy.violation(name)).isEmpty();
    assertThat(HouseholdNamePolicy.normalize(name)).isEqualTo(name);
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "   ", "\t\n "})
  void blankNamesAreRejected(String raw) {
    assertThat(HouseholdNamePolicy.violation(raw)).contains("Enter a household name.");
  }

  @Test
  void nullNameIsRejected() {
    assertThat(HouseholdNamePolicy.violation(null)).contains("Enter a household name.");
    assertThat(HouseholdNamePolicy.normalize(null)).isNull();
  }

  @Test
  void exactlyOneHundredCodePointsAreAccepted() {
    String boundary = "n".repeat(100);
    assertThat(boundary.codePointCount(0, boundary.length())).isEqualTo(100);
    assertThat(HouseholdNamePolicy.violation(boundary)).isEmpty();
  }

  @Test
  void oneHundredOneCodePointsAreRejected() {
    assertThat(HouseholdNamePolicy.violation("n".repeat(101))).isPresent();
  }

  @Test
  void supplementaryCharactersCountAsSingleCodePoints() {
    // 99 ASCII characters plus one emoji: 100 code points, 101 UTF-16 units.
    String boundary = "n".repeat(99) + "😀";
    assertThat(boundary.length()).isEqualTo(101);
    assertThat(boundary.codePointCount(0, boundary.length())).isEqualTo(100);
    assertThat(HouseholdNamePolicy.violation(boundary)).isEmpty();
    assertThat(HouseholdNamePolicy.violation(boundary + "n")).isPresent();
  }

  @Test
  void controlCharactersAreRejected() {
    assertThat(HouseholdNamePolicy.violation("home" + ((char) 0))).isPresent();
    assertThat(HouseholdNamePolicy.violation("a" + ((char) 7) + "b")).isPresent();
    assertThat(HouseholdNamePolicy.violation("x" + ((char) 27))).isPresent();
    assertThat(HouseholdNamePolicy.violation("name" + ((char) 127))).isPresent();
  }

  @Test
  void interiorPunctuationAndCaseArePreserved() {
    String name = "O'Brien-Smith, Apt. #5!";
    assertThat(HouseholdNamePolicy.violation(name)).isEmpty();
    assertThat(HouseholdNamePolicy.normalize(name)).isEqualTo(name);
  }
}
