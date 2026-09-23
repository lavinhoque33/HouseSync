package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.Properties;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * V8 persistence proof on real PostgreSQL: the fresh schema with the exact sixteen-token category
 * check and the widened PRIVATE/HOUSEHOLD visibility check, the V7-to-V8 upgrade keeping existing
 * account, transaction, and idempotency data intact, and the household feed index backing the
 * disclosed-entries page scan.
 */
@Testcontainers
class TransactionCategorySchemaIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  private static final String[] TOKENS =
      new String[] {
        "HOUSING",
        "GROCERIES",
        "DINING",
        "UTILITIES",
        "TRANSPORTATION",
        "SHOPPING",
        "ENTERTAINMENT",
        "HEALTHCARE",
        "TRAVEL",
        "EDUCATION",
        "PERSONAL",
        "HOUSEHOLD_SUPPLIES",
        "SUBSCRIPTIONS",
        "INCOME",
        "TRANSFERS",
        "MISCELLANEOUS"
      };

  @Test
  void freshV8SchemaAcceptsTaxonomyTokensAndHouseholdVisibilityOnly() throws Exception {
    runMigrations(null);
    try (Connection connection = openConnection()) {
      UUID userId = insertUser(connection);
      UUID householdId = insertHousehold(connection, userId);
      UUID accountId = insertAccount(connection, householdId, userId, "BRL");

      // All sixteen tokens and null are accepted; HOUSEHOLD visibility is accepted.
      for (String token : TOKENS) {
        assertThat(
                insertTransaction(
                    connection,
                    householdId,
                    userId,
                    accountId,
                    "INCOME",
                    "5.000",
                    "BRL",
                    null,
                    token))
            .isNotNull();
      }
      UUID uncategorized =
          insertTransaction(
              connection, householdId, userId, accountId, "INCOME", "5.000", "BRL", null, null);
      assertThat(uncategorized).isNotNull();
      UUID shared =
          insertTransaction(
              connection,
              householdId,
              userId,
              accountId,
              "EXPENSE",
              "-5.000",
              "BRL",
              null,
              null,
              "HOUSEHOLD");
      assertThat(shared).isNotNull();

      // Unknown, lowercase, and empty tokens are rejected by the database itself.
      for (String rejected : new String[] {"housing", "HOUSIN", "", "TRANSFERS "}) {
        assertThatThrownBy(
                () ->
                    insertTransaction(
                        connection,
                        householdId,
                        userId,
                        accountId,
                        "INCOME",
                        "5.000",
                        "BRL",
                        null,
                        rejected))
            .isInstanceOf(Exception.class);
      }
      assertThatThrownBy(
              () ->
                  insertTransaction(
                      connection,
                      householdId,
                      userId,
                      accountId,
                      "EXPENSE",
                      "-5.000",
                      "BRL",
                      null,
                      null,
                      "FAMILY"))
          .isInstanceOf(Exception.class);

      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transactions"
                      + " WHERE household_id = '"
                      + householdId
                      + "' AND category = 'GROCERIES'"))
          .isEqualTo(1);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transactions"
                      + " WHERE household_id = '"
                      + householdId
                      + "' AND visibility = 'HOUSEHOLD'"))
          .isEqualTo(1);

      // The household feed index backs the disclosed page scan.
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM pg_indexes WHERE indexname ="
                      + " 'financial_transactions_household_feed_idx'"))
          .isEqualTo(1);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM information_schema.columns WHERE table_name ="
                      + " 'financial_transactions' AND column_name = 'category'"
                      + " AND is_nullable = 'YES'"))
          .isEqualTo(1);
    }
  }

  @Test
  void v7DatabaseUpgradesToV8WithTransactionDataIntact() throws Exception {
    runMigrations("7");
    UUID userId;
    UUID householdId;
    UUID accountId;
    UUID expenseId;
    UUID refundId;
    UUID createKey;
    try (Connection connection = openConnection()) {
      userId = insertUser(connection);
      householdId = insertHousehold(connection, userId);
      accountId = insertAccount(connection, householdId, userId, "JPY");
      expenseId =
          insertTransaction(
              connection,
              householdId,
              userId,
              accountId,
              "EXPENSE",
              "-1200.000",
              "JPY",
              null,
              null);
      refundId =
          insertTransaction(
              connection,
              householdId,
              userId,
              accountId,
              "REFUND",
              "200.000",
              "JPY",
              expenseId,
              null);
      createKey = UUID.randomUUID();
      // A live V7 deployment already holds transaction create keys; V8 must preserve them.
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transaction_idempotency_keys"
              + " (actor_user_id, household_id, operation, idempotency_key,"
              + " request_fingerprint, resource_id, created_at)"
              + " VALUES (?, ?, 'TRANSACTION_CREATE', ?, ?, ?, CURRENT_TIMESTAMP)",
          userId,
          householdId,
          createKey,
          "a".repeat(64),
          expenseId);
    }

    runMigrations(null);

    try (Connection connection = openConnection()) {
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transaction_idempotency_keys"
                      + " WHERE idempotency_key = '"
                      + createKey
                      + "'"))
          .isEqualTo(1);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transactions WHERE account_id = '"
                      + accountId
                      + "'"))
          .isEqualTo(2);
      // Existing rows stay uncategorized and private: the nullable column and widened
      // check both accept the upgraded transaction data unchanged.
      assertThat(
              queryString(
                  connection,
                  "SELECT COALESCE(category, 'NULL') || ':' || visibility FROM financial_transactions"
                      + " WHERE id = '"
                      + expenseId
                      + "'"))
          .isEqualTo("NULL:PRIVATE");
      assertThat(
              queryString(
                  connection,
                  "SELECT refund_of_transaction_id::text IS NOT NULL FROM financial_transactions"
                      + " WHERE id = '"
                      + refundId
                      + "'"))
          .isEqualTo("t");

      // Both new capabilities write cleanly against the upgraded schema.
      jdbcUpdate(
          connection,
          "UPDATE financial_transactions SET category = 'TRAVEL' WHERE id = '" + expenseId + "'");
      jdbcUpdate(
          connection,
          "UPDATE financial_transactions SET visibility = 'HOUSEHOLD' WHERE id = '"
              + refundId
              + "'");
      assertThat(
              queryString(
                  connection,
                  "SELECT COALESCE(category, 'NULL') || ':' || visibility FROM financial_transactions"
                      + " WHERE id = '"
                      + refundId
                      + "'"))
          .isEqualTo("NULL:HOUSEHOLD");
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
      UUID refundOf,
      String category)
      throws Exception {
    return insertTransaction(
        connection,
        householdId,
        userId,
        accountId,
        kind,
        amount,
        currency,
        refundOf,
        category,
        "PRIVATE");
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
      String category,
      String visibility)
      throws Exception {
    UUID id = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
            + " amount, currency, occurred_on, description, source, visibility, status,"
            + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
            + " version, created_at, updated_at)"
            + " VALUES (?, ?, ?, ?, ?, ?::numeric, ?, ?::date, 'Schema entry', 'MANUAL',"
            + " ?, 'POSTED', "
            + (refundOf == null ? "NULL" : "'" + refundOf + "'")
            + ", "
            + (category == null ? "NULL" : "'" + category + "'")
            + (refundOf == null ? ", 'USER'" : ", 'INHERITED'")
            + ", CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        id,
        householdId,
        userId,
        accountId,
        kind,
        amount,
        currency,
        "2026-09-16",
        visibility);
    return id;
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
    try (Statement statement = connection.createStatement();
        java.sql.ResultSet rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getInt(1);
    }
  }

  private String queryString(Connection connection, String sql) throws Exception {
    try (Statement statement = connection.createStatement();
        java.sql.ResultSet rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getString(1);
    }
  }
}
