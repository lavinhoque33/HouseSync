package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.connection.application.RevocationRetryPolicy;
import java.time.Duration;
import java.util.Random;
import org.junit.jupiter.api.Test;

class RevocationRetryPolicyTest {

  @Test
  void allowsFiveRetriesBeyondTheInitialAttempt() {
    RevocationRetryPolicy policy = new RevocationRetryPolicy(new Random(7));
    for (int attempts = 0; attempts < RevocationRetryPolicy.MAX_ATTEMPTS; attempts++) {
      assertThat(policy.mayRetry(attempts)).isTrue();
    }
    assertThat(policy.mayRetry(RevocationRetryPolicy.MAX_ATTEMPTS)).isFalse();
    assertThat(policy.mayRetry(100)).isFalse();
  }

  @Test
  void fullJitterStaysWithinExponentialBoundsAndIsDeterministic() {
    long[] bases = {5, 10, 20, 40, 80, 160};
    for (int attempt = 1; attempt <= bases.length; attempt++) {
      RevocationRetryPolicy first = new RevocationRetryPolicy(new Random(42));
      RevocationRetryPolicy second = new RevocationRetryPolicy(new Random(42));
      Duration one = null;
      for (int i = 1; i < attempt; i++) {
        first.nextDelay(i, null);
        second.nextDelay(i, null);
      }
      one = first.nextDelay(attempt, null);
      Duration two = second.nextDelay(attempt, null);
      assertThat(one).isEqualTo(two);
      assertThat(one.getSeconds()).isBetween(0L, bases[attempt - 1]);
    }
  }

  @Test
  void exponentialBaseCapsAtFifteenMinutes() {
    RevocationRetryPolicy policy = new RevocationRetryPolicy(new Random(3));
    for (int attempt = 1; attempt <= 20; attempt++) {
      assertThat(policy.nextDelay(attempt, null).getSeconds()).isBetween(0L, 900L);
    }
  }

  @Test
  void longerRetryAfterWinsOverJitter() {
    RevocationRetryPolicy policy = new RevocationRetryPolicy(new Random(11));
    assertThat(policy.nextDelay(1, 120L)).isEqualTo(Duration.ofSeconds(120));
    Duration shortHeader = policy.nextDelay(1, 1L);
    assertThat(shortHeader.getSeconds()).isBetween(0L, 5L);
    assertThat(policy.nextDelay(1, null).getSeconds()).isBetween(0L, 5L);
    assertThat(policy.nextDelay(1, -5L).getSeconds()).isBetween(0L, 5L);
  }
}
