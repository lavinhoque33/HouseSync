package com.housesync.finance.categorization.domain;

import com.housesync.finance.transaction.domain.TransactionKind;
import java.util.Optional;

/**
 * Server-side derivation of the strongest available owner-rule match key for one posted non-refund
 * ledger entry (ADR 0009 §4; categorization contract §3-4). Clients never submit a match key; the
 * server derives it from authorized stored evidence only:
 *
 * <ol>
 *   <li>a retained provider-stable merchant identity digest wins and keys a {@code
 *       PROVIDER_MERCHANT} rule; and
 *   <li>otherwise — manual entries and connected entries admitted without a stable identity — the
 *       conservative {@link RuleTextNormalizer} key over the retained description forms a {@code
 *       NORMALIZED_TEXT} rule.
 * </ol>
 *
 * <p>Refunds are never eligible (they classify by inheritance), unsafe digests cannot form keys,
 * and empty/over-limit text yields no key at all. The derived key stays server-side: only the
 * bounded display label and match type ever reach the owner's browser.
 */
public final class CategorizationMatchKeys {

  /** One server-derived match key with its rule form. */
  public record DerivedKey(RuleMatchType matchType, String key) {}

  private CategorizationMatchKeys() {}

  /**
   * Derives the strongest match key for one entry from its retained evidence. Returns nothing for
   * refunds and for entries without a safe key — those transactions can neither learn nor match a
   * rule.
   */
  public static Optional<DerivedKey> derive(
      TransactionKind kind, String description, String merchantIdentityDigest) {
    if (kind == TransactionKind.REFUND) {
      return Optional.empty();
    }
    if (merchantIdentityDigest != null) {
      if (!merchantIdentityDigest.matches("^[0-9a-f]{64}$")) {
        // Unsafe retained evidence never forms a key.
        return Optional.empty();
      }
      return Optional.of(new DerivedKey(RuleMatchType.PROVIDER_MERCHANT, merchantIdentityDigest));
    }
    return RuleTextNormalizer.normalize(description)
        .map(key -> new DerivedKey(RuleMatchType.NORMALIZED_TEXT, key));
  }
}
