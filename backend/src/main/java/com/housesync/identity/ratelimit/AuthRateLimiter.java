package com.housesync.identity.ratelimit;

import java.time.Clock;
import java.time.Duration;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Authentication throttling: 30 registration/login/recovery attempts per source address per minute
 * plus 10 failed login attempts per canonical email per 10 minutes.
 *
 * <p>Attempts are counted before password hashing work. The source address is the servlet {@code
 * request.getRemoteAddr()}: Tomcat's RemoteIpValve resolves it from {@code X-Forwarded-For} only
 * when the direct peer is a configured internal proxy ({@code server.tomcat.remoteip.*}), so a
 * direct untrusted peer's forwarded headers are ignored. A per-email login slot is reserved before
 * authentication (so concurrent guesses cannot overshoot the limit) and handed back when the
 * credentials verify, so successful sign-ins never consume the failure budget. State is
 * process-local; a distributed policy is required before a multi-instance deployment.
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

  /**
   * Reserves one slot of the per-email failed-login budget before authentication. Pair a successful
   * authentication with {@link #releaseLoginEmail(String)}; a failure keeps the reservation.
   */
  public Optional<Duration> checkLoginEmail(String canonicalEmail) {
    return limiter.tryAcquire(
        loginEmailKey(canonicalEmail), loginEmailMaxAttempts, loginEmailWindow);
  }

  /** Hands back the slot reserved by {@link #checkLoginEmail(String)} after a successful login. */
  public void releaseLoginEmail(String canonicalEmail) {
    limiter.release(loginEmailKey(canonicalEmail));
  }

  private static String loginEmailKey(String canonicalEmail) {
    return "login-email:" + canonicalEmail;
  }
}
