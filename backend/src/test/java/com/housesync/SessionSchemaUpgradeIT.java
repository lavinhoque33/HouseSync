package com.housesync;

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
 * Proves the V2 upgrade path on a database that already ran the first two migrations (as main's
 * local development database did): migrate only to V2, seed a session row the way an existing
 * deployment holds one, then apply V3-V7 and confirm the widened column with data intact.
 */
@Testcontainers
class SessionSchemaUpgradeIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void v2DatabaseUpgradesToV3WithSessionDataPreserved() throws Exception {
    Properties credentials = new Properties();
    credentials.setProperty("user", POSTGRES.getUsername());
    credentials.setProperty("password", POSTGRES.getPassword());

    Flyway v2 =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .target("2")
            .load();
    assertThat(v2.migrate().migrationsExecuted).isEqualTo(2);
    assertThat(principalNameLength(credentials)).isEqualTo(100);

    // Seed a session row as an already-running deployment holds one.
    String sessionId = UUID.randomUUID().toString();
    String principal = "a".repeat(87) + "@example.test";
    assertThat(principal.length()).isEqualTo(100);
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement insert =
            connection.prepareStatement(
                "INSERT INTO spring_session (primary_id, session_id, creation_time,"
                    + " last_access_time, max_inactive_interval, expiry_time, principal_name)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?)")) {
      insert.setString(1, UUID.randomUUID().toString());
      insert.setString(2, sessionId);
      insert.setLong(3, System.currentTimeMillis());
      insert.setLong(4, System.currentTimeMillis());
      insert.setInt(5, 1800);
      insert.setLong(6, System.currentTimeMillis() + 1_800_000L);
      insert.setString(7, principal);
      assertThat(insert.executeUpdate()).isEqualTo(1);
    }

    Flyway current =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .load();
    assertThat(current.migrate().migrationsExecuted).isEqualTo(8);
    current.validate();
    assertThat(current.info().applied()).hasSize(10);
    assertThat(principalNameLength(credentials)).isEqualTo(254);

    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement select =
            connection.prepareStatement(
                "SELECT principal_name FROM spring_session WHERE session_id = ?")) {
      select.setString(1, sessionId);
      try (ResultSet rows = select.executeQuery()) {
        assertThat(rows.next()).isTrue();
        assertThat(rows.getString(1)).isEqualTo(principal);
      }
    }
  }

  private int principalNameLength(Properties credentials) throws Exception {
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement columns =
            connection.prepareStatement(
                "SELECT character_maximum_length FROM information_schema.columns"
                    + " WHERE table_schema = 'public' AND table_name = 'spring_session'"
                    + " AND column_name = 'principal_name'")) {
      try (ResultSet rows = columns.executeQuery()) {
        assertThat(rows.next()).isTrue();
        return rows.getInt(1);
      }
    }
  }
}
