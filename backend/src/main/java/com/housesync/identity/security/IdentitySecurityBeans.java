package com.housesync.identity.security;

import com.housesync.identity.application.HouseSyncUserDetailsService;
import com.housesync.identity.web.CorrelationIds;
import com.housesync.identity.web.ErrorCodes;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.security.web.authentication.logout.CompositeLogoutHandler;
import org.springframework.security.web.authentication.logout.CookieClearingLogoutHandler;
import org.springframework.security.web.authentication.logout.LogoutHandler;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import org.springframework.security.web.authentication.session.ChangeSessionIdAuthenticationStrategy;
import org.springframework.security.web.authentication.session.CompositeSessionAuthenticationStrategy;
import org.springframework.security.web.authentication.session.SessionAuthenticationStrategy;
import org.springframework.security.web.context.DelegatingSecurityContextRepository;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfAuthenticationStrategy;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.CsrfLogoutHandler;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.security.web.csrf.XorCsrfTokenRequestAttributeHandler;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;
import tools.jackson.databind.ObjectMapper;

/**
 * Identity/security beans: password hashing, session-backed CSRF, login session strategy, logout
 * handlers, the explicit session cookie, and JSON authentication/denial entry points.
 */
@Configuration(proxyBeanMethods = false)
public class IdentitySecurityBeans {

  /**
   * Delegating encoder defaulting to bcrypt cost 12. Stored hashes carry the {@code {bcrypt}}
   * prefix; overlength input is rejected by validation rather than silently truncated by bcrypt.
   */
  @Bean
  PasswordEncoder passwordEncoder() {
    DelegatingPasswordEncoder encoder =
        new DelegatingPasswordEncoder("bcrypt", Map.of("bcrypt", new BCryptPasswordEncoder(12)));
    encoder.setDefaultPasswordEncoderForMatches(new BCryptPasswordEncoder(12));
    return encoder;
  }

  @Bean
  Clock systemClock() {
    return Clock.systemUTC();
  }

  @Bean
  AuthenticationManager authenticationManager(
      HouseSyncUserDetailsService userDetails, PasswordEncoder encoder) {
    DaoAuthenticationProvider provider = new DaoAuthenticationProvider(userDetails);
    provider.setPasswordEncoder(encoder);
    return new ProviderManager(provider);
  }

  /** Session-backed CSRF tokens using framework defaults (header {@code X-CSRF-TOKEN}). */
  @Bean
  CsrfTokenRepository csrfTokenRepository() {
    return new HttpSessionCsrfTokenRepository();
  }

  /**
   * Explicit-save security context storage: request attribute plus HTTP session (which Spring
   * Session persists to PostgreSQL). Mirrors the filter chain default and is shared by the login
   * controller and the logout handlers.
   */
  @Bean
  SecurityContextRepository securityContextRepository() {
    return new DelegatingSecurityContextRepository(
        new RequestAttributeSecurityContextRepository(),
        new HttpSessionSecurityContextRepository());
  }

  /**
   * Fixation protection (rotates the session id on login) plus CSRF token rotation. The login
   * controller invokes this <em>before</em> explicitly saving the new security context.
   */
  @Bean
  SessionAuthenticationStrategy sessionAuthenticationStrategy(CsrfTokenRepository csrfTokens) {
    CsrfAuthenticationStrategy csrf = new CsrfAuthenticationStrategy(csrfTokens);
    csrf.setRequestHandler(new XorCsrfTokenRequestAttributeHandler());
    return new CompositeSessionAuthenticationStrategy(
        List.of(new ChangeSessionIdAuthenticationStrategy(), csrf));
  }

  /**
   * Standard logout: clears the security context and invalidates the server-side session, clears
   * the CSRF token, and clears the session cookie. Tolerates anonymous callers.
   */
  @Bean
  LogoutHandler logoutHandlers(
      SecurityContextRepository securityContexts, CsrfTokenRepository csrfTokens) {
    SecurityContextLogoutHandler contexts = new SecurityContextLogoutHandler();
    contexts.setSecurityContextRepository(securityContexts);
    return new CompositeLogoutHandler(
        contexts, new CsrfLogoutHandler(csrfTokens), new CookieClearingLogoutHandler("SESSION"));
  }

  /**
   * Explicit session cookie: {@code SESSION}, path {@code /}, HttpOnly, {@code SameSite=Lax}, no
   * Domain attribute. The Secure flag follows {@code SESSION_COOKIE_SECURE} (default true;
   * development over plain HTTP supplies false).
   */
  @Bean
  CookieSerializer cookieSerializer(
      @Value("${app.session-cookie-secure:true}") boolean secureCookie) {
    DefaultCookieSerializer serializer = new DefaultCookieSerializer();
    serializer.setCookieName("SESSION");
    serializer.setCookiePath("/");
    serializer.setUseHttpOnlyCookie(true);
    serializer.setSameSite("Lax");
    serializer.setUseSecureCookie(secureCookie);
    return serializer;
  }

  /** Anonymous protected access returns JSON 401 instead of a redirect or login page. */
  @Bean
  AuthenticationEntryPoint jsonAuthenticationEntryPoint(ObjectMapper objectMapper) {
    return (request, response, failure) ->
        writeError(
            objectMapper,
            response,
            HttpServletResponse.SC_UNAUTHORIZED,
            ErrorCodes.UNAUTHENTICATED,
            "Authentication is required.");
  }

  /**
   * Authenticated denial returns JSON 403; missing/invalid CSRF tokens return the distinct {@code
   * CSRF_INVALID} code.
   */
  @Bean
  AccessDeniedHandler jsonAccessDeniedHandler(ObjectMapper objectMapper) {
    return (request, response, failure) -> {
      if (failure instanceof CsrfException) {
        writeError(
            objectMapper,
            response,
            HttpServletResponse.SC_FORBIDDEN,
            ErrorCodes.CSRF_INVALID,
            "CSRF token is missing or invalid.");
      } else {
        writeError(
            objectMapper,
            response,
            HttpServletResponse.SC_FORBIDDEN,
            ErrorCodes.FORBIDDEN,
            "Access is denied.");
      }
    };
  }

  private static void writeError(
      ObjectMapper objectMapper,
      HttpServletResponse response,
      int status,
      String code,
      String message)
      throws IOException {
    String correlationId = CorrelationIds.newId();
    org.slf4j.LoggerFactory.getLogger(IdentitySecurityBeans.class)
        .warn("event=security.denied code={} correlationId={}", code, correlationId);
    response.setStatus(status);
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    response.setHeader("Cache-Control", "no-store");
    objectMapper.writeValue(
        response.getOutputStream(),
        Map.of("code", code, "message", message, "correlationId", correlationId));
  }
}
