package com.housesync.identity.ratelimit;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Iterator;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Bounded in-memory sliding-window limiter.
 *
 * <p>Single-process abuse prevention: at most {@code maxKeys} distinct keys are retained, callers
 * inject the {@link Clock} so windows and expiry are unit-testable without sleeping, and all state
 * changes happen under one monitor so concurrent servlet requests are safe.
 *
 * <p>Each bucket keeps the limit and window it was created with, and every prune uses the owning
 * bucket's window — a short-window request can never expire a long-window budget early. Only
 * truly-expired state is removed. When capacity is full of active keys, new keys fail closed with a
 * valid retry delay instead of evicting someone else's budget (churn cannot refresh a victim's
 * allowance nor grant the churner access).
 */
public final class SlidingWindowRateLimiter {

  private final Clock clock;
  private final int maxKeys;
  private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

  /** One key's budget. The captured limit/window govern the bucket for its lifetime. */
  private static final class Bucket {
    final Deque<Instant> attempts = new ArrayDeque<>();
    final int limit;
    final Duration window;

    Bucket(int limit, Duration window) {
      this.limit = limit;
      this.window = window;
    }

    /**
     * Drops expired attempts using this bucket's own window.
     *
     * @return true when no active attempt remains.
     */
    boolean prune(Instant now) {
      while (!attempts.isEmpty() && !attempts.peekFirst().plus(window).isAfter(now)) {
        attempts.pollFirst();
      }
      return attempts.isEmpty();
    }
  }

  public SlidingWindowRateLimiter(Clock clock, int maxKeys) {
    if (maxKeys < 1) {
      throw new IllegalArgumentException("maxKeys must be positive");
    }
    this.clock = clock;
    this.maxKeys = maxKeys;
  }

  /**
   * Records an attempt for {@code key} when the sliding window allows it. The requested
   * limit/window apply to new keys; an existing bucket always keeps its own configuration.
   *
   * @return empty when the attempt is allowed; otherwise how long the caller must wait before
   *     retrying. Rejected attempts are not recorded.
   */
  public synchronized Optional<Duration> tryAcquire(String key, int limit, Duration window) {
    if (limit < 1) {
      throw new IllegalArgumentException("limit must be positive");
    }
    Instant now = clock.instant();
    Bucket bucket = buckets.get(key);
    if (bucket != null) {
      if (bucket.prune(now)) {
        buckets.remove(key, bucket);
        bucket = null;
      }
    }
    if (bucket != null) {
      if (bucket.attempts.size() >= bucket.limit) {
        return Optional.of(retryAfter(now, bucket));
      }
      bucket.attempts.addLast(now);
      return Optional.empty();
    }
    pruneAll(now);
    if (buckets.size() >= maxKeys) {
      return Optional.of(earliestFreeSlot(now));
    }
    Bucket created = new Bucket(limit, window);
    created.attempts.addLast(now);
    buckets.put(key, created);
    return Optional.empty();
  }

  /**
   * Returns one previously acquired attempt to {@code key}'s budget, for callers that reserve a
   * slot before work whose outcome decides whether the attempt counts. The newest attempt is
   * removed; with overlapping reservations on one key that may be a concurrent caller's equal slot,
   * shifting expiry by at most the overlap. A key without active attempts is left untouched.
   */
  public synchronized void release(String key) {
    Bucket bucket = buckets.get(key);
    if (bucket == null) {
      return;
    }
    bucket.attempts.pollLast();
    if (bucket.prune(clock.instant())) {
      buckets.remove(key, bucket);
    }
  }

  public synchronized int trackedKeys() {
    pruneAll(clock.instant());
    return buckets.size();
  }

  private void pruneAll(Instant now) {
    Iterator<Map.Entry<String, Bucket>> entries = buckets.entrySet().iterator();
    while (entries.hasNext()) {
      if (entries.next().getValue().prune(now)) {
        entries.remove();
      }
    }
  }

  private static Duration retryAfter(Instant now, Bucket bucket) {
    Duration retry = Duration.between(now, bucket.attempts.peekFirst().plus(bucket.window));
    if (retry.isNegative() || retry.isZero()) {
      retry = Duration.ofSeconds(1);
    }
    return retry;
  }

  /**
   * Earliest moment any retained slot frees, so a fail-closed rejection still carries a valid
   * {@code Retry-After}. Every retained bucket holds at least one active attempt after pruning.
   */
  private Duration earliestFreeSlot(Instant now) {
    Duration earliest = null;
    for (Bucket bucket : buckets.values()) {
      if (bucket.attempts.isEmpty()) {
        continue;
      }
      Duration freeIn = Duration.between(now, bucket.attempts.peekFirst().plus(bucket.window));
      if (freeIn.isNegative() || freeIn.isZero()) {
        continue;
      }
      if (earliest == null || freeIn.compareTo(earliest) < 0) {
        earliest = freeIn;
      }
    }
    return earliest != null ? earliest : Duration.ofSeconds(1);
  }
}
