package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Properties;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * V15 persistence proof on real PostgreSQL: the fresh schema with assignment provenance columns and
 * evidence columns; the V14-to-V15 upgrade backfilling every pre-existing non-refund as LEGACY and every
 * refund as INHERITED at migration time without rewriting any category, version, or timestamp; and
 * the coherence constraints that reject incoherent origin/category/rule combinations through the
 * database itself.
 */
@Testcontainers
class CategorizationProvenanceSchemaIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void freshMigrationsExposeProvenanceColumnsAndEnforceCoherence() throws Exception {
    runMigrations(null);
    try (Connection connection = openConnection()) {
      UUID userId = insertUser(connection);
      UUID householdId = insertHousehold(connection, userId);
      UUID accountId = insertAccount(connection, householdId, userId);

      // A new uncategorized non-refund row writes cleanly with an explicit NONE assignment.
      UUID id = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
              + " amount, currency, occurred_on, description, source, visibility, status,"
              + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
              + " categorization_ruleset_version, category_rule_id,"
              + " categorization_evidence_fingerprint, version, created_at, updated_at)"
              + " VALUES (?, ?, ?, ?, 'EXPENSE', -12.34, 'BRL', DATE '2026-09-22', 'Schema entry',"
              + " 'MANUAL', 'PRIVATE', 'POSTED', NULL, NULL, 'NONE', CURRENT_TIMESTAMP,"
              + " NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          id,
          householdId,
          userId,
          accountId);
      assertThat(
              queryString(
                  connection,
                  "SELECT category_origin FROM financial_transactions WHERE id = '" + id + "'"))
          .isEqualTo("NONE");

      // A PROVIDER row requires a category and a ruleset version.
      UUID providerId = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
              + " amount, currency, occurred_on, description, source, visibility, status,"
              + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
              + " categorization_ruleset_version, category_rule_id,"
              + " categorization_evidence_fingerprint, version, created_at, updated_at)"
              + " VALUES (?, ?, ?, ?, 'EXPENSE', -5.00, 'BRL', DATE '2026-09-22', 'Mapped',"
              + " 'CONNECTED', 'PRIVATE', 'POSTED', NULL, 'GROCERIES', 'PROVIDER',"
              + " CURRENT_TIMESTAMP, 'PLAID_PFC_V1_V2_1', NULL, '"
              + "a".repeat(64)
              + "', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          providerId,
          householdId,
          userId,
          accountId);
      assertThat(providerId).isNotNull();

      // INHERITED is bound to refund kind in both directions; a valid refund references its
      // expense through the existing V7 refund-field pairing.
      UUID refundSourceId = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
              + " amount, currency, occurred_on, description, source, visibility, status,"
              + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
              + " categorization_ruleset_version, category_rule_id,"
              + " categorization_evidence_fingerprint, version, created_at, updated_at)"
              + " VALUES (?, ?, ?, ?, 'EXPENSE', -50.00, 'BRL', DATE '2026-09-22', 'Source',"
              + " 'MANUAL', 'PRIVATE', 'POSTED', NULL, NULL, 'LEGACY', CURRENT_TIMESTAMP,"
              + " NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          refundSourceId,
          householdId,
          userId,
          accountId);
      UUID refundId = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
              + " amount, currency, occurred_on, description, source, visibility, status,"
              + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
              + " categorization_ruleset_version, category_rule_id,"
              + " categorization_evidence_fingerprint, version, created_at, updated_at)"
              + " VALUES (?, ?, ?, ?, 'REFUND', 5.00, 'BRL', DATE '2026-09-22', 'Back',"
              + " 'MANUAL', 'PRIVATE', 'POSTED', '"
              + refundSourceId
              + "', NULL, 'INHERITED', CURRENT_TIMESTAMP,"
              + " NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          refundId,
          householdId,
          userId,
          accountId);
      assertThat(refundId).isNotNull();

      String[] rejected =
          new String[] {
            // A categorized row cannot claim NONE.
            provenanceInsert(householdId, userId, accountId, "GROCERIES", "NONE"),
            // PROVIDER with no category is incoherent (an uncategorized USER row, by contrast,
            // is the documented explicit keep-uncategorized decision and stays legal).
            provenanceInsert(householdId, userId, accountId, null, "PROVIDER"),
            // A non-refund cannot be INHERITED.
            provenanceInsert(householdId, userId, accountId, "GROCERIES", "INHERITED"),
            // A refund cannot carry a non-inherited origin: the row references a real expense so
            // only the coherence check can reject it.
            "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
                + " amount, currency, occurred_on, description, source, visibility, status,"
                + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
                + " categorization_ruleset_version, category_rule_id,"
                + " categorization_evidence_fingerprint, version, created_at, updated_at)"
                + " VALUES ('"
                + UUID.randomUUID()
                + "', '"
                + householdId
                + "', '"
                + userId
                + "', '"
                + accountId
                + "', 'REFUND', 5.00, 'BRL', DATE '2026-09-22', 'Usurped', 'MANUAL', 'PRIVATE',"
                + " 'POSTED', '"
                + refundSourceId
                + "', 'GROCERIES', 'USER', CURRENT_TIMESTAMP,"
                + " NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            // PROVIDER without a ruleset version.
            "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
                + " amount, currency, occurred_on, description, source, visibility, status,"
                + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
                + " categorization_ruleset_version, category_rule_id,"
                + " categorization_evidence_fingerprint, version, created_at, updated_at)"
                + " VALUES ('"
                + UUID.randomUUID()
                + "', '"
                + householdId
                + "', '"
                + userId
                + "', '"
                + accountId
                + "', 'EXPENSE', -5.00, 'BRL', DATE '2026-09-22', 'No version', 'CONNECTED',"
                + " 'PRIVATE', 'POSTED', NULL, 'DINING', 'PROVIDER', CURRENT_TIMESTAMP,"
                + " NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            // A non-OWNER_RULE origin with a rule reference.
            "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
                + " amount, currency, occurred_on, description, source, visibility, status,"
                + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
                + " categorization_ruleset_version, category_rule_id,"
                + " categorization_evidence_fingerprint, version, created_at, updated_at)"
                + " VALUES ('"
                + UUID.randomUUID()
                + "', '"
                + householdId
                + "', '"
                + userId
                + "', '"
                + accountId
                + "', 'EXPENSE', -5.00, 'BRL', DATE '2026-09-22', 'Stray rule', 'MANUAL',"
                + " 'PRIVATE', 'POSTED', NULL, 'DINING', 'USER', CURRENT_TIMESTAMP,"
                + " NULL, '"
                + UUID.randomUUID()
                + "', NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            // An unknown origin token.
            provenanceInsert(householdId, userId, accountId, "DINING", "AUTO"),
            // A malformed evidence fingerprint.
            "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
                + " amount, currency, occurred_on, description, source, visibility, status,"
                + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
                + " categorization_ruleset_version, category_rule_id,"
                + " categorization_evidence_fingerprint, version, created_at, updated_at)"
                + " VALUES ('"
                + UUID.randomUUID()
                + "', '"
                + householdId
                + "', '"
                + userId
                + "', '"
                + accountId
                + "', 'EXPENSE', -5.00, 'BRL', DATE '2026-09-22', 'Bad digest', 'CONNECTED',"
                + " 'PRIVATE', 'POSTED', NULL, 'DINING', 'PROVIDER', CURRENT_TIMESTAMP,"
                + " 'PLAID_PFC_V1_V2_1', NULL, 'not-a-digest', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          };
      for (String rejection : rejected) {
        // Each rejected INSERT runs on a fresh connection: a failed statement aborts the
        // PostgreSQL transaction, so reusing one connection would mask later assertions.
        assertThatThrownBy(() -> jdbcExecute(openConnection(), rejection), "expected a rejection")
            .isInstanceOf(Exception.class);
      }
    }
  }

  @Test
  void v14DatabaseUpgradesToV15WithLegacyAndInheritedBackfillPreservingLedger() throws Exception {
    runMigrations("14");
    UUID userId;
    UUID householdId;
    UUID accountId;
    UUID expenseId;
    UUID uncategorizedId;
    UUID refundId;
    String categoryBefore;
    int versionBefore;
    Instant updatedAtBefore;
    Instant expenseUpdatedAtBefore;
    try (Connection connection = openConnection()) {
      userId = insertUser(connection);
      householdId = insertHousehold(connection, userId);
      accountId = insertAccount(connection, householdId, userId);
      expenseId =
          insertTransaction(
              connection, householdId, userId, accountId, "EXPENSE", "-50.00", "BRL", null);
      jdbcUpdate(
          connection,
          "UPDATE financial_transactions SET category = 'GROCERIES' WHERE id = '"
              + expenseId
              + "'");
      uncategorizedId =
          insertTransaction(
              connection, householdId, userId, accountId, "INCOME", "25.00", "BRL", null);
      refundId =
          insertTransaction(
              connection, householdId, userId, accountId, "REFUND", "10.00", "BRL", expenseId);

      // Freeze pre-migration facts: category, version, updated_at are never rewritten by V15.
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT category, version, updated_at FROM financial_transactions WHERE id = ?")) {
        rows.setObject(1, expenseId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          categoryBefore = result.getString(1);
          versionBefore = result.getInt(2);
          updatedAtBefore = result.getTimestamp(3).toInstant();
        }
      }
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT updated_at FROM financial_transactions WHERE id = ?")) {
        rows.setObject(1, refundId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          expenseUpdatedAtBefore = result.getTimestamp(1).toInstant();
        }
      }
    }

    runMigrations(null);

    try (Connection connection = openConnection()) {
      // The categorized expense is LEGACY with its category, version, and updated_at intact.
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT category, category_origin, category_assigned_at IS NOT NULL, version,"
                  + " updated_at, categorization_ruleset_version, category_rule_id"
                  + " FROM financial_transactions WHERE id = ?")) {
        rows.setObject(1, expenseId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          assertThat(result.getString(1)).isEqualTo(categoryBefore);
          assertThat(result.getString(2)).isEqualTo("LEGACY");
          assertThat(result.getBoolean(3)).isTrue();
          assertThat(result.getInt(4)).isEqualTo(versionBefore);
          assertThat(result.getTimestamp(5).toInstant()).isEqualTo(updatedAtBefore);
          assertThat(result.getString(6)).isNull();
          assertThat(result.getObject(7)).isNull();
        }
      }
      // The uncategorized non-refund is LEGACY too: historical intent is not reconstructed.
      assertThat(
              queryString(
                  connection,
                  "SELECT category_origin FROM financial_transactions WHERE id = '"
                      + uncategorizedId
                      + "'"))
          .isEqualTo("LEGACY");
      // The refund is INHERITED with no category of its own (the V14 seed left it null) and its
      // version and updated_at intact.
      try (PreparedStatement rows =
          connection.prepareStatement(
              "SELECT category_origin, category, version, updated_at FROM financial_transactions"
                  + " WHERE id = ?")) {
        rows.setObject(1, refundId);
        try (ResultSet result = rows.executeQuery()) {
          assertThat(result.next()).isTrue();
          assertThat(result.getString(1)).isEqualTo("INHERITED");
          assertThat(result.getString(2)).isNull();
          assertThat(result.getInt(3)).isZero();
          assertThat(result.getTimestamp(4).toInstant()).isEqualTo(expenseUpdatedAtBefore);
        }
      }
      // Every backfilled row carries the migration-time assignment instant.
      Timestamp assignedAt =
          (Timestamp)
              singleValue(
                  connection,
                  "SELECT MIN(category_assigned_at) FROM financial_transactions"
                      + " WHERE category_origin IN ('LEGACY', 'INHERITED')");
      assertThat(assignedAt).isNotNull();
    }
  }

  private static String provenanceInsert(
      UUID householdId, UUID userId, UUID accountId, String category, String origin) {
    return "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
        + " amount, currency, occurred_on, description, source, visibility, status,"
        + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
        + " categorization_ruleset_version, category_rule_id,"
        + " categorization_evidence_fingerprint, version, created_at, updated_at)"
        + " VALUES ('"
        + UUID.randomUUID()
        + "', '"
        + householdId
        + "', '"
        + userId
        + "', '"
        + accountId
        + "', 'EXPENSE', -5.00, 'BRL', DATE '2026-09-22', 'Forged', 'MANUAL', 'PRIVATE',"
        + " 'POSTED', NULL, "
        + (category == null ? "NULL" : "'" + category + "'")
        + ", '"
        + origin
        + "', CURRENT_TIMESTAMP, NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)";
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
        "catprov"
            + UUID.randomUUID().toString().replace("-", "").substring(0, 10)
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
        "Provenance home");
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
            + " VALUES (?, ?, ?, 'Schema account', 'CHECKING', 'BRL', 'MANUAL', 'PRIVATE',"
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
      String amount,
      String currency,
      UUID refundOf)
      throws Exception {
    UUID id = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
            + " amount, currency, occurred_on, description, source, visibility, status,"
            + " refund_of_transaction_id, version, created_at, updated_at)"
            + " VALUES (?, ?, ?, ?, ?, ?::numeric, ?, DATE '2026-09-16', 'Schema entry', 'MANUAL',"
            + " 'PRIVATE', 'POSTED', "
            + (refundOf == null ? "NULL" : "'" + refundOf + "'")
            + ", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        id,
        householdId,
        userId,
        accountId,
        kind,
        amount,
        currency);
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

  private void jdbcExecute(Connection connection, String sql) throws Exception {
    try (java.sql.Statement statement = connection.createStatement()) {
      statement.execute(sql);
    }
  }

  private String queryString(Connection connection, String sql) throws Exception {
    try (java.sql.Statement statement = connection.createStatement();
        ResultSet rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getString(1);
    }
  }

  private Object singleValue(Connection connection, String sql) throws Exception {
    try (java.sql.Statement statement = connection.createStatement();
        ResultSet rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getObject(1);
    }
  }
}
