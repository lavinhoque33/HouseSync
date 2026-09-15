package com.housesync.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.security.web.authentication.session.SessionAuthenticationStrategy;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfTokenRepository;
import org.springframework.security.web.csrf.XorCsrfTokenRequestAttributeHandler;

/**
 * Session-based security. Health probes and the CSRF bootstrap stay public; registration and
 * login accept anonymous JSON posts guarded by CSRF; {@code /me} needs an authenticated session;
 * logout runs the standard handlers for authenticated and anonymous callers alike. The household
 * routes permit exactly {@code POST /api/households}, {@code GET /api/households}, {@code GET
 * /api/households/{householdId}}, {@code GET /api/households/{householdId}/members}, {@code PATCH
 * /api/households/{householdId}/members/{userId}}, {@code DELETE
 * /api/households/{householdId}/members/{userId}}, and {@code POST
 * /api/households/{householdId}/leave} for authenticated users. Invitations permit
 * exactly {@code POST} and {@code GET /api/households/{householdId}/invitations}, {@code DELETE
 * /api/households/{householdId}/invitations/{invitationId}}, and {@code POST
 * /api/invitations/preview} plus {@code POST /api/invitations/accept} for authenticated users.
 * Every other route stays denied (401 anonymous / 403 authenticated). No CORS allowances, no
 * form/basic login, no remember-me: browsers use the same-origin session cookie plus CSRF header.
 */
@Configuration(proxyBeanMethods = false)
public class SecurityConfiguration {

  @Bean
  SecurityFilterChain securityFilterChain(
      HttpSecurity http,
      CsrfTokenRepository csrfTokens,
      SecurityContextRepository securityContexts,
      SessionAuthenticationStrategy sessionStrategy,
      AuthenticationEntryPoint jsonEntryPoint,
      AccessDeniedHandler jsonDeniedHandler)
      throws Exception {
    return http.authorizeHttpRequests(
            requests ->
                requests
                    .requestMatchers(
                        HttpMethod.GET,
                        "/actuator/health",
                        "/actuator/health/liveness",
                        "/actuator/health/readiness")
                    .permitAll()
                    .requestMatchers(HttpMethod.GET, "/api/auth/csrf")
                    .permitAll()
                    .requestMatchers(
                        HttpMethod.POST,
                        "/api/auth/register",
                        "/api/auth/login",
                        "/api/auth/logout")
                    .permitAll()
                    .requestMatchers(HttpMethod.GET, "/api/auth/me")
                    .authenticated()
                    .requestMatchers(HttpMethod.POST, "/api/households")
                    .authenticated()
                    .requestMatchers(HttpMethod.GET, "/api/households", "/api/households/*")
                    .authenticated()
                    .requestMatchers(HttpMethod.GET, "/api/households/*/members")
                    .authenticated()
                    .requestMatchers(HttpMethod.PATCH, "/api/households/*/members/*")
                    .authenticated()
                    .requestMatchers(HttpMethod.DELETE, "/api/households/*/members/*")
                    .authenticated()
                    .requestMatchers(HttpMethod.POST, "/api/households/*/leave")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.POST,
                        "/api/households/*/invitations",
                        "/api/invitations/preview",
                        "/api/invitations/accept")
                    .authenticated()
                    .requestMatchers(HttpMethod.GET, "/api/households/*/invitations")
                    .authenticated()
                    .requestMatchers(HttpMethod.DELETE, "/api/households/*/invitations/*")
                    .authenticated()
                    .anyRequest()
                    .denyAll())
        .sessionManagement(
            session ->
                session
                    .sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED)
                    .sessionAuthenticationStrategy(sessionStrategy))
        .securityContext(
            security ->
                security.securityContextRepository(securityContexts).requireExplicitSave(true))
        .csrf(
            csrf ->
                csrf.csrfTokenRepository(csrfTokens)
                    .csrfTokenRequestHandler(new XorCsrfTokenRequestAttributeHandler()))
        .requestCache(AbstractHttpConfigurer::disable)
        .formLogin(AbstractHttpConfigurer::disable)
        .httpBasic(AbstractHttpConfigurer::disable)
        .logout(AbstractHttpConfigurer::disable)
        .exceptionHandling(
            exceptions ->
                exceptions
                    .authenticationEntryPoint(jsonEntryPoint)
                    .accessDeniedHandler(jsonDeniedHandler))
        .build();
  }
}
