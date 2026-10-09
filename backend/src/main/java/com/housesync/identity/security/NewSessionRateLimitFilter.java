package com.housesync.identity.security;

import com.housesync.identity.ratelimit.SessionCreationLimiter;
import com.housesync.identity.web.CorrelationIds;
import com.housesync.identity.web.ErrorCodes;
import com.housesync.identity.web.IdentityExceptions.RateLimitedException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

/**
 * Single enforcement point for the per-source new-session budget. It runs inside Spring Session's
 * filter (so a valid session cookie is already resolved) and before the security chain, and wraps
 * the request so that only a call that would <em>create</em> a session (CSRF token bootstrap, or
 * the CSRF token a rejected write generates) spends budget. Requests that already have a session,
 * and anonymous requests that never create one, are untouched. A refused creation throws a {@link
 * RateLimitedException} before Spring Session persists anything; the controller advice answers it
 * inside the dispatcher and this filter answers it when raised by the security chain, both with the
 * standard 429 {@code RATE_LIMITED} problem response.
 */
@Component
@Order(NewSessionRateLimitFilter.ORDER)
public class NewSessionRateLimitFilter extends OncePerRequestFilter {

  /** After Spring Session's repository filter, before the Spring Security chain (-100). */
  static final int ORDER = -110;

  private static final Logger log = LoggerFactory.getLogger(NewSessionRateLimitFilter.class);

  private final SessionCreationLimiter limiter;
  private final ObjectMapper objectMapper;

  public NewSessionRateLimitFilter(SessionCreationLimiter limiter, ObjectMapper objectMapper) {
    this.limiter = limiter;
    this.objectMapper = objectMapper;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    try {
      chain.doFilter(new Guarded(request), response);
    } catch (RateLimitedException exceeded) {
      if (response.isCommitted()) {
        throw exceeded;
      }
      reject(response, exceeded.getRetryAfterSeconds());
    }
  }

  private void reject(HttpServletResponse response, long retryAfterSeconds) throws IOException {
    String correlationId = CorrelationIds.newId();
    log.warn(
        "event=auth.rate_limited code={} correlationId={}", ErrorCodes.RATE_LIMITED, correlationId);
    response.resetBuffer();
    response.setStatus(429);
    response.setHeader("Retry-After", Long.toString(retryAfterSeconds));
    response.setHeader("Cache-Control", "no-store");
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    objectMapper.writeValue(
        response.getOutputStream(),
        Map.of(
            "code",
            ErrorCodes.RATE_LIMITED,
            "message",
            "Too many attempts. Retry later.",
            "correlationId",
            correlationId));
  }

  private final class Guarded extends HttpServletRequestWrapper {
    Guarded(HttpServletRequest request) {
      super(request);
    }

    @Override
    public HttpSession getSession() {
      return getSession(true);
    }

    @Override
    public HttpSession getSession(boolean create) {
      HttpServletRequest delegate = (HttpServletRequest) getRequest();
      HttpSession existing = delegate.getSession(false);
      if (existing != null || !create) {
        return existing;
      }
      Optional<Duration> retry = limiter.checkSessionCreation(delegate.getRemoteAddr());
      if (retry.isPresent()) {
        throw new RateLimitedException(Math.max(1L, (retry.get().toMillis() + 999L) / 1000L));
      }
      return delegate.getSession(true);
    }
  }
}
