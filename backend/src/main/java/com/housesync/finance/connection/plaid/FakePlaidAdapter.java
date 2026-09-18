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
  private final java.util.concurrent.ConcurrentHashMap<
          String, java.util.concurrent.ConcurrentLinkedQueue<PlaidAdapter.SyncPage>>
      syncPages = new java.util.concurrent.ConcurrentHashMap<>();
  private final java.util.concurrent.ConcurrentHashMap<String, AtomicReference<ProviderErrorClass>>
      nextSyncFailure = new java.util.concurrent.ConcurrentHashMap<>();
  private final java.util.concurrent.ConcurrentHashMap<String, AtomicReference<Boolean>>
      runtimeSyncFailures = new java.util.concurrent.ConcurrentHashMap<>();
  private final java.util.concurrent.ConcurrentHashMap<String, ProviderErrorClass>
      scheduledSyncFailures = new java.util.concurrent.ConcurrentHashMap<>();
  private final java.util.concurrent.ConcurrentHashMap<String, List<String>> syncCursorLog =
      new java.util.concurrent.ConcurrentHashMap<>();
  private final AtomicReference<java.util.concurrent.CountDownLatch> linkTokenGate =
      new AtomicReference<>(null);
  private final java.util.concurrent.ConcurrentHashMap<String, AtomicLong> syncCallCounts =
      new java.util.concurrent.ConcurrentHashMap<>();
  private final java.util.concurrent.ConcurrentHashMap<String, PlaidAdapter.VerificationKey>
      verificationKeys = new java.util.concurrent.ConcurrentHashMap<>();
  private final AtomicReference<ProviderErrorClass> keyFetchFailure = new AtomicReference<>(null);
  private final java.util.concurrent.ConcurrentHashMap<String, AtomicLong> keyFetchCounts =
      new java.util.concurrent.ConcurrentHashMap<>();
  private final java.util.concurrent.ConcurrentLinkedQueue<java.util.concurrent.CountDownLatch>
      syncGates = new java.util.concurrent.ConcurrentLinkedQueue<>();

  public FakePlaidAdapter(Clock clock) {
    this.clock = clock;
  }

  /** Test-only queued sync pages, consumed in order; an empty queue yields an empty page. */
  public void enqueueSyncPage(String accessToken, PlaidAdapter.SyncPage page) {
    syncPages
        .computeIfAbsent(accessToken, ignored -> new java.util.concurrent.ConcurrentLinkedQueue<>())
        .add(page);
  }

  /** Test-only one-shot sync failure; consumed by the next fetch call. */
  public void failNextSync(String accessToken, ProviderErrorClass errorClass) {
    nextSyncFailure
        .computeIfAbsent(accessToken, ignored -> new AtomicReference<>())
        .set(errorClass);
  }

  /**
   * Test-only one-shot unchecked sync failure (not a normalized provider error). Proves that an
   * unexpected worker fault never bypasses lease-fence authority checks.
   */
  public void failNextSyncWithRuntimeException(String accessToken) {
    runtimeSyncFailures
        .computeIfAbsent(accessToken, ignored -> new AtomicReference<>(Boolean.FALSE))
        .set(Boolean.TRUE);
  }

  /** Test-only failure scheduled for the Nth fetch call (1-based) of the access token. */
  public void failSyncOnCall(String accessToken, long callNumber, ProviderErrorClass errorClass) {
    scheduledSyncFailures.put(accessToken + "#" + callNumber, errorClass);
  }

  /** Test-only queue reset so a simulated provider replay starts from a clean page list. */
  public void clearSyncPages(String accessToken) {
    java.util.concurrent.ConcurrentLinkedQueue<SyncPage> queue = syncPages.get(accessToken);
    if (queue != null) {
      queue.clear();
    }
  }

  /** Cursors passed to each fetch call in order; the empty string stands for the initial cursor. */
  public List<String> syncCursors(String accessToken) {
    List<String> log = syncCursorLog.get(accessToken);
    return log == null ? List.of() : List.copyOf(log);
  }

  /** Test-only verification JWK registration keyed by kid. */
  public void registerVerificationKey(PlaidAdapter.VerificationKey key) {
    verificationKeys.put(key.keyId(), key);
  }

  /** Test-only key-infrastructure outage; reset with {@code null}. */
  public void setKeyFetchFailure(ProviderErrorClass errorClass) {
    keyFetchFailure.set(errorClass);
  }

  /**
   * Test-only Link-token gate: the next createLinkToken call waits for the latch. It holds the
   * winner inside the provider call after its idempotency reservation commits, which
   * deterministically exposes the reserved-attempt-without-token window to concurrent same-key
   * starters.
   */
  public void setLinkTokenGate(java.util.concurrent.CountDownLatch gate) {
    linkTokenGate.set(gate);
  }

  /**
   * Test-only sync gate: each queued latch blocks exactly one fetch until released (FIFO), which
   * enables deterministic multi-worker interleaving for fence and demand tests.
   */
  public void setSyncGate(java.util.concurrent.CountDownLatch gate) {
    if (gate == null) {
      syncGates.clear();
      return;
    }
    syncGates.add(gate);
  }

  public long syncCallCount(String accessToken) {
    AtomicLong counter = syncCallCounts.get(accessToken);
    return counter == null ? 0 : counter.get();
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
    java.util.concurrent.CountDownLatch gate = linkTokenGate.getAndSet(null);
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

  @Override
  public SyncPage fetchTransactionChanges(String accessToken, String cursor) {
    if (accessToken == null || !accessToken.startsWith("fake-access-")) {
      throw new PlaidAdapterException(ProviderErrorClass.PERMANENT);
    }
    java.util.concurrent.CountDownLatch gate = syncGates.poll();
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
    AtomicReference<ProviderErrorClass> failure = nextSyncFailure.get(accessToken);
    if (failure != null) {
      ProviderErrorClass injected = failure.getAndSet(null);
      if (injected != null) {
        throw new PlaidAdapterException(injected);
      }
    }
    AtomicReference<Boolean> runtimeFailure = runtimeSyncFailures.get(accessToken);
    if (runtimeFailure != null && Boolean.TRUE.equals(runtimeFailure.getAndSet(Boolean.FALSE))) {
      throw new IllegalStateException("fake provider runtime failure");
    }
    long calls =
        syncCallCounts.computeIfAbsent(accessToken, ignored -> new AtomicLong()).incrementAndGet();
    syncCursorLog
        .computeIfAbsent(
            accessToken,
            ignored -> java.util.Collections.synchronizedList(new java.util.ArrayList<>()))
        .add(cursor == null ? "" : cursor);
    ProviderErrorClass scheduled = scheduledSyncFailures.remove(accessToken + "#" + calls);
    if (scheduled != null) {
      throw new PlaidAdapterException(scheduled);
    }
    java.util.concurrent.ConcurrentLinkedQueue<SyncPage> queue = syncPages.get(accessToken);
    if (queue != null) {
      SyncPage page = queue.poll();
      if (page != null) {
        return page;
      }
    }
    String next =
        "fake-cursor-" + ConnectionCrypto.sha256Hex(accessToken).substring(0, 12) + "-" + calls;
    return new SyncPage(List.of(), List.of(), next, false, true);
  }

  @Override
  public VerificationKey fetchVerificationKey(String keyId) {
    keyFetchCounts.computeIfAbsent(keyId, ignored -> new AtomicLong()).incrementAndGet();
    ProviderErrorClass failure = keyFetchFailure.get();
    if (failure != null) {
      throw new PlaidAdapterException(failure);
    }
    VerificationKey key = verificationKeys.get(keyId);
    if (key == null) {
      throw new PlaidAdapterException(ProviderErrorClass.PERMANENT);
    }
    return key;
  }

  /** Test-only fetch counter for key-cache assertions. */
  public long keyFetchCount(String keyId) {
    AtomicLong counter = keyFetchCounts.get(keyId);
    return counter == null ? 0 : counter.get();
  }

  /** Test-only key removal to prove cached verification keys survive a provider outage. */
  public void clearVerificationKeys() {
    verificationKeys.clear();
  }

  private static String hex(UUID attemptId, String purpose) {
    return ConnectionCrypto.sha256Hex(attemptId + "/" + purpose).substring(0, 16);
  }
}
