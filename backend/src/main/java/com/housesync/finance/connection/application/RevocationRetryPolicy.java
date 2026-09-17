package com.housesync.finance.connection.application;

import java.time.Duration;
import java.util.Random;
import org.springframework.stereotype.Component;

/**
 * Bounded revocation retry schedule (connected-finance contract §5): five retries with full jitter
 * over an exponential 5-second base capped at 15 minutes. A valid provider Retry-After delay longer
 * than the jittered value is honored instead.
 */
@Component
public class RevocationRetryPolicy {

  /** Total attempts including the initial try: one initial attempt plus five retries. */
  public static final int MAX_ATTEMPTS = 6;

  private static final long BASE_SECONDS = 5;
  private static final long CAP_SECONDS = 900;

  private final Random random;

  public RevocationRetryPolicy(Random jitter) {
    this.random = jitter;
  }

  /** Whether another attempt is allowed after {@code attemptsSoFar} completed attempts. */
  public boolean mayRetry(int attemptsSoFar) {
    return attemptsSoFar < MAX_ATTEMPTS;
  }

  /**
   * Delay before the next attempt. Full jitter draws uniformly from {@code [0, base]} where {@code
   * base} doubles per attempt from 5 seconds up to 15 minutes.
   */
  public Duration nextDelay(int attemptsSoFar, Long retryAfterSeconds) {
    long shift = Math.min(Math.max(attemptsSoFar - 1, 0), 8);
    long base = Math.min(BASE_SECONDS << shift, CAP_SECONDS);
    long delay = nextLong(base + 1);
    if (retryAfterSeconds != null && retryAfterSeconds > delay) {
      delay = retryAfterSeconds;
    }
    return Duration.ofSeconds(delay);
  }

  /** Uniform draw from {@code [0, bound)}; package-visible for deterministic tests. */
  long nextLong(long bound) {
    if (bound <= 0) {
      return 0;
    }
    return Long.remainderUnsigned(random.nextLong() & Long.MAX_VALUE, bound);
  }
}
