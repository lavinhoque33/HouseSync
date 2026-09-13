package com.housesync.identity.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class SlidingWindowRateLimiterTest {

  private static final Instant START = Instant.parse("2026-09-12T12:00:00Z");

  private static Clock fixedAt(Instant instant) {
    return Clock.fixed(instant, ZoneOffset.UTC);
  }

  @Test
  void allowsUpToLimitThenReportsRetryAfter() {
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(fixedAt(START), 100);
    for (int i = 0; i < 30; i++) {
      assertThat(limiter.tryAcquire("ip:1", 30, Duration.ofMinutes(1))).isEmpty();
    }
    Optional<Duration> rejected = limiter.tryAcquire("ip:1", 30, Duration.ofMinutes(1));
    assertThat(rejected).isPresent();
    assertThat(rejected.get()).isEqualTo(Duration.ofMinutes(1));
  }

  @Test
  void windowSlidesWithInjectedClockInsteadOfSleeping() {
    MutableClock clock = new MutableClock(START);
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(clock, 100);
    assertThat(limiter.tryAcquire("key", 1, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.tryAcquire("key", 1, Duration.ofMinutes(1))).isPresent();
    clock.advance(Duration.ofSeconds(59));
    assertThat(limiter.tryAcquire("key", 1, Duration.ofMinutes(1))).isPresent();
    clock.advance(Duration.ofSeconds(2));
    assertThat(limiter.tryAcquire("key", 1, Duration.ofMinutes(1))).isEmpty();
  }

  @Test
  void shortWindowRequestsNeverExpireLongWindowBudgetsEarly() {
    MutableClock clock = new MutableClock(START);
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(clock, 100);
    assertThat(limiter.tryAcquire("ip-budget", 1, Duration.ofSeconds(60))).isEmpty();
    assertThat(limiter.tryAcquire("email-budget", 1, Duration.ofSeconds(600))).isEmpty();

    clock.advance(Duration.ofSeconds(61));
    // The 60s budget expired on its own window and is usable again.
    assertThat(limiter.tryAcquire("ip-budget", 1, Duration.ofSeconds(60))).isEmpty();
    // The 600s budget survived the short-window traffic above; it stays rejected.
    assertThat(limiter.tryAcquire("email-budget", 1, Duration.ofSeconds(600))).isPresent();
    assertThat(limiter.trackedKeys()).isEqualTo(2);

    clock.advance(Duration.ofSeconds(540));
    assertThat(limiter.tryAcquire("email-budget", 1, Duration.ofSeconds(600))).isEmpty();
    assertThat(limiter.trackedKeys()).isEqualTo(1);
  }

  @Test
  void fullCapacityFailsClosedInsteadOfEvictingActiveBudgets() {
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(fixedAt(START), 2);
    assertThat(limiter.tryAcquire("key-0", 1, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.tryAcquire("key-1", 1, Duration.ofMinutes(1))).isEmpty();

    // No eviction: the new key is rejected with a valid retry delay inside the window.
    Optional<Duration> rejected = limiter.tryAcquire("key-new", 1, Duration.ofMinutes(1));
    assertThat(rejected).isPresent();
    assertThat(rejected.get()).isPositive().isLessThanOrEqualTo(Duration.ofMinutes(1));
    // Both retained budgets are intact.
    assertThat(limiter.tryAcquire("key-0", 1, Duration.ofMinutes(1))).isPresent();
    assertThat(limiter.tryAcquire("key-1", 1, Duration.ofMinutes(1))).isPresent();
    assertThat(limiter.trackedKeys()).isEqualTo(2);
  }

  @Test
  void keyChurnCannotBypassOrRefreshBudgets() {
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(fixedAt(START), 3);
    assertThat(limiter.tryAcquire("victim", 2, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.tryAcquire("victim", 2, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.tryAcquire("other", 1, Duration.ofMinutes(1))).isEmpty();

    // One slot is still free and goes to the first churn key; everything after that hits
    // full capacity of active budgets, so further churn gains nothing and records nothing.
    assertThat(limiter.tryAcquire("churn-0", 100, Duration.ofMinutes(1))).isEmpty();
    for (int i = 1; i < 50; i++) {
      assertThat(limiter.tryAcquire("churn-" + i, 100, Duration.ofMinutes(1))).isPresent();
    }
    // The victim's budget is unchanged and only the single admitted churn key was retained.
    assertThat(limiter.tryAcquire("victim", 2, Duration.ofMinutes(1))).isPresent();
    assertThat(limiter.trackedKeys()).isEqualTo(3);
  }

  @Test
  void capacityReturnsAfterExpiry() {
    MutableClock clock = new MutableClock(START);
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(clock, 2);
    assertThat(limiter.tryAcquire("key-0", 1, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.tryAcquire("key-1", 1, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.tryAcquire("key-new", 1, Duration.ofMinutes(1))).isPresent();

    clock.advance(Duration.ofSeconds(61));
    assertThat(limiter.trackedKeys()).isZero();
    assertThat(limiter.tryAcquire("key-new", 1, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.tryAcquire("key-0", 1, Duration.ofMinutes(1))).isEmpty();
    assertThat(limiter.trackedKeys()).isEqualTo(2);
  }

  @Test
  void concurrentAttemptsRespectTheLimitAndStayBounded() throws Exception {
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(fixedAt(START), 10_000);
    int threads = 16;
    int perThread = 50;
    AtomicInteger allowed = new AtomicInteger();
    CountDownLatch ready = new CountDownLatch(threads);
    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    try {
      List<Future<?>> futures = new ArrayList<>();
      for (int t = 0; t < threads; t++) {
        final String key = "shared";
        futures.add(
            pool.submit(
                () -> {
                  ready.countDown();
                  start.await(5, TimeUnit.SECONDS);
                  for (int i = 0; i < perThread; i++) {
                    if (limiter.tryAcquire(key, 30, Duration.ofMinutes(1)).isEmpty()) {
                      allowed.incrementAndGet();
                    }
                  }
                  return null;
                }));
      }
      assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
      start.countDown();
      for (Future<?> future : futures) {
        future.get(15, TimeUnit.SECONDS);
      }
    } finally {
      pool.shutdownNow();
    }
    assertThat(allowed.get()).isEqualTo(30);
    assertThat(limiter.trackedKeys()).isEqualTo(1);
  }

  @Test
  void concurrentNewKeysNeverExceedCapacity() throws Exception {
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(fixedAt(START), 64);
    int threads = 16;
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    try {
      List<Future<?>> futures = new ArrayList<>();
      for (int t = 0; t < threads; t++) {
        final int slot = t;
        futures.add(
            pool.submit(
                () -> {
                  for (int i = 0; i < 50; i++) {
                    limiter.tryAcquire("key-" + slot + "-" + i, 1, Duration.ofMinutes(1));
                  }
                  return null;
                }));
      }
      for (Future<?> future : futures) {
        future.get(15, TimeUnit.SECONDS);
      }
    } finally {
      pool.shutdownNow();
    }
    assertThat(limiter.trackedKeys()).isLessThanOrEqualTo(64);
  }

  @Test
  void rejectsInvalidConfiguration() {
    assertThatThrownBy(() -> new SlidingWindowRateLimiter(fixedAt(START), 0))
        .isInstanceOf(IllegalArgumentException.class);
    SlidingWindowRateLimiter limiter = new SlidingWindowRateLimiter(fixedAt(START), 10);
    assertThatThrownBy(() -> limiter.tryAcquire("key", 0, Duration.ofMinutes(1)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  /** Minimal mutable clock so window/expiry boundaries are tested without sleeping. */
  private static final class MutableClock extends Clock {
    private Instant now;

    MutableClock(Instant now) {
      this.now = now;
    }

    void advance(Duration duration) {
      now = now.plus(duration);
    }

    @Override
    public ZoneOffset getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(java.time.ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return now;
    }
  }
}
