package com.housesync.identity.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/** Rejects an old JDBC session even when recent activity keeps its idle window alive. */
public final class AbsoluteSessionLifetimeFilter extends OncePerRequestFilter {
  private static final long MAX_AGE_MILLIS = Duration.ofDays(30).toMillis();
  private final Clock clock;

  public AbsoluteSessionLifetimeFilter(Clock clock) {
    this.clock = clock;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    var session = request.getSession(false);
    if (session != null && clock.millis() - session.getCreationTime() >= MAX_AGE_MILLIS) {
      session.invalidate();
      SecurityContextHolder.clearContext();
    }
    chain.doFilter(request, response);
  }
}
