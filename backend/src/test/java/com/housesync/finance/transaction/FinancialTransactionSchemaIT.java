package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.util.Properties;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * V7 persistence proof on real PostgreSQL: the fresh schema, the V6-to-V7 upgrade with prior
 * account data intact, and the row constraints the API relies on — composite account and refund
 * references enforcing household/owner/currency consistency, kind sign and nonzero rules,
 * refund-field pairing, and the date range.
 */
@Testcontainers
class FinancialTransactionSchemaIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void freshMigrationsCreateV7AndRowConstraintsRejectInconsistentWrites() throws Exception {
    runMigrations(null);
    try (Connection connection = openConnection()) {
      UUID userId = insertUser(connection);
      UUID otherUserId = insertUser(connection);
      UUID householdId = insertHousehold(connection, userId);
      UUID otherHouseholdId = insertHousehold(connection, otherUserId);
      UUID accountId = insertAccount(connection, householdId, userId, "BRL");
      UUID foreignAccount = insertAccount(connection, householdId, userId, "USD");
      UUID expenseId =
          insertTransaction(
              connection, householdId, userId, accountId, "EXPENSE", "-100.000", "BRL", null);

      // A consistent refund write succeeds.
      UUID refundId =
          insertTransaction(
              connection, householdId, userId, accountId, "REFUND", "10.000", "BRL", expenseId);
      assertThat(refundId).isNotNull();

      String[] rejected =
          new String[] {
            // Currency drift from the source account (composite account reference).
            rejectedInsert(householdId, userId, accountId, "INCOME", "5.000", "USD", null),
            // Owner drift from the source account.
            rejectedInsert(householdId, otherUserId, accountId, "INCOME", "5.000", "BRL", null),
            // Household drift from the source account.
            rejectedInsert(otherHouseholdId, userId, accountId, "INCOME", "5.000", "BRL", null),
            // Wrong sign for the declared kind.
            rejectedInsert(householdId, userId, accountId, "EXPENSE", "5.000", "BRL", null),
            // Zero amount.
            rejectedInsert(householdId, userId, accountId, "INCOME", "0.000", "BRL", null),
            // Refund referencing a source in another account (composite refund reference).
            rejectedInsert(
                householdId, userId, foreignAccount, "REFUND", "5.000", "USD", expenseId),
            // Refund field on a non-refund kind (source exists, so the pairing check fires).
            rejectedInsert(householdId, userId, accountId, "INCOME", "5.000", "BRL", expenseId),
            // Missing refund source on a refund kind.
            rejectedInsert(householdId, userId, accountId, "REFUND", "5.000", "BRL", null),
            // Occurred-on out of the documented range.
            datedRejectedInsert(
                householdId, userId, accountId, "INCOME", "5.000", "BRL", "1899-12-31"),
            datedRejectedInsert(
                householdId, userId, accountId, "INCOME", "5.000", "BRL", "9999-12-31"),
          };
      for (String rejection : rejected) {
        assertThatThrownBy(
                () -> jdbcExecute(connection, rejection), "expected a constraint rejection")
            .isInstanceOf(Exception.class);
      }

      // The partial refund-source index backs live-refund projection queries.
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM pg_indexes"
                      + " WHERE indexname = 'financial_transactions_refund_source_idx'"))
          .isEqualTo(1);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transactions"
                      + " WHERE household_id = '"
                      + householdId
                      + "'"))
          .isEqualTo(2);
    }
  }

  @Test
  void v6DatabaseUpgradesToV7WithAccountDataIntact() throws Exception {
    runMigrations("6");
    UUID userId;
    UUID householdId;
    UUID accountId;
    UUID createKey;
    try (Connection connection = openConnection()) {
      userId = insertUser(connection);
      householdId = insertHousehold(connection, userId);
      accountId = insertAccount(connection, householdId, userId, "JPY");
      createKey = UUID.randomUUID();
      // A live V6 deployment already holds account create keys; V7 must preserve them.
      jdbcUpdate(
          connection,
          "INSERT INTO financial_account_idempotency_keys"
              + " (actor_user_id, household_id, operation, idempotency_key,"
              + " request_fingerprint, resource_id, created_at)"
              + " VALUES (?, ?, 'ACCOUNT_CREATE', ?, ?, ?, CURRENT_TIMESTAMP)",
          userId,
          householdId,
          createKey,
          "a".repeat(64),
          accountId);
    }

    runMigrations(null);

    try (Connection connection = openConnection()) {
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_account_idempotency_keys"
                      + " WHERE idempotency_key = '"
                      + createKey
                      + "'"))
          .isEqualTo(1);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_accounts WHERE household_id = '"
                      + householdId
                      + "'"))
          .isEqualTo(1);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transactions WHERE account_id = '"
                      + accountId
                      + "'"))
          .isZero();
      UUID transactionId =
          insertTransaction(
              connection, householdId, userId, accountId, "EXPENSE", "-1200.000", "JPY", null);
      assertThat(transactionId).isNotNull();
      // NUMERIC(15,3) keeps three fractional digits; the response layer re-pads to scale.
      assertThat(
              queryString(
                  connection,
                  "SELECT amount::text FROM financial_transactions WHERE id = '"
                      + transactionId
                      + "'"))
          .isEqualTo("-1200.000");
    }
  }

  private static void runMigrations(String target) {
    // Flyway's target must be set only for historical checkpoints; the default target is
    // the latest migration, and a null here is an unconditional-fresh request.
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
        "schema" + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test",
        "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000");
    return userId;
  }

  private UUID insertHousehold(Connection connection, UUID userId) throws Exception {
    UUID householdId = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO households (id, name, created_at)" + " VALUES (?, ?, CURRENT_TIMESTAMP)",
        householdId,
        "Schema home");
    jdbcUpdate(
        connection,
        "INSERT INTO household_members (household_id, user_id, role)" + " VALUES (?, ?, 'OWNER')",
        householdId,
        userId);
    return householdId;
  }

  private UUID insertAccount(Connection connection, UUID householdId, UUID userId, String currency)
      throws Exception {
    UUID accountId = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_accounts (id, household_id, owner_user_id, name, kind, currency,"
            + " source, visibility, status, version, created_at, updated_at)"
            + " VALUES (?, ?, ?, 'Schema account', 'CHECKING', ?, 'MANUAL', 'PRIVATE', 'ACTIVE',"
            + " 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        accountId,
        householdId,
        userId,
        currency);
    return accountId;
  }

  private UUID insertTransaction(
      Connection connection,
      UUID householdId,
      UUID userId,
      UUID accountId,
      String kind,
      String amount,
      String currency,
      UUID refundOf)
      throws Exception {
    return insertTransaction(
        connection, householdId, userId, accountId, kind, amount, currency, refundOf, "2026-09-16");
  }

  private UUID insertTransaction(
      Connection connection,
      UUID householdId,
      UUID userId,
      UUID accountId,
      String kind,
      String amount,
      String currency,
      UUID refundOf,
      String date)
      throws Exception {
    UUID id = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
            + " amount, currency, occurred_on, description, source, visibility, status,"
            + " refund_of_transaction_id, version, created_at, updated_at)"
            + " VALUES (?, ?, ?, ?, ?, ?::numeric, ?, ?::date, 'Schema entry', 'MANUAL',"
            + " 'PRIVATE', 'POSTED', "
            + (refundOf == null ? "NULL" : "'" + refundOf + "'")
            + ", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        id,
        householdId,
        userId,
        accountId,
        kind,
        amount,
        currency,
        date);
    return id;
  }

  /**
   * Raw INSERT builder for constraint-rejection attempts only; values are test-controlled literals,
   * never user input, and each must fail on a V7 row constraint.
   */
  private String rejectedInsert(
      UUID householdId,
      UUID userId,
      UUID accountId,
      String kind,
      String amount,
      String currency,
      UUID refundOf) {
    return "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id,"
        + " kind, amount, currency, occurred_on, description, source, visibility, status,"
        + " refund_of_transaction_id, version, created_at, updated_at)"
        + " VALUES ('"
        + UUID.randomUUID()
        + "', '"
        + householdId
        + "', '"
        + userId
        + "', '"
        + accountId
        + "', '"
        + kind
        + "', "
        + amount
        + ", '"
        + currency
        + "', DATE '2026-09-17', 'Forged', 'MANUAL', 'PRIVATE', 'POSTED', "
        + (refundOf == null ? "NULL" : "'" + refundOf + "'")
        + ", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)";
  }

  private String datedRejectedInsert(
      UUID householdId,
      UUID userId,
      UUID accountId,
      String kind,
      String amount,
      String currency,
      String date) {
    return rejectedInsert(householdId, userId, accountId, kind, amount, currency, null)
        .replace("DATE '2026-09-17'", "DATE '" + date + "'");
  }

  private void jdbcExecute(Connection connection, String sql) throws Exception {
    try (java.sql.Statement statement = connection.createStatement()) {
      statement.execute(sql);
    }
  }

  private void jdbcUpdate(Connection connection, String sql, Object... parameters)
      throws Exception {
    try (PreparedStatement statement = connection.prepareStatement(sql)) {
      for (int index = 0; index < parameters.length; index++) {
        Object parameter = parameters[index];
        if (parameter == null) {
          statement.setObject(index + 1, null);
        } else {
          statement.setObject(index + 1, parameter);
        }
      }
      assertThat(statement.executeUpdate()).isEqualTo(1);
    }
  }

  private int queryInt(Connection connection, String sql) throws Exception {
    try (PreparedStatement statement = connection.prepareStatement(sql);
        java.sql.ResultSet rows = statement.executeQuery()) {
      assertThat(rows.next()).isTrue();
      return rows.getInt(1);
    }
  }

  private String queryString(Connection connection, String sql) throws Exception {
    try (java.sql.Statement statement = connection.createStatement();
        java.sql.ResultSet rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getString(1);
    }
  }
}
