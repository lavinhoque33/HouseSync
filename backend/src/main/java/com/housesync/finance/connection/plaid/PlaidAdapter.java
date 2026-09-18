package com.housesync.finance.connection.plaid;

import java.time.Instant;
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

  /** Confirms remote Item removal; ambiguous outcomes throw {@link AmbiguousRemovalException}. */
  void removeItem(String accessToken);

  record LinkToken(String linkToken, Instant expiresAt) {}

  record ExchangeResult(String remoteItemId, String accessToken) {}

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
