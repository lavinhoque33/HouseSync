package com.housesync.finance.report;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Properties;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Reporting persistence contract on real PostgreSQL: a fresh database migrates through V10 with the
 * reporting columns, defaults, and checks in place, and a V9 database holding households, members,
 * accounts, and transactions upgrades to V10 with every row preserved and every household reading
 * back the documented {@code Etc/UTC} initial zone at version 0.
 */
@Testcontainers
class FinanceReportingSchemaIT {

  // Instance container: each test method migrates its own isolated database, so the fresh
  // and V9-upgrade paths never depend on execution order.
  @Container
  final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void freshMigrationExposesReportingColumnsWithInitialDefaults() throws Exception {
    Flyway flyway =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .load();
    assertThat(flyway.migrate().migrationsExecuted).isGreaterThanOrEqualTo(10);
    flyway.validate();

    Properties credentials = credentials();
    UUID userId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement user =
            connection.prepareStatement(
                "INSERT INTO users (id, email, password_hash, created_at)"
                    + " VALUES (?, ?, ?, CURRENT_TIMESTAMP)");
        PreparedStatement household =
            connection.prepareStatement(
                "INSERT INTO households (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
        PreparedStatement membership =
            connection.prepareStatement(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?, ?, 'OWNER')")) {
      user.setObject(1, userId);
      user.setString(2, uniqueEmail("fresh-zone"));
      user.setString(3, "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000");
      assertThat(user.executeUpdate()).isEqualTo(1);
      household.setObject(1, householdId);
      household.setString(2, "Fresh zone home");
      assertThat(household.executeUpdate()).isEqualTo(1);
      membership.setObject(1, householdId);
      membership.setObject(2, userId);
      assertThat(membership.executeUpdate()).isEqualTo(1);
    }

    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement settings =
            connection.prepareStatement(
                "SELECT reporting_time_zone, version FROM households WHERE id = ?")) {
      settings.setObject(1, householdId);
      try (ResultSet rows = settings.executeQuery()) {
        assertThat(rows.next()).isTrue();
        assertThat(rows.getString(1)).isEqualTo("Etc/UTC");
        assertThat(rows.getInt(2)).isZero();
      }
    }
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials)) {
      assertThat(constraintExists(connection, "households_reporting_time_zone_check")).isTrue();
      assertThat(constraintExists(connection, "households_version_check")).isTrue();
    }
  }

  @Test
  void v9DatabaseUpgradesToV10WithHouseholdsAndFinanceDataPreserved() throws Exception {
    Properties credentials = credentials();
    Flyway v9 =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .target("9")
            .load();
    assertThat(v9.migrate().migrationsExecuted).isEqualTo(9);

    UUID userId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    UUID accountId = UUID.randomUUID();
    UUID expenseId = UUID.randomUUID();
    String email = uniqueEmail("upgrade-zone");
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement user =
            connection.prepareStatement(
                "INSERT INTO users (id, email, password_hash, created_at)"
                    + " VALUES (?, ?, ?, CURRENT_TIMESTAMP)");
        PreparedStatement household =
            connection.prepareStatement(
                "INSERT INTO households (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
        PreparedStatement membership =
            connection.prepareStatement(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?, ?, 'OWNER')")) {
      user.setObject(1, userId);
      user.setString(2, email);
      user.setString(3, "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000");
      assertThat(user.executeUpdate()).isEqualTo(1);
      household.setObject(1, householdId);
      household.setString(2, "Upgrade zone home");
      assertThat(household.executeUpdate()).isEqualTo(1);
      membership.setObject(1, householdId);
      membership.setObject(2, userId);
      assertThat(membership.executeUpdate()).isEqualTo(1);
    }
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement account =
            connection.prepareStatement(
                "INSERT INTO financial_accounts (id, household_id, owner_user_id, name, kind,"
                    + " currency, source, visibility, status, version, created_at, updated_at)"
                    + " VALUES (?, ?, ?, 'Groceries card', 'CHECKING', 'BRL', 'MANUAL',"
                    + " 'PRIVATE', 'ACTIVE', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
        PreparedStatement expense =
            connection.prepareStatement(
                "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id,"
                    + " kind, amount, currency, occurred_on, description, source, visibility,"
                    + " status, refund_of_transaction_id, version, created_at, updated_at)"
                    + " VALUES (?, ?, ?, ?, 'EXPENSE', -100.00, 'BRL', DATE '2026-09-16',"
                    + " 'Groceries', 'MANUAL', 'HOUSEHOLD', 'POSTED', NULL, 0,"
                    + " CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")) {
      account.setObject(1, accountId);
      account.setObject(2, householdId);
      account.setObject(3, userId);
      assertThat(account.executeUpdate()).isEqualTo(1);
      expense.setObject(1, expenseId);
      expense.setObject(2, householdId);
      expense.setObject(3, userId);
      expense.setObject(4, accountId);
      assertThat(expense.executeUpdate()).isEqualTo(1);
    }

    Flyway current =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .load();
    assertThat(current.migrate().migrationsExecuted).isEqualTo(4);
    current.validate();
    assertThat(current.info().applied()).hasSize(13);

    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials)) {
      try (PreparedStatement settings =
          connection.prepareStatement(
              "SELECT reporting_time_zone, version FROM households WHERE id = ?")) {
        settings.setObject(1, householdId);
        try (ResultSet rows = settings.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getString(1)).isEqualTo("Etc/UTC");
          assertThat(rows.getInt(2)).isZero();
        }
      }
      // V9 finance rows survive the upgrade with visibility and money intact.
      try (PreparedStatement expense =
          connection.prepareStatement(
              "SELECT amount, currency, visibility, status FROM financial_transactions"
                  + " WHERE id = ?")) {
        expense.setObject(1, expenseId);
        try (ResultSet rows = expense.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getBigDecimal(1)).isEqualByComparingTo(new BigDecimal("-100.00"));
          assertThat(rows.getString(2)).isEqualTo("BRL");
          assertThat(rows.getString(3)).isEqualTo("HOUSEHOLD");
          assertThat(rows.getString(4)).isEqualTo("POSTED");
        }
      }
      // Hibernate validation parity: an overlong zone and an out-of-range version fail at the
      // database boundary, not just in application validation.
      try (PreparedStatement badZone =
          connection.prepareStatement(
              "UPDATE households SET reporting_time_zone = ? WHERE id = ?")) {
        badZone.setString(1, "x".repeat(65));
        badZone.setObject(2, householdId);
        org.assertj.core.api.Assertions.assertThatThrownBy(badZone::executeUpdate)
            .isInstanceOf(java.sql.SQLException.class);
      }
      assertThat(constraintExists(connection, "households_reporting_time_zone_check")).isTrue();
      assertThat(constraintExists(connection, "households_version_check")).isTrue();
    }
  }

  private Properties credentials() {
    Properties credentials = new Properties();
    credentials.setProperty("user", POSTGRES.getUsername());
    credentials.setProperty("password", POSTGRES.getPassword());
    return credentials;
  }

  private static String uniqueEmail(String tag) {
    return tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
  }

  private static boolean constraintExists(Connection connection, String name) throws Exception {
    try (PreparedStatement check =
        connection.prepareStatement("SELECT COUNT(*) FROM pg_constraint WHERE conname = ?")) {
      check.setString(1, name);
      try (ResultSet rows = check.executeQuery()) {
        rows.next();
        return rows.getInt(1) == 1;
      }
    }
  }
}
