package com.housesync.finance.connection.plaid;

import com.housesync.finance.connection.crypto.ConnectionCrypto;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Deterministic fake provider for tests and explicit local configuration only. Selected
 * exclusively through {@code app.connected-finance.provider=fake} together with {@code
 * fake-allowed=true}; never silently in production. Identities derive from the attempt UUID so
 * repeated runs are stable without live accounts or paid calls.
 */
public class FakePlaidAdapter implements PlaidAdapter {

  /** Fault-injection modes for ambiguous-outcome and recovery tests. */
  public enum FaultMode {
    NONE,
    /** Exchange throws an ambiguous failure: the remote outcome is unknown. */
    AMBIGUOUS_EXCHANGE,
    /** Exchange throws a retryable transient failure before any remote effect. */
    TRANSIENT_EXCHANGE,
    /** Remote removal throws an ambiguous failure: the remote outcome is unknown. */
    AMBIGUOUS_REMOVAL,
    /** Remote removal throws a retryable transient failure. */
    TRANSIENT_REMOVAL,
    /** Remote removal reports rate limiting, with the configured Retry-After delay. */
    RATE_LIMITED_REMOVAL,
    /** Remote removal blocks until the test releases it (stale-lease orchestration). */
    BLOCK_REMOVAL
  }

  private final Clock clock;
  private final AtomicReference<FaultMode> fault = new AtomicReference<>(FaultMode.NONE);
  private final AtomicReference<ProviderErrorClass> accountsFailure = new AtomicReference<>(null);
  private final AtomicReference<List<RemoteAccount>> extraAccounts =
      new AtomicReference<>(List.of());
  private final AtomicReference<String> lastClientUserId = new AtomicReference<>(null);
  private final AtomicLong removalRetryAfterSeconds = new AtomicLong(-1);
  private final AtomicReference<java.util.concurrent.CountDownLatch> removalGate =
      new AtomicReference<>(null);

  public FakePlaidAdapter(Clock clock) {
    this.clock = clock;
  }

  /** Test-only fault injection; tests must reset to {@link FaultMode#NONE} afterwards. */
  public void setFaultMode(FaultMode mode) {
    fault.set(mode);
  }

  /** Test-only account-read failure (recovery semantics); reset with {@code null} afterwards. */
  public void setAccountsFailure(ProviderErrorClass errorClass) {
    accountsFailure.set(errorClass);
  }

  /** Test-only additional discovered accounts (unsupported kinds/currencies); reset after. */
  public void setExtraAccounts(List<RemoteAccount> accounts) {
    extraAccounts.set(List.copyOf(accounts));
  }

  /** Test-only Retry-After delay surfaced with {@link FaultMode#RATE_LIMITED_REMOVAL}. */
  public void setRemovalRetryAfterSeconds(long seconds) {
    removalRetryAfterSeconds.set(seconds);
  }

  /**
   * Test-only removal gate: with {@link FaultMode#BLOCK_REMOVAL}, {@code removeItem} waits for the
   * latch (null clears the block by releasing). Reset with {@code null} afterwards.
   */
  public void setRemovalGate(java.util.concurrent.CountDownLatch gate) {
    removalGate.set(gate);
  }

  /** Last opaque client user id received; assertions must never expect emails or UUIDs. */
  public String lastClientUserId() {
    return lastClientUserId.get();
  }

  @Override
  public LinkToken createLinkToken(UUID attemptId, String clientUserId) {
    lastClientUserId.set(clientUserId);
    return new LinkToken(
        "fake-link-" + hex(attemptId, "link"), Instant.now(clock).plusSeconds(1800));
  }

  @Override
  public LinkToken createUpdateLinkToken(String accessToken, String clientUserId) {
    lastClientUserId.set(clientUserId);
    return new LinkToken(
        "fake-update-link-" + ConnectionCrypto.sha256Hex(accessToken).substring(0, 16),
        Instant.now(clock).plusSeconds(1800));
  }

  @Override
  public ExchangeResult exchangePublicToken(String publicToken) {
    return switch (fault.get()) {
      case AMBIGUOUS_EXCHANGE -> throw new AmbiguousExchangeException();
      case TRANSIENT_EXCHANGE -> throw new PlaidAdapterException(ProviderErrorClass.TRANSIENT);
      default -> {
        if (publicToken == null || !publicToken.startsWith("fake-public-")) {
          throw new PlaidAdapterException(ProviderErrorClass.PERMANENT);
        }
        String seed = publicToken.substring("fake-public-".length());
        yield new ExchangeResult("fake-item-" + seed, "fake-access-" + seed);
      }
    };
  }

  @Override
  public List<RemoteAccount> fetchAccounts(String accessToken) {
    ProviderErrorClass failure = accountsFailure.get();
    if (failure != null) {
      throw new PlaidAdapterException(failure);
    }
    if (accessToken == null || !accessToken.startsWith("fake-access-")) {
      throw new PlaidAdapterException(ProviderErrorClass.PERMANENT);
    }
    String seed = accessToken.substring("fake-access-".length());
    List<RemoteAccount> accounts =
        new ArrayList<>(
            List.of(
                new RemoteAccount(
                    "fake-remote-checking-" + seed, "Fake Checking", "CHECKING", "USD"),
                new RemoteAccount(
                    "fake-remote-savings-" + seed, "Fake Savings", "SAVINGS", "CAD")));
    accounts.addAll(extraAccounts.get());
    return accounts;
  }

  @Override
  public void removeItem(String accessToken) {
    switch (fault.get()) {
      case AMBIGUOUS_REMOVAL -> throw new AmbiguousRemovalException();
      case TRANSIENT_REMOVAL -> throw new PlaidAdapterException(ProviderErrorClass.TRANSIENT);
      case RATE_LIMITED_REMOVAL -> {
        long retryAfter = removalRetryAfterSeconds.get();
        throw new PlaidAdapterException(
            ProviderErrorClass.RATE_LIMITED, retryAfter >= 0 ? retryAfter : null);
      }
      case BLOCK_REMOVAL -> {
        java.util.concurrent.CountDownLatch gate = removalGate.get();
        if (gate != null) {
          try {
            if (!gate.await(60, java.util.concurrent.TimeUnit.SECONDS)) {
              throw new PlaidAdapterException(ProviderErrorClass.TRANSIENT);
            }
          } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new PlaidAdapterException(ProviderErrorClass.TRANSIENT);
          }
        }
      }
      default -> {
        if (accessToken == null || !accessToken.startsWith("fake-access-")) {
          throw new PlaidAdapterException(ProviderErrorClass.PERMANENT);
        }
      }
    }
  }

  /** Public-token seed the fake exchange accepts for an attempt. */
  public static String publicTokenFor(UUID attemptId) {
    return "fake-public-" + hex(attemptId, "link");
  }

  private static String hex(UUID attemptId, String purpose) {
    return ConnectionCrypto.sha256Hex(attemptId + "/" + purpose).substring(0, 16);
  }
}
