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
 * /api/invitations/preview} plus {@code POST /api/invitations/accept} for authenticated users. The
 * finance routes permit exactly the private-account routes and the transaction {@code POST} and
 * {@code GET /api/households/{householdId}/transactions}, {@code GET
 * /api/households/{householdId}/transactions/{transactionId}}, and {@code PATCH
 * /api/households/{householdId}/transactions/{transactionId}} for authenticated users. Categories add
 * the fixed {@code GET /api/households/{householdId}/transaction-categories} list. Categorization provenance adds
 * exactly {@code GET /api/households/{householdId}/transactions/{transactionId}/categorization},
 * the financial-owner-only provenance detail behind service-level owner scoping. Owner rules add
 * exactly {@code POST
 * /api/households/{householdId}/transactions/{transactionId}/categorization-rule}, {@code GET
 * /api/households/{householdId}/categorization-rules}, and {@code PATCH
 * /api/households/{householdId}/categorization-rules/{ruleId}} — the owner-private exact-rule
 * surface behind household + financial-owner service scoping. Allocations add singular allocation
 * routes {@code POST}/{@code GET}/{@code PATCH
 * /api/households/{householdId}/transactions/{transactionId}/allocation} and the bounded {@code GET
 * /api/households/{householdId}/member-balances}. Reporting adds {@code GET} and {@code PATCH
 * /api/households/{householdId}/finance-settings} and the bounded {@code GET
 * /api/households/{householdId}/spending-summary}. Connected finance adds exactly the link, operation,
 * and connection routes under {@code /api/households/{householdId}}: {@code POST
 * connection-link-attempts} and its {@code complete} subpath, {@code GET connection-operations
 * ...}, {@code GET financial-connections} with detail and {@code accounts} reads, plus {@code POST}
 * {@code account-selection}, {@code reconnect}, and {@code disconnect} actions for authenticated
 * users. Every other route stays denied (401 anonymous / 403 authenticated). No CORS allowances, no
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
                    .requestMatchers(HttpMethod.POST, "/api/households/*/financial-accounts")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.GET,
                        "/api/households/*/financial-accounts",
                        "/api/households/*/financial-accounts/*")
                    .authenticated()
                    .requestMatchers(HttpMethod.PATCH, "/api/households/*/financial-accounts/*")
                    .authenticated()
                    .requestMatchers(HttpMethod.POST, "/api/households/*/transactions")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.GET,
                        "/api/households/*/transactions",
                        "/api/households/*/transactions/*",
                        // Owner-only provenance detail; service authorization is
                        // owner-scoped so members receive the generic transaction 404.
                        "/api/households/*/transactions/*/categorization",
                        "/api/households/*/transaction-categories",
                        "/api/households/*/finance-settings",
                        "/api/households/*/spending-summary")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.PATCH,
                        "/api/households/*/transactions/*",
                        "/api/households/*/finance-settings")
                    .authenticated()
                    // Owner-private exact rules — the learn action on one owned
                    // transaction, the private management list, and the category/deactivation
                    // patch. Service authorization is household + financial-owner scoped.
                    .requestMatchers(
                        HttpMethod.POST, "/api/households/*/transactions/*/categorization-rule")
                    .authenticated()
                    .requestMatchers(HttpMethod.GET, "/api/households/*/categorization-rules")
                    .authenticated()
                    .requestMatchers(HttpMethod.PATCH, "/api/households/*/categorization-rules/*")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.GET,
                        "/api/households/*/categorization-reviews",
                        "/api/households/*/categorization-reviews/*")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.GET, "/api/households/*/categorization-ai-work/status")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.POST, "/api/households/*/categorization-reviews/*/resolve")
                    .authenticated()
                    .requestMatchers(HttpMethod.POST, "/api/households/*/transactions/*/allocation")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.POST, "/api/households/*/transactions/*/allocation/preview")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.GET,
                        "/api/households/*/transactions/*/allocation",
                        "/api/households/*/member-balances",
                        "/api/households/*/settlement-suggestions")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.PATCH, "/api/households/*/transactions/*/allocation")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.GET,
                        "/api/households/*/repayments",
                        "/api/households/*/repayments/*",
                        "/api/households/*/repayments/*/events")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.POST,
                        "/api/households/*/repayments",
                        "/api/households/*/repayments/*/decision",
                        "/api/households/*/repayments/*/amendment",
                        "/api/households/*/repayments/*/amendment/decision")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.POST,
                        "/api/households/*/connection-link-attempts",
                        "/api/households/*/connection-link-attempts/*/complete",
                        "/api/households/*/financial-connections/*/account-selection",
                        "/api/households/*/financial-connections/*/reconnect",
                        "/api/households/*/financial-connections/*/sync",
                        "/api/households/*/financial-connections/*/disconnect")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.GET,
                        "/api/households/*/connection-operations/*",
                        "/api/households/*/financial-connections",
                        "/api/households/*/financial-connections/*",
                        "/api/households/*/financial-connections/*/accounts",
                        "/api/households/*/bank-activity",
                        "/api/households/*/bank-activity/*")
                    .authenticated()
                    .requestMatchers(
                        HttpMethod.POST,
                        "/api/households/*/bank-activity/*/confirm",
                        "/api/households/*/bank-activity/*/dismiss",
                        "/api/households/*/bank-activity/*/resolve",
                        "/api/households/*/bank-activity/*/replace-ledger")
                    .authenticated()
                    // The only session/CSRF-exempt provider endpoint; verification is signature
                    // based and the exact route is also bounded by the admission filter.
                    .requestMatchers(HttpMethod.POST, "/api/provider-webhooks/plaid")
                    .permitAll()
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
                    .ignoringRequestMatchers("/api/provider-webhooks/plaid")
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
