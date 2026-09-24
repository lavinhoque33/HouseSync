package com.housesync.finance.categorization.domain;

import java.util.Optional;

/**
 * The one documented text normalizer for owner rules (ADR 0009 §4; categorization contract §3):
 * Unicode NFKC normalization, locale-independent lowercase, Unicode whitespace runs collapsed to
 * one ASCII space and trimmed, punctuation/digits/token order preserved. No suffix stripping,
 * store-number removal, stemming, substring, edit-distance, amount/date correlation, or fuzzy
 * matching is permitted anywhere in rule derivation or matching.
 *
 * <p>Empty or over-limit results cannot form a rule, and control characters never enter a key. The
 * normalizer version participates in the owner-rule ruleset version so behavior cannot drift
 * silently: changing this pipeline requires a new {@link CategorizationRulePolicy} version.
 */
public final class RuleTextNormalizer {

  /** Key bound mirrors the description/label ceiling in code points. */
  public static final int MAX_KEY_CODE_POINTS = 200;

  private RuleTextNormalizer() {}

  /**
   * Normalizes one bounded private text into its exact match key, or nothing when the result is
   * empty, control-bearing, or over-limit and therefore cannot form a rule.
   */
  public static Optional<String> normalize(String raw) {
    if (raw == null) {
      return Optional.empty();
    }
    String folded = java.text.Normalizer.normalize(raw, java.text.Normalizer.Form.NFKC);
    String lowered = folded.toLowerCase(java.util.Locale.ROOT);
    String key = collapseUnicodeWhitespace(lowered);
    if (key.isEmpty() || key.codePointCount(0, key.length()) > MAX_KEY_CODE_POINTS) {
      return Optional.empty();
    }
    if (key.codePoints().anyMatch(RuleTextNormalizer::isRejectedControl)) {
      return Optional.empty();
    }
    return Optional.of(key);
  }

  /** Collapses runs of Unicode whitespace to one ASCII space and trims the ends. */
  private static String collapseUnicodeWhitespace(String value) {
    StringBuilder collapsed = new StringBuilder(value.length());
    boolean inRun = false;
    int index = 0;
    while (index < value.length()) {
      int codePoint = value.codePointAt(index);
      if (isUnicodeWhitespace(codePoint)) {
        inRun = true;
      } else {
        if (inRun && collapsed.length() > 0) {
          collapsed.append(' ');
        }
        inRun = false;
        collapsed.appendCodePoint(codePoint);
      }
      index += Character.charCount(codePoint);
    }
    return collapsed.toString();
  }

  /** Same Unicode whitespace class the ledger description policy trims at its boundaries. */
  private static boolean isUnicodeWhitespace(int codePoint) {
    return Character.isWhitespace(codePoint)
        || Character.getType(codePoint) == Character.SPACE_SEPARATOR;
  }

  /** Control characters never enter a match key: unsafe evidence cannot form a rule. */
  private static boolean isRejectedControl(int codePoint) {
    return Character.isISOControl(codePoint) || Character.getType(codePoint) == Character.CONTROL;
  }
}
