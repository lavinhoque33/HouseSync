package com.housesync.identity.ratelimit;

import java.time.Clock;
import java.time.Duration;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Authentication throttling: 30 registration/login attempts per source address
 * per minute plus 10 login attempts per canonical email per 10 minutes.
 *
 * <p>Attempts are counted before password hashing work. Only the direct connection address ({@code
 * request.getRemoteAddr()}) is used; arbitrary forwarded headers are never trusted. Behind the
 * current proxy the address bucket can be shared by users, so a trusted-edge/distributed policy is
 * required before a public multi-instance deployment.
 */
@Component
public class AuthRateLimiter {

  static final int MAX_KEYS = 10_000;

  private final SlidingWindowRateLimiter limiter;
  private final int ipMaxAttempts;
  private final Duration ipWindow;
  private final int loginEmailMaxAttempts;
  private final Duration loginEmailWindow;

  public AuthRateLimiter(
      Clock clock,
      @Value("${app.auth.ip-max-attempts:30}") int ipMaxAttempts,
      @Value("${app.auth.ip-window-seconds:60}") long ipWindowSeconds,
      @Value("${app.auth.login-email-max-attempts:10}") int loginEmailMaxAttempts,
      @Value("${app.auth.login-email-window-seconds:600}") long loginEmailWindowSeconds) {
    this.limiter = new SlidingWindowRateLimiter(clock, MAX_KEYS);
    this.ipMaxAttempts = ipMaxAttempts;
    this.ipWindow = Duration.ofSeconds(ipWindowSeconds);
    this.loginEmailMaxAttempts = loginEmailMaxAttempts;
    this.loginEmailWindow = Duration.ofSeconds(loginEmailWindowSeconds);
  }

  /** Shared registration+login budget per source address. */
  public Optional<Duration> checkSourceAddress(String remoteAddr) {
    return limiter.tryAcquire("ip:" + remoteAddr, ipMaxAttempts, ipWindow);
  }

  /** Login budget per canonical identifier. */
  public Optional<Duration> checkLoginEmail(String canonicalEmail) {
    return limiter.tryAcquire(
        "login-email:" + canonicalEmail, loginEmailMaxAttempts, loginEmailWindow);
  }
}
