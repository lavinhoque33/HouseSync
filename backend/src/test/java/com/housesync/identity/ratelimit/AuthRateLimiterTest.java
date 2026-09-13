package com.housesync.identity.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class AuthRateLimiterTest {

  private static AuthRateLimiter limiter() {
    return new AuthRateLimiter(
        Clock.fixed(Instant.parse("2026-09-12T12:00:00Z"), ZoneOffset.UTC), 3, 60, 2, 600);
  }

  @Test
  void sourceAddressBudgetIsSharedByRegistrationAndLogin() {
    AuthRateLimiter limiter = limiter();
    assertThat(limiter.checkSourceAddress("10.0.0.1")).isEmpty();
    assertThat(limiter.checkSourceAddress("10.0.0.1")).isEmpty();
    assertThat(limiter.checkSourceAddress("10.0.0.1")).isEmpty();
    assertThat(limiter.checkSourceAddress("10.0.0.1")).isPresent();
    // A different address has its own budget.
    assertThat(limiter.checkSourceAddress("10.0.0.2")).isEmpty();
  }

  @Test
  void loginEmailBudgetIsIndependentFromAddressBudget() {
    AuthRateLimiter limiter = limiter();
    assertThat(limiter.checkLoginEmail("person@example.test")).isEmpty();
    assertThat(limiter.checkLoginEmail("person@example.test")).isEmpty();
    assertThat(limiter.checkLoginEmail("person@example.test")).isPresent();
    // Other identifiers are unaffected, and the address bucket was never touched.
    assertThat(limiter.checkLoginEmail("other@example.test")).isEmpty();
    assertThat(limiter.checkSourceAddress("10.0.0.9")).isEmpty();
  }
}
