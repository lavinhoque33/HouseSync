package com.housesync.identity.ratelimit;

import java.time.Clock;
import java.time.Duration;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Bounds how many new HTTP sessions one source address may create: 30 per 10 minutes by default.
 *
 * <p>Every new session is a persisted {@code SPRING_SESSION} row that lives until its 30-minute
 * idle timeout, so an anonymous client that never presents a session cookie could otherwise grow
 * the table without limit. Requests that carry a valid session never reach this limiter. The budget
 * allows a household sharing one NAT address (a few devices, each signing in and out several times)
 * while capping one source at a few dozen live rows per session lifetime. The source address is
 * {@code request.getRemoteAddr()}, with the same trust rules as {@link AuthRateLimiter}. State is
 * process-local.
 */
@Component
public class SessionCreationLimiter {

  private final SlidingWindowRateLimiter limiter;
  private final int maxCreations;
  private final Duration window;

  public SessionCreationLimiter(
      Clock clock,
      @Value("${app.auth.session-max-creations:30}") int maxCreations,
      @Value("${app.auth.session-window-seconds:600}") long windowSeconds) {
    this.limiter = new SlidingWindowRateLimiter(clock, AuthRateLimiter.MAX_KEYS);
    this.maxCreations = maxCreations;
    this.window = Duration.ofSeconds(windowSeconds);
  }

  /** Records one session creation for the source; a present value is the required wait. */
  public Optional<Duration> checkSessionCreation(String remoteAddr) {
    return limiter.tryAcquire("session:" + remoteAddr, maxCreations, window);
  }
}
