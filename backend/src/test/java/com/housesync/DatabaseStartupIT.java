package com.housesync;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.account.persistence.AccountIdempotencyEntity;
import com.housesync.finance.account.persistence.FinancialAccountEntity;
import com.housesync.finance.transaction.persistence.FinancialAllocationIdempotencyEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationParticipantEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.TransactionIdempotencyEntity;
import com.housesync.household.persistence.HouseholdEntity;
import com.housesync.household.persistence.HouseholdMemberEntity;
import com.housesync.identity.persistence.UserEntity;
import jakarta.persistence.EntityManagerFactory;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class DatabaseStartupIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @DynamicPropertySource
  static void databaseProperties(DynamicPropertyRegistry registry) {
    registry.add("DB_HOST", POSTGRES::getHost);
    registry.add("DB_PORT", POSTGRES::getFirstMappedPort);
    registry.add("DB_NAME", POSTGRES::getDatabaseName);
    registry.add("DB_USER", POSTGRES::getUsername);
    registry.add("DB_PASSWORD", POSTGRES::getPassword);
  }

  @Autowired private JdbcTemplate jdbc;
  @Autowired private Flyway flyway;
  @Autowired private EntityManagerFactory entityManagerFactory;
  @LocalServerPort private int port;

  @Test
  void applicationBootsWithPostgresAndFlywayOwnsIdentityAndSessionTables() {
    assertThat(jdbc.queryForObject("SELECT 1", Integer.class)).isEqualTo(1);
    assertThat(jdbc.queryForObject("SHOW server_version", String.class)).startsWith("17.");
    assertThat(entityManagerFactory.isOpen()).isTrue();
    assertThat(entityManagerFactory.getMetamodel().getEntities())
        .extracting(type -> type.getJavaType().getSimpleName())
        .contains(
            UserEntity.class.getSimpleName(),
            HouseholdEntity.class.getSimpleName(),
            HouseholdMemberEntity.class.getSimpleName(),
            FinancialAccountEntity.class.getSimpleName(),
            AccountIdempotencyEntity.class.getSimpleName(),
            FinancialTransactionEntity.class.getSimpleName(),
            TransactionIdempotencyEntity.class.getSimpleName(),
            FinancialTransactionAllocationEntity.class.getSimpleName(),
            FinancialTransactionAllocationParticipantEntity.class.getSimpleName(),
            FinancialAllocationIdempotencyEntity.class.getSimpleName());
    assertThat(
            jdbc.queryForList(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'", String.class))
        .containsExactlyInAnyOrder(
            "flyway_schema_history",
            "users",
            "spring_session",
            "spring_session_attributes",
            "households",
            "household_members",
            "household_invitations",
            "financial_accounts",
            "financial_account_idempotency_keys",
            "financial_transactions",
            "financial_transaction_idempotency_keys",
            "financial_transaction_allocations",
            "financial_transaction_allocation_participants",
            "financial_allocation_idempotency_keys",
            "financial_connections",
            "financial_connection_account_mappings",
            "connection_link_attempts",
            "connection_operations",
            "connection_operation_idempotency_keys",
            "connection_revocation_work",
            "connection_sync_work",
            "connection_sync_rounds",
            "connection_sync_round_deltas",
            "connection_observations",
            "connection_ledger_associations",
            "provider_webhook_events");
    // Provenance uses composite references so an association cannot mix household, owner,
    // account, or currency between the observation and its ledger entry.
    assertThat(
            jdbc.queryForList(
                "SELECT constraint_name FROM information_schema.table_constraints"
                    + " WHERE table_name = 'connection_ledger_associations'"
                    + " AND constraint_type = 'FOREIGN KEY'",
                String.class))
        .contains(
            "connection_ledger_associations_observation_reference",
            "connection_ledger_associations_account_reference",
            "connection_ledger_associations_transaction_reference");
    assertThat(flyway.info().applied()).hasSize(14);
    flyway.validate();
    assertThat(flyway.migrate().migrationsExecuted).isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM users WHERE email = 'nobody@example.test'", Integer.class))
        .isZero();
  }

  @Test
  void runningServerExposesHealthyProbesAndDeniesUnknownApiAccess() throws Exception {
    try (HttpClient client =
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
      for (String path :
          new String[] {
            "/actuator/health", "/actuator/health/liveness", "/actuator/health/readiness"
          }) {
        HttpResponse<String> response = get(client, path);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body())
            .contains("\"status\":\"UP\"")
            .doesNotContain("components", "details");
      }
      // Unimplemented routes stay denied: 401 for anonymous callers.
      assertThat(get(client, "/api/unknown").statusCode()).isEqualTo(401);
    }
  }

  private HttpResponse<String> get(HttpClient client, String path) throws Exception {
    return client.send(
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
            .timeout(Duration.ofSeconds(10))
            .GET()
            .build(),
        HttpResponse.BodyHandlers.ofString());
  }
}
