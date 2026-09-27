package com.housesync.identity.security;

import com.housesync.identity.application.HouseSyncUserDetails;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/** Fences persisted principals against account disablement and credentials revoked after login. */
public final class SessionGenerationFilter extends OncePerRequestFilter {
  private final JdbcTemplate jdbc;

  public SessionGenerationFilter(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    var authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication != null
        && authentication.isAuthenticated()
        && authentication.getPrincipal() instanceof HouseSyncUserDetails principal) {
      Boolean current =
          jdbc.query(
              "SELECT access_disabled, session_generation FROM users WHERE id = ?",
              rs ->
                  rs.next()
                      && !rs.getBoolean(1)
                      && rs.getLong(2) == principal.getSessionGeneration(),
              principal.getId());
      if (!Boolean.TRUE.equals(current)) {
        var session = request.getSession(false);
        if (session != null) session.invalidate();
        SecurityContextHolder.clearContext();
      }
    }
    chain.doFilter(request, response);
  }
}
