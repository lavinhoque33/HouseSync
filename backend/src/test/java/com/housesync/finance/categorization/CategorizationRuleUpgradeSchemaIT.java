package com.housesync.finance.categorization;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.util.Properties;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * V15-to-V16 upgrade proof on real PostgreSQL: every supported prior schema upgrades through the
 * retained owner-rule table without rewriting any ledger category, version, or timestamp, and the
 * upgraded schema carries the rule surfaces the application requires.
 */
@Testcontainers
class CategorizationRuleUpgradeSchemaIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void v15DatabaseUpgradesToV16WithoutRewritingLedgerRows() throws Exception {
    runMigrations("15");
    UUID userId;
    UUID householdId;
    UUID accountId;
    UUID entryId;
    UUID refundSourceId;
    String categoryBefore;
    int versionBefore;
    Timestamp updatedAtBefore;
    Timestamp sourceUpdatedAtBefore;
    try (Connection connection = openConnection()) {
      userId = insertUser(connection);
      householdId = insertHousehold(connection, userId);
      accountId = insertAccount(connection, householdId, userId);
      entryId = insertTransaction(connection, householdId, userId, accountId, "EXPENSE", "-5.00");
      jdbcUpdate(
          connection,
          "UPDATE financial_transactions SET category = 'GROCERIES' WHERE id = '" + entryId + "'");
      // The refund references its expense directly so the V7 refund-field pairing holds.
      refundSourceId = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
              + " amount, currency, occurred_on, description, source, visibility, status,"
              + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
              + " version, created_at, updated_at)"
              + " VALUES (?, ?, ?, ?, 'REFUND', 1.00, 'BRL', DATE '2026-09-17', 'Upgrade refund',"
              + " 'MANUAL', 'PRIVATE', 'POSTED', ?, 'GROCERIES', 'INHERITED',"
              + " CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          refundSourceId,
          householdId,
          userId,
          accountId,
          entryId);
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT category, version, updated_at FROM financial_transactions WHERE id = ?")) {
        rows.setObject(1, entryId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          categoryBefore = result.getString(1);
          versionBefore = result.getInt(2);
          updatedAtBefore = result.getTimestamp(3);
        }
      }
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT updated_at FROM financial_transactions WHERE id = ?")) {
        rows.setObject(1, refundSourceId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          sourceUpdatedAtBefore = result.getTimestamp(1);
        }
      }
    }
    runMigrations(null);
    try (Connection connection = openConnection()) {
      // The categorized expense is untouched by V16: category, version, timestamp, provenance.
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT category, version, updated_at, category_origin, category_rule_id,"
                  + " category_assigned_at IS NOT NULL FROM financial_transactions WHERE id = ?")) {
        rows.setObject(1, entryId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          assertThat(result.getString(1)).isEqualTo(categoryBefore);
          assertThat(result.getInt(2)).isEqualTo(versionBefore);
          assertThat(result.getTimestamp(3)).isEqualTo(updatedAtBefore);
          assertThat(result.getString(4)).isEqualTo("LEGACY");
          assertThat(result.getObject(5)).isNull();
          assertThat(result.getBoolean(6)).isTrue();
        }
      }
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT updated_at, category_origin FROM financial_transactions WHERE id = ?")) {
        rows.setObject(1, refundSourceId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          assertThat(result.getTimestamp(1)).isEqualTo(sourceUpdatedAtBefore);
          assertThat(result.getString(2)).isEqualTo("INHERITED");
        }
      }
      // The upgraded schema carries the retained rule surfaces for the application.
      assertThat(
              queryString(
                  connection,
                  "SELECT count(*) FROM information_schema.tables"
                      + " WHERE table_name = 'categorization_rules'"))
          .isEqualTo("1");
      assertThat(
              queryString(
                  connection,
                  "SELECT count(*) FROM information_schema.tables"
                      + " WHERE table_name = 'categorization_rule_idempotency_keys'"))
          .isEqualTo("1");
    }
  }

  private static void runMigrations(String target) {
    var configurer =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration");
    if (target != null) {
      configurer.target(target);
    }
    configurer.load().migrate();
  }

  private Connection openConnection() throws Exception {
    Properties credentials = new Properties();
    credentials.setProperty("user", POSTGRES.getUsername());
    credentials.setProperty("password", POSTGRES.getPassword());
    return DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
  }

  private UUID insertUser(Connection connection) throws Exception {
    UUID userId = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO users (id, email, password_hash, created_at)"
            + " VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        userId,
        "catruleupgrade"
            + UUID.randomUUID().toString().replace("-", "").substring(0, 6)
            + "@example.test",
        "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000");
    return userId;
  }

  private UUID insertHousehold(Connection connection, UUID userId) throws Exception {
    UUID householdId = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO households (id, name, created_at)" + " VALUES (?, ?, CURRENT_TIMESTAMP)",
        householdId,
        "Rule upgrade home");
    jdbcUpdate(
        connection,
        "INSERT INTO household_members (household_id, user_id, role)" + " VALUES (?, ?, 'OWNER')",
        householdId,
        userId);
    return householdId;
  }

  private UUID insertAccount(Connection connection, UUID householdId, UUID userId)
      throws Exception {
    UUID accountId = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_accounts (id, household_id, owner_user_id, name, kind, currency,"
            + " source, visibility, status, version, created_at, updated_at)"
            + " VALUES (?, ?, ?, 'Rule account', 'CHECKING', 'BRL', 'MANUAL', 'PRIVATE',"
            + " 'ACTIVE', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        accountId,
        householdId,
        userId);
    return accountId;
  }

  private UUID insertTransaction(
      Connection connection,
      UUID householdId,
      UUID userId,
      UUID accountId,
      String kind,
      String amount)
      throws Exception {
    UUID id = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
            + " amount, currency, occurred_on, description, source, visibility, status,"
            + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
            + " version, created_at, updated_at)"
            + " VALUES (?, ?, ?, ?, ?, ?::numeric, 'BRL', DATE '2026-09-16', 'Upgrade entry',"
            + " 'MANUAL', 'PRIVATE', 'POSTED', NULL, NULL, 'LEGACY', CURRENT_TIMESTAMP,"
            + " 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        id,
        householdId,
        userId,
        accountId,
        kind,
        amount);
    return id;
  }

  private void jdbcUpdate(Connection connection, String sql, Object... parameters)
      throws Exception {
    try (PreparedStatement statement = connection.prepareStatement(sql)) {
      for (int index = 0; index < parameters.length; index++) {
        statement.setObject(index + 1, parameters[index]);
      }
      assertThat(statement.executeUpdate()).isEqualTo(1);
    }
  }

  private String queryString(Connection connection, String sql) throws Exception {
    try (java.sql.Statement statement = connection.createStatement();
        ResultSet result = statement.executeQuery(sql)) {
      assertThat(result.next()).isTrue();
      return result.getString(1);
    }
  }
}
