package com.housesync;

import static org.hamcrest.Matchers.containsString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.housesync.finance.account.application.FinancialAccountService;
import com.housesync.finance.activity.application.BankActivityService;
import com.housesync.finance.categorization.application.CategorizationQueryService;
import com.housesync.finance.categorization.application.CategorizationReviewService;
import com.housesync.finance.categorization.application.CategorizationRuleLookup;
import com.housesync.finance.categorization.application.CategorizationRuleService;
import com.housesync.finance.connection.application.ConnectionLifecycleService;
import com.housesync.finance.connection.application.ConnectionLinkService;
import com.housesync.finance.connection.application.ConnectionQueryService;
import com.housesync.finance.connection.application.ConnectionSelectionService;
import com.housesync.finance.connection.application.ConnectionSyncService;
import com.housesync.finance.connection.webhook.WebhookIngressService;
import com.housesync.finance.repayment.RepaymentRepository;
import com.housesync.finance.repayment.RepaymentService;
import com.housesync.finance.report.application.BudgetTargetService;
import com.housesync.finance.report.application.ContributionSummaryService;
import com.housesync.finance.report.application.FinanceReportService;
import com.housesync.finance.report.application.RecurringInsightsService;
import com.housesync.finance.report.application.SpendingInsightsService;
import com.housesync.finance.settlement.SettlementService;
import com.housesync.finance.transaction.application.FinancialAllocationService;
import com.housesync.finance.transaction.application.FinancialTransactionService;
import com.housesync.household.application.HouseholdService;
import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationServiceException;
import com.housesync.household.web.HouseholdMemberResponse;
import com.housesync.household.web.HouseholdResponse;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.application.HouseSyncUserDetailsService;
import com.housesync.identity.application.IdentityGrants;
import com.housesync.identity.application.IdentityService;
import com.housesync.identity.web.AuthExceptionHandler;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootTest(
    properties = {
      "DB_PASSWORD=unit-test-only",
      "spring.autoconfigure.exclude="
          + "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration,"
          + "org.springframework.boot.hibernate.autoconfigure.HibernateJpaAutoConfiguration,"
          + "org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration",
      "management.endpoint.health.group.readiness.include=readinessState"
    })
@AutoConfigureMockMvc
@Import(SecurityConfigurationTest.ProtectedController.class)
class SecurityConfigurationTest {

  @Autowired private MockMvc mvc;
  @MockitoBean private IdentityService identities;
  @MockitoBean private IdentityGrants grants;
  @MockitoBean private HouseSyncUserDetailsService userDetails;
  @MockitoBean private JdbcTemplate jdbc;
  @MockitoBean private HouseholdService households;
  @MockitoBean private InvitationService invitations;
  @MockitoBean private FinancialAccountService financialAccounts;
  @MockitoBean private CategorizationQueryService categorization;
  @MockitoBean private CategorizationReviewService categorizationReviews;

  @MockitoBean
  private com.housesync.finance.categorization.application.CategorizationAiWorkService aiWork;

  @MockitoBean private CategorizationRuleLookup categorizationRuleLookup;
  @MockitoBean private CategorizationRuleService categorizationRules;
  @MockitoBean private FinancialTransactionService financialTransactions;
  @MockitoBean private FinancialAllocationService financialAllocations;
  @MockitoBean private RepaymentRepository repaymentRepository;
  @MockitoBean private RepaymentService repayments;
  @MockitoBean private SettlementService settlements;
  @MockitoBean private FinanceReportService reporting;
  @MockitoBean private ContributionSummaryService contributions;
  @MockitoBean private SpendingInsightsService spendingInsights;
  @MockitoBean private RecurringInsightsService recurringInsights;
  @MockitoBean private BudgetTargetService budgetTargets;
  @MockitoBean private ConnectionLinkService connectionLinks;
  @MockitoBean private ConnectionQueryService connectionQueries;
  @MockitoBean private ConnectionSelectionService connectionSelection;
  @MockitoBean private ConnectionLifecycleService connectionLifecycle;
  @MockitoBean private ConnectionSyncService connectionSync;

  @MockitoBean
  private com.housesync.finance.connection.application.ConnectionSyncDemandRegistrar syncDemand;

  @MockitoBean private BankActivityService bankActivity;
  @MockitoBean private WebhookIngressService webhookIngress;

  @BeforeEach
  @SuppressWarnings("unchecked")
  void allowSyntheticAuthenticatedPrincipals() {
    when(jdbc.query(anyString(), any(ResultSetExtractor.class), any(UUID.class))).thenReturn(true);
  }

  @ParameterizedTest
  @ValueSource(
      strings = {"/actuator/health", "/actuator/health/liveness", "/actuator/health/readiness"})
  void healthIsPublicAndDoesNotExposeDetails(String path) throws Exception {
    mvc.perform(get(path))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("UP"))
        .andExpect(jsonPath("$.components").doesNotExist())
        .andExpect(jsonPath("$.details").doesNotExist());
  }

  @ParameterizedTest
  @CsvSource({
    "GET, /test/protected",
    "GET, /api/unknown",
    "GET, /actuator",
    "GET, /actuator/env",
    "GET, /actuator/health/db",
    "GET, /actuator/health/readiness/db",
    "GET, /login",
    "GET, /api/auth/me",
    "POST, /api/households",
    "GET, /api/households",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/members",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/members/123e4567-e89b-12d3-a456-426614174001",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/members/123e4567-e89b-12d3-a456-426614174001",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/leave",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "DELETE,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/invitations/123e4567-e89b-12d3-a456-426614174001",
    "POST, /api/invitations/preview",
    "POST, /api/invitations/accept",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts/123e4567-e89b-12d3-a456-426614174001",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts/123e4567-e89b-12d3-a456-426614174001",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/transaction-categories",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001/allocation",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001/allocation",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001/allocation",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/member-balances",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/finance-settings",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/finance-settings",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/spending-summary",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/contribution-summary",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/insights/spending-series",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/insights/spending-comparison",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/insights/spending-evidence",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/insights/summary",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/budget-targets",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/budget-targets/123e4567-e89b-12d3-a456-426614174001",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/budget-targets",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/budget-targets/123e4567-e89b-12d3-a456-426614174001",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/insights/budget-progress",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/categorization-ai-work/status",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/connection-link-attempts",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/connection-link-attempts/123e4567-e89b-12d3-a456-426614174001/complete",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/connection-operations/123e4567-e89b-12d3-a456-426614174001",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/accounts",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/account-selection",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/reconnect",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/disconnect",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/sync",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity/123e4567-e89b-12d3-a456-426614174001",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity/123e4567-e89b-12d3-a456-426614174001/confirm",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity/123e4567-e89b-12d3-a456-426614174001/dismiss",
    "POST, /actuator/health",
    "PUT, /actuator/health",
    "PATCH, /actuator/health",
    "DELETE, /actuator/health",
    "HEAD, /actuator/health",
    "OPTIONS, /actuator/health",
    "POST, /actuator/health/liveness",
    "POST, /actuator/health/readiness"
  })
  void anonymousRequestsToUnimplementedRoutesAreUnauthorized(String method, String path)
      throws Exception {
    // A valid CSRF token proves unsafe requests reach authorization (and the JSON entry point).
    mvc.perform(MockMvcRequestBuilders.request(HttpMethod.valueOf(method), path).with(csrf()))
        .andExpect(status().isUnauthorized())
        .andExpect(
            header()
                .string("Content-Type", org.hamcrest.Matchers.containsString("application/json")))
        .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"))
        .andExpect(jsonPath("$.correlationId").exists())
        .andExpect(jsonPath("$.message").exists());
  }

  @ParameterizedTest
  @CsvSource({
    "GET, /test/protected",
    "GET, /api/unknown",
    "POST, /actuator/health",
    "PUT, /api/households",
    "PATCH, /api/households",
    "DELETE, /api/households",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/members",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/members",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/members/123e4567-e89b-12d3-a456-426614174001",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/members/123e4567-e89b-12d3-a456-426614174001",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/members/123e4567-e89b-12d3-a456-426614174001",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/members",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/members",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/leave",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/leave",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/leave",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/invitations/123e4567-e89b-12d3-a456-426614174001",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/invitations/123e4567-e89b-12d3-a456-426614174001",
    "GET, /api/invitations",
    "POST, /api/invitations",
    "GET, /api/invitations/preview",
    "PUT, /api/invitations/preview",
    "DELETE, /api/invitations/preview",
    "GET, /api/invitations/accept",
    "PUT, /api/invitations/accept",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts/123e4567-e89b-12d3-a456-426614174001",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-accounts/123e4567-e89b-12d3-a456-426614174001",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001/allocation",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/transactions/123e4567-e89b-12d3-a456-426614174001/allocation",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/member-balances",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/member-balances",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/member-balances",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/finance-settings",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/finance-settings",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/finance-settings",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/spending-summary",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/spending-summary",
    "PATCH, /api/households/123e4567-e89b-12d3-a456-426614174000/spending-summary",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/spending-summary",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/insights/summary",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/connection-link-attempts",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/connection-link-attempts",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/connection-link-attempts",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/connection-link-attempts/123e4567-e89b-12d3-a456-426614174001",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/connection-link-attempts/123e4567-e89b-12d3-a456-426614174001/complete",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/connection-operations/123e4567-e89b-12d3-a456-426614174001",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/account-selection",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/reconnect",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/disconnect",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/financial-connections/123e4567-e89b-12d3-a456-426614174001/sync",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity/123e4567-e89b-12d3-a456-426614174001/confirm",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/bank-activity/123e4567-e89b-12d3-a456-426614174001/dismiss",
    "GET," + " /api/provider-webhooks/plaid",
    "GET, /api/households/a/b",
  })
  void authenticatedRequestsToUnimplementedRoutesAreForbidden(String method, String path)
      throws Exception {
    mvc.perform(
            MockMvcRequestBuilders.request(HttpMethod.valueOf(method), path)
                .with(user("test-user"))
                .with(csrf()))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("FORBIDDEN"))
        .andExpect(jsonPath("$.correlationId").exists());
  }

  @Test
  void providerWebhookRouteIsPublicCsrfExemptAndSignatureGuarded() throws Exception {
    when(webhookIngress.enabled()).thenReturn(true);
    // No session and no CSRF token reach the exact route; without a valid signature it is a
    // generic 401 from verification, proving authorization is not session based.
    mvc.perform(
            post("/api/provider-webhooks/plaid")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"))
        .andExpect(status().isUnauthorized())
        .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "/api/auth/register",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/recover",
        "/api/auth/password",
        "/api/auth/sessions/revoke"
      })
  void unsafeAuthRequestsWithoutCsrfAreRejectedWithCsrfInvalid(String path) throws Exception {
    mvc.perform(
            post(path)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"email\":\"person@example.test\",\"password\":\"long-enough-password\"}"))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("CSRF_INVALID"))
        .andExpect(jsonPath("$.correlationId").exists());
  }

  @Test
  void anonymousLogoutWithValidCsrfIsSafe() throws Exception {
    mvc.perform(post("/api/auth/logout").with(csrf())).andExpect(status().isNoContent());
  }

  @Test
  void aiWorkStatusRequiresAuthenticationAndPreventsCaching() throws Exception {
    UUID owner = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    String path = "/api/households/" + householdId + "/categorization-ai-work/status";
    when(aiWork.status(eq(householdId), eq(owner)))
        .thenReturn(
            new com.housesync.finance.categorization.application.CategorizationAiWorkService.Status(
                true, 2, 1));
    mvc.perform(get(path))
        .andExpect(status().isUnauthorized())
        .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
    mvc.perform(get(path).with(signedInAs(owner)))
        .andExpect(status().isOk())
        .andExpect(
            header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")));
  }

  @Test
  void authenticatedHouseholdReadsUseMembershipScopedService() throws Exception {
    UUID actorId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    Instant createdAt = Instant.parse("2026-09-13T01:30:00Z");
    HouseholdResponse household =
        new HouseholdResponse(householdId, "Elm Street home", "OWNER", createdAt);
    when(households.list(eq(actorId))).thenReturn(List.of(household));
    when(households.get(eq(householdId), eq(actorId))).thenReturn(household);

    mvc.perform(get("/api/households").with(signedInAs(actorId)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.households[0].id").value(householdId.toString()))
        .andExpect(jsonPath("$.households[0].name").value("Elm Street home"))
        .andExpect(jsonPath("$.households[0].role").value("OWNER"))
        .andExpect(jsonPath("$.households[0].createdAt").value("2026-09-13T01:30:00Z"));

    mvc.perform(get("/api/households/" + householdId).with(signedInAs(actorId)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.id").value(householdId.toString()))
        .andExpect(jsonPath("$.role").value("OWNER"));
  }

  @Test
  void authenticatedHouseholdCreateReturnsCreatedHousehold() throws Exception {
    UUID actorId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    when(households.create(eq("Elm Street home"), eq(actorId)))
        .thenReturn(
            new HouseholdResponse(
                householdId, "Elm Street home", "OWNER", Instant.parse("2026-09-13T01:30:00Z")));
    mvc.perform(
            post("/api/households")
                .with(signedInAs(actorId))
                .with(csrf())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Elm Street home\"}"))
        .andExpect(status().isCreated())
        .andExpect(
            header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
        .andExpect(jsonPath("$.id").value(householdId.toString()))
        .andExpect(jsonPath("$.role").value("OWNER"));
  }

  @Test
  void authenticatedLifecycleRoutesUseMembershipScopedService() throws Exception {
    UUID actorId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    UUID targetId = UUID.randomUUID();
    HouseholdMemberResponse member =
        new HouseholdMemberResponse(targetId, "person@example.test", "MEMBER");
    when(households.listMembers(eq(householdId), eq(actorId))).thenReturn(List.of(member));
    when(households.updateMemberRole(eq(householdId), eq(targetId), eq("MEMBER"), eq(actorId)))
        .thenReturn(member);

    mvc.perform(get("/api/households/" + householdId + "/members").with(signedInAs(actorId)))
        .andExpect(status().isOk())
        .andExpect(header().string("Cache-Control", containsString("no-store")))
        .andExpect(jsonPath("$.members[0].userId").value(targetId.toString()))
        .andExpect(jsonPath("$.members[0].email").value("person@example.test"))
        .andExpect(jsonPath("$.members[0].role").value("MEMBER"));

    mvc.perform(
            patch("/api/households/" + householdId + "/members/" + targetId)
                .with(signedInAs(actorId))
                .with(csrf())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"role\":\"MEMBER\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.role").value("MEMBER"));

    mvc.perform(
            delete("/api/households/" + householdId + "/members/" + targetId)
                .with(signedInAs(actorId))
                .with(csrf()))
        .andExpect(status().isNoContent())
        .andExpect(header().string("Cache-Control", containsString("no-store")));

    mvc.perform(
            post("/api/households/" + householdId + "/leave")
                .with(signedInAs(actorId))
                .with(csrf()))
        .andExpect(status().isNoContent())
        .andExpect(header().string("Cache-Control", containsString("no-store")));

    verify(households).removeMember(householdId, targetId, actorId);
    verify(households).leave(householdId, actorId);
  }

  @Test
  void unsafeHouseholdCreateWithoutCsrfIsRejectedWithCsrfInvalid() throws Exception {
    mvc.perform(
            post("/api/households")
                .with(signedInAs(UUID.randomUUID()))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Elm Street home\"}"))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("CSRF_INVALID"))
        .andExpect(jsonPath("$.correlationId").exists());
  }

  @Test
  void invitationServiceFailureIsSafeInternalError() throws Exception {
    UUID actorId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    when(invitations.create(eq(householdId), eq(actorId)))
        .thenThrow(new InvitationServiceException());
    mvc.perform(
            post("/api/households/" + householdId + "/invitations")
                .with(signedInAs(actorId))
                .with(csrf()))
        .andExpect(status().isInternalServerError())
        .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
        .andExpect(jsonPath("$.correlationId").exists())
        .andExpect(jsonPath("$.message").exists())
        .andExpect(
            header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
        .andExpect(
            content()
                .string(
                    org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.not(
                            org.hamcrest.Matchers.containsString("secret_hash")),
                        org.hamcrest.Matchers.not(
                            org.hamcrest.Matchers.containsString("household_invitations")),
                        org.hamcrest.Matchers.not(
                            org.hamcrest.Matchers.containsString("at com.housesync")))));
  }

  @Test
  void unexpectedFailureLogsOnlyExceptionClassesNeverMessageOrStack() throws Exception {
    UUID actorId = UUID.randomUUID();
    String sentinel = "sentinel-user-value-7f3a";
    doThrow(
            new IllegalStateException(
                "duplicate key value (email)=(" + sentinel + ")",
                new IllegalArgumentException("root " + sentinel)))
        .when(identities)
        .changePassword(eq(actorId), anyString(), anyString());
    Logger handlerLog = (Logger) LoggerFactory.getLogger(AuthExceptionHandler.class);
    ListAppender<ILoggingEvent> appender = new ListAppender<>();
    appender.start();
    handlerLog.addAppender(appender);
    try {
      mvc.perform(
              post("/api/auth/password")
                  .with(signedInAs(actorId))
                  .with(csrf())
                  .contentType(MediaType.APPLICATION_JSON)
                  .content("{\"currentPassword\":\"old-pass-123456\",\"newPassword\":\"x\"}"))
          .andExpect(status().isInternalServerError())
          .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"));
    } finally {
      handlerLog.detachAppender(appender);
    }
    ILoggingEvent failed =
        appender.list.stream()
            .filter(event -> event.getFormattedMessage().contains("auth.request_failed"))
            .findFirst()
            .orElseThrow();
    org.assertj.core.api.Assertions.assertThat(failed.getFormattedMessage())
        .contains("cause=IllegalStateException", "rootCause=IllegalArgumentException")
        .doesNotContain(sentinel);
    org.assertj.core.api.Assertions.assertThat(failed.getThrowableProxy()).isNull();
  }

  private static org.springframework.test.web.servlet.request.RequestPostProcessor signedInAs(
      UUID actorId) {
    HouseSyncUserDetails principal =
        new HouseSyncUserDetails(actorId, "person@example.test", null, 0);
    return authentication(
        new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
            principal, null, List.of()));
  }

  @RestController
  static class ProtectedController {

    @GetMapping("/test/protected")
    String protectedEndpoint() {
      return "must never be exposed";
    }
  }
}
