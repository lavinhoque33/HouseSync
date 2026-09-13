package com.housesync.identity.web;

import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.application.IdentityService;
import com.housesync.identity.domain.EmailPolicy;
import com.housesync.identity.domain.PasswordPolicy;
import com.housesync.identity.ratelimit.AuthRateLimiter;
import com.housesync.identity.web.AuthRequests.LoginRequest;
import com.housesync.identity.web.AuthRequests.RegisterRequest;
import com.housesync.identity.web.IdentityExceptions.InvalidCredentialsException;
import com.housesync.identity.web.IdentityExceptions.RateLimitedException;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.logout.LogoutHandler;
import org.springframework.security.web.authentication.session.SessionAuthenticationStrategy;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Session-based authentication endpoints. All unsafe methods require a CSRF token (enforced by the
 * security filter chain before these handlers run); payloads are same-origin JSON and responses are
 * not cacheable. No credentials, hashes, or bearer tokens ever enter browser storage.
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

  private final IdentityService identities;
  private final AuthenticationManager authenticationManager;
  private final SessionAuthenticationStrategy sessionStrategy;
  private final SecurityContextRepository securityContexts;
  private final LogoutHandler logoutHandlers;
  private final AuthRateLimiter rateLimiter;

  public AuthController(
      IdentityService identities,
      AuthenticationManager authenticationManager,
      SessionAuthenticationStrategy sessionStrategy,
      SecurityContextRepository securityContexts,
      LogoutHandler logoutHandlers,
      AuthRateLimiter rateLimiter) {
    this.identities = identities;
    this.authenticationManager = authenticationManager;
    this.sessionStrategy = sessionStrategy;
    this.securityContexts = securityContexts;
    this.logoutHandlers = logoutHandlers;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Returns the session-backed CSRF token and its header name. The token comes from the request
   * exposure (XOR/BREACH-masked by the filter chain); when it is missing the endpoint fails safe
   * instead of publishing a raw repository token.
   */
  @GetMapping("/csrf")
  public ResponseEntity<CsrfResponse> csrf(CsrfToken token) {
    if (token == null) {
      throw new IllegalStateException("CSRF token unavailable.");
    }
    return noCache(HttpStatus.OK, new CsrfResponse(token.getToken(), token.getHeaderName()));
  }

  /**
   * Creates an account and returns the safe user DTO with 201. Registration never authenticates:
   * the client proceeds to sign in explicitly.
   */
  @PostMapping(value = "/register", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<SafeUserResponse> register(
      @RequestBody(required = false) RegisterRequest body, HttpServletRequest request) {
    checkSourceAddress(request);
    if (body == null) {
      throw new ValidationFailedException(Map.of("email", "Check the supplied details."));
    }
    return noCache(HttpStatus.CREATED, identities.register(body.email(), body.password()));
  }

  /**
   * Authenticates with email/password. The safe identity is resolved before any session state is
   * mutated, so a failure there never leaves a persisted authentication behind. On success the
   * session id is rotated and the CSRF token renewed <em>before</em> the new security context is
   * explicitly saved to the shared session repository, then the safe user DTO is returned with 200.
   * Failures use one generic 401.
   */
  @PostMapping(value = "/login", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<SafeUserResponse> login(
      @RequestBody(required = false) LoginRequest body,
      HttpServletRequest request,
      HttpServletResponse response) {
    checkSourceAddress(request);
    if (body == null) {
      throw new ValidationFailedException(Map.of("email", "Check the supplied details."));
    }
    Map<String, String> fieldErrors = new LinkedHashMap<>();
    EmailPolicy.violation(body.email()).ifPresent(message -> fieldErrors.put("email", message));
    PasswordPolicy.loginViolation(body.password())
        .ifPresent(message -> fieldErrors.put("password", message));
    if (!fieldErrors.isEmpty()) {
      throw new ValidationFailedException(fieldErrors);
    }
    String canonical = EmailPolicy.normalize(body.email());
    checkLoginEmail(canonical);
    Authentication attempt = new UsernamePasswordAuthenticationToken(canonical, body.password());
    Authentication authenticated;
    try {
      authenticated = authenticationManager.authenticate(attempt);
    } catch (AuthenticationException failure) {
      throw new InvalidCredentialsException(failure);
    }
    HouseSyncUserDetails principal = (HouseSyncUserDetails) authenticated.getPrincipal();
    SafeUserResponse safeUser = identities.resolve(principal.getId());
    // The hash served its single provider comparison; it must never reach the stored session.
    principal.eraseCredentials();
    // Fixation protection and CSRF rotation first, explicit context save second.
    sessionStrategy.onAuthentication(authenticated, request, response);
    SecurityContext securityContext = SecurityContextHolder.createEmptyContext();
    securityContext.setAuthentication(authenticated);
    SecurityContextHolder.setContext(securityContext);
    securityContexts.saveContext(securityContext, request, response);
    return noCache(HttpStatus.OK, safeUser);
  }

  /** Returns the current safe identity, or 401 when the session holds none. */
  @GetMapping("/me")
  public ResponseEntity<SafeUserResponse> me(Authentication authentication) {
    HouseSyncUserDetails principal = principal(authentication);
    return noCache(HttpStatus.OK, identities.resolve(principal.getId()));
  }

  /**
   * Invalidates the server-side session, clears the session cookie and CSRF token, and returns 204.
   * Safe for an already-anonymous session with a valid CSRF token.
   */
  @PostMapping("/logout")
  public ResponseEntity<Void> logout(
      HttpServletRequest request, HttpServletResponse response, Authentication authentication) {
    logoutHandlers.logout(request, response, authentication);
    return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
  }

  private HouseSyncUserDetails principal(Authentication authentication) {
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal)) {
      throw new UnauthenticatedException();
    }
    return principal;
  }

  private void checkSourceAddress(HttpServletRequest request) {
    Optional<Duration> retry = rateLimiter.checkSourceAddress(request.getRemoteAddr());
    if (retry.isPresent()) {
      throw new RateLimitedException(toSeconds(retry.get()));
    }
  }

  private void checkLoginEmail(String canonicalEmail) {
    Optional<Duration> retry = rateLimiter.checkLoginEmail(canonicalEmail);
    if (retry.isPresent()) {
      throw new RateLimitedException(toSeconds(retry.get()));
    }
  }

  private static long toSeconds(Duration retryAfter) {
    return Math.max(1L, (retryAfter.toMillis() + 999L) / 1000L);
  }

  private static <T> ResponseEntity<T> noCache(HttpStatus status, T body) {
    return ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }
}
