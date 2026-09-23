package com.housesync.finance.connection.plaid;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Application-owned provider boundary (connected-finance contract §3). Implementations keep SDK
 * types, tokens, payloads, and provider errors inside the adapter; domain and REST types carry only
 * HouseSync identifiers and exact values.
 */
public interface PlaidAdapter {

  /** Browser-facing provider name disclosed to the web client in link responses. */
  default String providerName() {
    return "PLAID";
  }

  /**
   * Short-lived browser Link token for a new-link attempt. The opaque client user id is derived by
   * the service from the stable local owner identity (never email or provider data) and travels
   * only server-to-provider.
   */
  LinkToken createLinkToken(UUID attemptId, String clientUserId);

  /**
   * Update-mode Link token for reconnecting an existing credential. Plaid requires the same stable
   * {@code user.client_user_id} as the original link attempt, so the caller passes the id derived
   * from the connection's owner identity.
   */
  LinkToken createUpdateLinkToken(String accessToken, String clientUserId);

  /** Exchanges a short-lived public token for the server-only Item identity and credential. */
  ExchangeResult exchangePublicToken(String publicToken);

  /** Reads remote account metadata for admission decisions; never a browser-supplied list. */
  List<RemoteAccount> fetchAccounts(String accessToken);

  /**
   * Reads one page of added/modified/removed transactions from the committed opaque cursor. The
   * adapter returns exact application values ({@link BigDecimal} amounts parsed from provider
   * decimal tokens) plus the next cursor, has-more flag, and history-readiness flag. Callers stage
   * or discard whole pages; the adapter never writes local state.
   */
  SyncPage fetchTransactionChanges(String accessToken, String cursor);

  /**
   * Fetches one Plaid verification JWK through the fixed allowlisted host. Only the key material is
   * returned; the key URL in a JWT header is never trusted or fetched.
   */
  VerificationKey fetchVerificationKey(String keyId);

  /** Confirms remote Item removal; ambiguous outcomes throw {@link AmbiguousRemovalException}. */
  void removeItem(String accessToken);

  record LinkToken(String linkToken, Instant expiresAt) {}

  record ExchangeResult(String remoteItemId, String accessToken) {}

  /**
   * One provider transaction revision. Amounts are exact provider-signed decimals (positive means
   * money leaving the account holder under Plaid's convention); normalization inverts the sign and
   * validates everything else. Missing optional fields stay null and are quarantined or tolerated
   * by the normalizer, never defaulted.
   *
   * <p>Categorization evidence is application-owned, bounded, and nullable: a stable
   * provider merchant identity plus optional display name and personal-finance primary/detail
   * codes. Raw provider payloads and identifiers beyond these normalized fields stay inside the
   * adapter; the merchant identity is digested before storage, so it never persists raw.
   */
  record ProviderTransaction(
      String remoteAccountId,
      String remoteTransactionId,
      String pendingPredecessorId,
      boolean pending,
      String officialCurrency,
      String unofficialCurrency,
      BigDecimal amount,
      LocalDate postedOn,
      LocalDate authorizedOn,
      String description,
      String merchantName,
      String merchantIdentity,
      String merchantDisplayName,
      String pfcPrimaryCode,
      String pfcDetailCode) {}

  /** One fetched sync page. {@code nextCursor} is required by the provider on every page. */
  record SyncPage(
      List<ProviderTransaction> upserts,
      List<String> removedRemoteTransactionIds,
      String nextCursor,
      boolean hasMore,
      boolean historyReady) {}

  record VerificationKey(String keyId, java.security.PublicKey publicKey, Instant expiresAt) {}

  /** The remote call may have succeeded while its response was lost; never blindly retried. */
  final class AmbiguousRemovalException extends RuntimeException {
    public AmbiguousRemovalException() {
      super("provider.removal_unknown");
    }
  }

  /** Exchange returned a credential whose response was lost; the caller marks OUTCOME_UNKNOWN. */
  final class AmbiguousExchangeException extends RuntimeException {
    public AmbiguousExchangeException() {
      super("provider.exchange_unknown");
    }
  }
}
