package com.housesync.household;

import static org.assertj.core.api.Assertions.assertThat;

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
 * Proves the V3 to V7 upgrade path: migrate identity/session-only history, seed a user, a
 * household, a membership, and a session row the way a live deployment holds them, then apply V4-V7
 * step by step and confirm household, invitation, private-account, and private-transaction tables
 * with prior data intact.
 */
@Testcontainers
class HouseholdSchemaUpgradeIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void v3DatabaseUpgradesToV7WithIdentitySessionAndHouseholdDataPreserved() throws Exception {
    Properties credentials = new Properties();
    credentials.setProperty("user", POSTGRES.getUsername());
    credentials.setProperty("password", POSTGRES.getPassword());

    Flyway v3 =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .target("3")
            .load();
    assertThat(v3.migrate().migrationsExecuted).isEqualTo(3);

    UUID userId = UUID.randomUUID();
    String email =
        "upgrade"
            + UUID.randomUUID().toString().replace("-", "").substring(0, 12)
            + "@example.test";
    String sessionId = UUID.randomUUID().toString();
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement user =
            connection.prepareStatement(
                "INSERT INTO users (id, email, password_hash, created_at)"
                    + " VALUES (?, ?, ?, CURRENT_TIMESTAMP)");
        PreparedStatement session =
            connection.prepareStatement(
                "INSERT INTO spring_session (primary_id, session_id, creation_time,"
                    + " last_access_time, max_inactive_interval, expiry_time, principal_name)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?)")) {
      user.setObject(1, userId);
      user.setString(2, email);
      user.setString(3, "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000");
      assertThat(user.executeUpdate()).isEqualTo(1);
      session.setString(1, UUID.randomUUID().toString());
      session.setString(2, sessionId);
      session.setLong(3, System.currentTimeMillis());
      session.setLong(4, System.currentTimeMillis());
      session.setInt(5, 1800);
      session.setLong(6, System.currentTimeMillis() + 1_800_000L);
      session.setString(7, email);
      assertThat(session.executeUpdate()).isEqualTo(1);
    }

    Flyway v4 =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .target("4")
            .load();
    assertThat(v4.migrate().migrationsExecuted).isEqualTo(1);
    v4.validate();
    assertThat(v4.info().applied()).hasSize(4);

    UUID householdId = UUID.randomUUID();
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement household =
            connection.prepareStatement(
                "INSERT INTO households (id, name, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
        PreparedStatement membership =
            connection.prepareStatement(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?, ?, 'OWNER')")) {
      household.setObject(1, householdId);
      household.setString(2, "Elm Street home");
      assertThat(household.executeUpdate()).isEqualTo(1);
      membership.setObject(1, householdId);
      membership.setObject(2, userId);
      assertThat(membership.executeUpdate()).isEqualTo(1);
    }

    Flyway current =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .load();
    assertThat(current.migrate().migrationsExecuted).isEqualTo(11);
    current.validate();
    assertThat(current.info().applied()).hasSize(15);

    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials)) {
      try (PreparedStatement user =
          connection.prepareStatement("SELECT email FROM users WHERE id = ?")) {
        user.setObject(1, userId);
        try (ResultSet rows = user.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getString(1)).isEqualTo(email);
        }
      }
      try (PreparedStatement session =
          connection.prepareStatement(
              "SELECT principal_name FROM spring_session WHERE session_id = ?")) {
        session.setString(1, sessionId);
        try (ResultSet rows = session.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getString(1)).isEqualTo(email);
        }
      }
      try (ResultSet tables =
          connection
              .getMetaData()
              .getTables(null, "public", "household%", new String[] {"TABLE"})) {
        assertThat(tableNames(tables))
            .containsExactlyInAnyOrder("households", "household_members", "household_invitations");
      }
      try (ResultSet tables =
          connection
              .getMetaData()
              .getTables(null, "public", "financial_account%", new String[] {"TABLE"})) {
        assertThat(tableNames(tables))
            .containsExactlyInAnyOrder("financial_accounts", "financial_account_idempotency_keys");
      }
      assertThat(constraintExists(connection, "households_name_length")).isTrue();
      assertThat(constraintExists(connection, "households_name_trimmed")).isTrue();
      assertThat(constraintExists(connection, "households_name_nonblank")).isTrue();
      assertThat(constraintExists(connection, "households_name_no_controls")).isTrue();
      assertThat(constraintExists(connection, "household_members_pk")).isTrue();
      assertThat(constraintExists(connection, "household_members_role_check")).isTrue();
      assertThat(constraintExists(connection, "household_invitations_secret_hash_length")).isTrue();
      assertThat(constraintExists(connection, "household_invitations_expiry_check")).isTrue();
      assertThat(constraintExists(connection, "household_invitations_acceptance_paired")).isTrue();
      assertThat(constraintExists(connection, "household_invitations_terminal_exclusive")).isTrue();
      assertThat(constraintExists(connection, "financial_accounts_name_trimmed")).isTrue();
      assertThat(constraintExists(connection, "financial_accounts_currency_check")).isTrue();
      assertThat(constraintExists(connection, "financial_accounts_status_check")).isTrue();
      assertThat(constraintExists(connection, "financial_account_idempotency_keys_pk")).isTrue();
      try (PreparedStatement index =
          connection.prepareStatement(
              "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public'"
                  + " AND tablename = 'household_members'"
                  + " AND indexname = 'household_members_actor_idx'")) {
        try (ResultSet rows = index.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getInt(1)).isEqualTo(1);
        }
      }
      try (PreparedStatement index =
          connection.prepareStatement(
              "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public'"
                  + " AND tablename = 'household_invitations'"
                  + " AND indexname = 'household_invitations_active_list_idx'")) {
        try (ResultSet rows = index.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getInt(1)).isEqualTo(1);
        }
      }
      // V4-seeded household data survives the V5 upgrade.
      try (PreparedStatement household =
          connection.prepareStatement("SELECT name FROM households WHERE id = ?")) {
        household.setObject(1, householdId);
        try (ResultSet rows = household.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getString(1)).isEqualTo("Elm Street home");
        }
      }
      try (PreparedStatement membership =
          connection.prepareStatement(
              "SELECT role FROM household_members WHERE household_id = ? AND user_id = ?")) {
        membership.setObject(1, householdId);
        membership.setObject(2, userId);
        try (ResultSet rows = membership.executeQuery()) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getString(1)).isEqualTo("OWNER");
        }
      }
    }
  }

  private static java.util.List<String> tableNames(ResultSet tables) throws Exception {
    java.util.List<String> names = new java.util.ArrayList<>();
    while (tables.next()) {
      names.add(tables.getString("TABLE_NAME"));
    }
    return names;
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
