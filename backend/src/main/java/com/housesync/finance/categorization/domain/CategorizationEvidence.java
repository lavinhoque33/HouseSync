package com.housesync.finance.categorization.domain;

/**
 * Separate deterministic digest over normalized provider categorization evidence (categorization
 * contract §3). The {@code providerRevision} stays the exact money/date/state revision; this
 * fingerprint changes when merchant identity, merchant display name, or the provider
 * personal-finance codes change, so a category/name-only provider update never reopens bank
 * reconciliation or marks an admitted entry modified.
 *
 * <p>Inputs are already application-owned and identity-safe: the merchant identity participates as
 * its scope-bound digest, never as a raw provider identifier. The digest is stable and
 * deterministic so later suggestion work can compare evidence without re-fetching.
 */
public final class CategorizationEvidence {

  private CategorizationEvidence() {}

  /**
   * Canonical evidence fingerprint over the bounded normalized values; any null value canonicalizes
   * as {@code null} so evidence is distinct from absent evidence.
   */
  public static String fingerprint(
      String merchantIdentityDigest,
      String merchantDisplayName,
      String pfcPrimary,
      String pfcDetail) {
    String canonical =
        "v1\0"
            + (merchantIdentityDigest == null ? "null" : merchantIdentityDigest)
            + "\0"
            + (merchantDisplayName == null ? "null" : merchantDisplayName)
            + "\0"
            + (pfcPrimary == null ? "null" : pfcPrimary)
            + "\0"
            + (pfcDetail == null ? "null" : pfcDetail);
    return com.housesync.finance.connection.crypto.ConnectionCrypto.sha256Hex(canonical);
  }
}
