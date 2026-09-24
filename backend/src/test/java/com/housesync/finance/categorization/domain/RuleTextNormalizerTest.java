package com.housesync.finance.categorization.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Optional;
import org.junit.jupiter.api.Test;

/**
 * The one documented owner-rule text normalizer (categorization contract §3): Unicode NFKC
 * normalization, locale-independent lowercase, Unicode whitespace runs collapsed to one ASCII space
 * and trimmed, and punctuation/digits/token order preserved. Empty and over-limit results can never
 * form a rule; no suffix stripping, stemming, substring, or fuzzy variant is permitted.
 */
class RuleTextNormalizerTest {

  @Test
  void foldsCaseAndWhitespaceWhilePreservingPunctuationDigitsAndOrder() {
    assertThat(RuleTextNormalizer.normalize("Corner Market"))
        .isEqualTo(Optional.of("corner market"));
    assertThat(RuleTextNormalizer.normalize("  Corner   Market  "))
        .isEqualTo(Optional.of("corner market"));
    // Punctuation, digits, and token order survive; no store-number or suffix stripping.
    assertThat(RuleTextNormalizer.normalize("24/7 Store #3 — OPEN!"))
        .isEqualTo(Optional.of("24/7 store #3 — open!"));
    assertThat(RuleTextNormalizer.normalize("Starbucks Coffee 123"))
        .isEqualTo(Optional.of("starbucks coffee 123"));
    assertThat(RuleTextNormalizer.normalize("Corner Market"))
        .isNotEqualTo(RuleTextNormalizer.normalize("Corner Market II"));
  }

  @Test
  void nfkcFoldsCompatibilityFormsBeforeLowercasing() {
    // Fullwidth Latin folds to ASCII forms; the ligature expands; NBSP and ideographic spaces
    // collapse like any other Unicode whitespace.
    assertThat(RuleTextNormalizer.normalize("Ｃｏｒｎｅｒ　Ｍａｒｋｅｔ"))
        .isEqualTo(Optional.of("corner market"));
    assertThat(RuleTextNormalizer.normalize("ﬁne Foods")).isEqualTo(Optional.of("fine foods"));
    assertThat(RuleTextNormalizer.normalize("Corner Market\u00A0Ltd "))
        .isEqualTo(Optional.of("corner market ltd"));
    assertThat(RuleTextNormalizer.normalize("Café\u3000Noir")).isEqualTo(Optional.of("café noir"));
  }

  @Test
  void lowercasingIsLocaleIndependent() {
    // Locale.ROOT lowering keeps the Turkish dotted-I distinction and Greek sigma stable; a
    // Turkish or Greek default locale must never change the key.
    assertThat(RuleTextNormalizer.normalize("\u0130stanbul"))
        .isEqualTo(Optional.of("i\u0307stanbul"));
    assertThat(RuleTextNormalizer.normalize("ΑΣΤΥ")).isEqualTo(Optional.of("αστυ"));
  }

  @Test
  void overLimitResultsCanNeverFormARule() {
    assertThat(RuleTextNormalizer.normalize("a".repeat(200)))
        .isEqualTo(Optional.of("a".repeat(200)));
    assertThat(RuleTextNormalizer.normalize("a".repeat(201))).isEqualTo(Optional.empty());
    // NFKC expansion can push a bounded input past the key bound: one Arabian ligature expands
    // to eighteen characters.
    String expanded = "\uFDFA".repeat(12);
    assertThat(expanded.codePointCount(0, expanded.length())).isEqualTo(12);
    assertThat(RuleTextNormalizer.normalize(expanded)).isEqualTo(Optional.empty());
    assertThat(RuleTextNormalizer.normalize("\uFDFA")).isPresent();
  }

  @Test
  void emptyControlBearingAndNullTextsCanNeverFormARule() {
    assertThat(RuleTextNormalizer.normalize(null)).isEqualTo(Optional.empty());
    assertThat(RuleTextNormalizer.normalize("")).isEqualTo(Optional.empty());
    assertThat(RuleTextNormalizer.normalize("   ")).isEqualTo(Optional.empty());
    assertThat(RuleTextNormalizer.normalize("\u0007")).isEqualTo(Optional.empty());
    assertThat(RuleTextNormalizer.normalize("Corner\u0007Market")).isEqualTo(Optional.empty());
    // A C1 control is an ISO control too and never enters a key.
    assertThat(RuleTextNormalizer.normalize("Corner\u0085Market")).isEqualTo(Optional.empty());
  }
}
