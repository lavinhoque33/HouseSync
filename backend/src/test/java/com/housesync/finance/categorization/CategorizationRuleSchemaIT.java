package com.housesync.finance.categorization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
 * V16 persistence proof on real PostgreSQL: the retained owner-rule table with per-owner scoped
 * active uniqueness, bounded match forms, the retained rule reference from the ledger's
 * provenance column, the source-entry reference enforcing household/owner consistency, and the
 * durable rule-creation idempotency table.
 */
@Testcontainers
class CategorizationRuleSchemaIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void freshMigrationsExposeRulesAndEnforceScopesAndReferences() throws Exception {
    runMigrations(null);
    try (Connection connection = openConnection()) {
      UUID ownerId = insertUser(connection);
      UUID householdId = insertHousehold(connection, ownerId);
      UUID accountId = insertAccount(connection, householdId, ownerId);
      UUID entryId = insertTransaction(connection, householdId, ownerId, accountId);

      // A valid text rule inserts cleanly at version 0.
      UUID textRuleId = UUID.randomUUID();
      insertRule(
          connection,
          textRuleId,
          householdId,
          ownerId,
          entryId,
          "NORMALIZED_TEXT",
          "corner market",
          "Corner Market",
          "GROCERIES");
      try (ResultSet result =
          query(
              connection,
              "SELECT match_type, status, version, ruleset_version, category FROM"
                  + " categorization_rules WHERE id = '"
                  + textRuleId
                  + "'")) {
        assertThat(result.next()).isTrue();
        assertThat(result.getString(1)).isEqualTo("NORMALIZED_TEXT");
        assertThat(result.getString(2)).isEqualTo("ACTIVE");
        assertThat(result.getInt(3)).isZero();
        assertThat(result.getString(4)).isEqualTo("OWNER_RULE_V1");
        assertThat(result.getString(5)).isEqualTo("GROCERIES");
      }

      // A provider merchant rule keys on the 64-hex scope-bound digest.
      UUID merchantRuleId = UUID.randomUUID();
      insertRule(
          connection,
          merchantRuleId,
          householdId,
          ownerId,
          entryId,
          "PROVIDER_MERCHANT",
          "a".repeat(64),
          "Corner Market",
          "GROCERIES");
      assertThat(
              queryString(
                  connection,
                  "SELECT status FROM categorization_rules WHERE id = '" + merchantRuleId + "'"))
          .isEqualTo("ACTIVE");

      // The partial active-key index rejects a second ACTIVE rule for the same owner/match key
      // but permits inactive history and independent owners.
      assertThatThrownBy(
              () ->
                  insertRule(
                      openConnection(),
                      UUID.randomUUID(),
                      householdId,
                      ownerId,
                      entryId,
                      "NORMALIZED_TEXT",
                      "corner market",
                      "Corner Market",
                      "DINING"),
              "expected the active-key rejection")
          .isInstanceOf(Exception.class);
      jdbcUpdate(
          connection,
          "UPDATE categorization_rules SET status = 'INACTIVE', version = 1, updated_at ="
              + " CURRENT_TIMESTAMP WHERE id = ?",
          textRuleId);
      jdbcUpdate(
          connection,
          "UPDATE categorization_rules SET status = 'ACTIVE', version = 2, updated_at ="
              + " CURRENT_TIMESTAMP WHERE id = ?",
          textRuleId);
      UUID memberUserId = insertUser(connection);
      jdbcUpdate(
          connection,
          "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'MEMBER')",
          householdId,
          memberUserId);
      // The member learns an independent rule from their OWN entry: the active-key uniqueness is
      // scoped per financial owner and the source reference enforces that ownership.
      UUID memberAccountId = insertAccount(connection, householdId, memberUserId);
      UUID memberEntryId =
          insertTransaction(connection, householdId, memberUserId, memberAccountId);
      insertRule(
          connection,
          UUID.randomUUID(),
          householdId,
          memberUserId,
          memberEntryId,
          "NORMALIZED_TEXT",
          "corner market",
          "Corner Market",
          "DINING");
      assertThat(
              queryString(
                  connection,
                  "SELECT category FROM categorization_rules WHERE match_key = 'corner market'"
                      + " AND owner_user_id = '"
                      + memberUserId
                      + "'"))
          .isEqualTo("DINING");

      // The source-entry reference composes household and owner: a rule cannot learn from
      // another household's entry or from another owner's entry in the same household.
      UUID outsiderId = insertUser(connection);
      UUID outsiderHouseholdId = insertHousehold(connection, outsiderId);
      UUID outsiderAccountId = insertAccount(connection, outsiderHouseholdId, outsiderId);
      UUID outsiderEntryId =
          insertTransaction(connection, outsiderHouseholdId, outsiderId, outsiderAccountId);
      assertThatThrownBy(
              () ->
                  insertRule(
                      openConnection(),
                      UUID.randomUUID(),
                      householdId,
                      ownerId,
                      outsiderEntryId,
                      "NORMALIZED_TEXT",
                      "corner market",
                      "Corner Market",
                      "GROCERIES"),
              "expected the foreign-source rejection")
          .isInstanceOf(Exception.class);
      assertThatThrownBy(
              () ->
                  insertRule(
                      openConnection(),
                      UUID.randomUUID(),
                      householdId,
                      memberUserId,
                      outsiderEntryId,
                      "NORMALIZED_TEXT",
                      "corner market",
                      "Corner Market",
                      "GROCERIES"),
              "expected the foreign-owner rejection")
          .isInstanceOf(Exception.class);

      // The retained rule reference binds the ledger provenance column to this household's
      // rules AND financial owner: the owner's own row references the rule, another owner's row
      // in the same household can never point at it, and an unknown rule stays rejected.
      jdbcUpdate(
          connection,
          "UPDATE financial_transactions SET category = 'DINING', category_origin = 'OWNER_RULE',"
              + " categorization_ruleset_version = 'OWNER_RULE_V1', category_rule_id = ?"
              + " WHERE id = ?",
          textRuleId,
          entryId);
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      openConnection(),
                      "INSERT INTO financial_transactions (id, household_id, owner_user_id,"
                          + " account_id, kind, amount, currency, occurred_on, description,"
                          + " source, visibility, status, refund_of_transaction_id, category,"
                          + " category_origin, category_assigned_at, categorization_ruleset_version,"
                          + " category_rule_id, categorization_evidence_fingerprint, version,"
                          + " created_at, updated_at)"
                          + " VALUES ('"
                          + UUID.randomUUID()
                          + "', '"
                          + householdId
                          + "', '"
                          + memberUserId
                          + "', '"
                          + memberAccountId
                          + "', 'EXPENSE', -5.00, 'BRL', DATE '2026-09-22', 'Cross owner rule',"
                          + " 'MANUAL', 'PRIVATE', 'POSTED', NULL, 'DINING', 'OWNER_RULE',"
                          + " CURRENT_TIMESTAMP, 'OWNER_RULE_V1', '"
                          + textRuleId
                          + "', NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"),
              "expected the cross-owner provenance rejection")
          .isInstanceOf(Exception.class);
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      openConnection(),
                      "INSERT INTO financial_transactions (id, household_id, owner_user_id,"
                          + " account_id, kind, amount, currency, occurred_on, description,"
                          + " source, visibility, status, refund_of_transaction_id, category,"
                          + " category_origin, category_assigned_at, categorization_ruleset_version,"
                          + " category_rule_id, categorization_evidence_fingerprint, version,"
                          + " created_at, updated_at)"
                          + " VALUES ('"
                          + UUID.randomUUID()
                          + "', '"
                          + householdId
                          + "', '"
                          + ownerId
                          + "', '"
                          + accountId
                          + "', 'EXPENSE', -5.00, 'BRL', DATE '2026-09-22', 'Stray rule',"
                          + " 'MANUAL', 'PRIVATE', 'POSTED', NULL, 'DINING', 'OWNER_RULE',"
                          + " CURRENT_TIMESTAMP, 'OWNER_RULE_V1', '"
                          + UUID.randomUUID()
                          + "', NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"),
              "expected the unknown-rule rejection")
          .isInstanceOf(Exception.class);

      String[] rejected =
          new String[] {
            // An unknown match form.
            ruleInsert(
                householdId,
                ownerId,
                entryId,
                "MERCHANT",
                "corner market",
                "Corner Market",
                "GROCERIES"),
            // An unknown status.
            ruleInsert(
                    householdId,
                    ownerId,
                    entryId,
                    "NORMALIZED_TEXT",
                    "corner market",
                    "Corner Market",
                    "GROCERIES")
                .replace("'ACTIVE'", "'ENABLED'"),
            // An unknown category token.
            ruleInsert(
                householdId,
                ownerId,
                entryId,
                "NORMALIZED_TEXT",
                "corner market",
                "Corner Market",
                "FUEL"),
            // A provider merchant rule must key on the 64-hex digest.
            ruleInsert(
                householdId,
                ownerId,
                entryId,
                "PROVIDER_MERCHANT",
                "corner market",
                "Corner Market",
                "GROCERIES"),
            // A text key may not exceed the description bound.
            ruleInsert(
                householdId,
                ownerId,
                entryId,
                "NORMALIZED_TEXT",
                "a".repeat(201),
                "Corner Market",
                "GROCERIES"),
            // No control character may enter a key or label.
            ruleInsert(
                householdId,
                ownerId,
                entryId,
                "NORMALIZED_TEXT",
                "corner\u0007market",
                "Corner Market",
                "GROCERIES"),
            ruleInsert(
                householdId,
                ownerId,
                entryId,
                "NORMALIZED_TEXT",
                "corner market",
                "Corner\u0007Market",
                "GROCERIES"),
            // Version and ruleset bounds.
            ruleInsert(
                    householdId,
                    ownerId,
                    entryId,
                    "NORMALIZED_TEXT",
                    "corner market",
                    "Corner Market",
                    "GROCERIES")
                .replace("'ACTIVE', 0,", "'ACTIVE', -1,"),
            ruleInsert(
                    householdId,
                    ownerId,
                    entryId,
                    "NORMALIZED_TEXT",
                    "corner market",
                    "Corner Market",
                    "GROCERIES")
                .replace("'OWNER_RULE_V1'", "'" + "V".repeat(33) + "'"),
          };
      for (String rejection : rejected) {
        // Each rejected INSERT runs on a fresh connection: a failed statement aborts the
        // PostgreSQL transaction, so reusing one connection would mask later assertions.
        assertThatThrownBy(() -> jdbcExecute(openConnection(), rejection), "expected a rejection")
            .isInstanceOf(Exception.class);
      }

      // Durable rule-create idempotency keys scope to actor, household, and operation.
      UUID idempotencyKey = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO categorization_rule_idempotency_keys (actor_user_id, household_id,"
              + " operation, idempotency_key, request_fingerprint, resource_id, created_at)"
              + " VALUES (?, ?, 'CATEGORIZATION_RULE_CREATE', ?, '"
              + "b".repeat(64)
              + "', ?, CURRENT_TIMESTAMP)",
          ownerId,
          householdId,
          idempotencyKey,
          textRuleId);
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      openConnection(),
                      "INSERT INTO categorization_rule_idempotency_keys (actor_user_id,"
                          + " household_id, operation, idempotency_key, request_fingerprint,"
                          + " resource_id, created_at)"
                          + " VALUES (?, ?, 'CATEGORIZATION_RULE_CREATE', ?, '"
                          + "b".repeat(64)
                          + "', ?, CURRENT_TIMESTAMP)",
                      ownerId,
                      householdId,
                      idempotencyKey,
                      textRuleId),
              "expected the duplicate durable key rejection")
          .isInstanceOf(Exception.class);
    }
  }

  @Test
  void reviewsEnforceOneOpenOwnerReferenceAndDurableReplayKey() throws Exception {
    runMigrations(null);
    try (Connection connection = openConnection()) {
      UUID owner = insertUser(connection);
      UUID household = insertHousehold(connection, owner);
      UUID entry =
          insertTransaction(
              connection, household, owner, insertAccount(connection, household, owner));
      UUID other = insertUser(connection);
      jdbcUpdate(
          connection,
          "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'MEMBER')",
          household,
          other);
      UUID otherEntry =
          insertTransaction(
              connection, household, other, insertAccount(connection, household, other));
      UUID first = UUID.randomUUID();
      String initial = reviewInsert(first, household, owner, entry, "OPEN", "a".repeat(64));
      jdbcExecute(connection, initial);
      assertThatThrownBy(
              () ->
                  jdbcExecute(
                      openConnection(),
                      reviewInsert(
                          UUID.randomUUID(), household, owner, entry, "OPEN", "b".repeat(64))))
          .isInstanceOf(Exception.class);
      // A forged same-household owner reference cannot attach to a different owner's ledger.
      assertThatThrownBy(
              () ->
                  jdbcExecute(
                      openConnection(),
                      reviewInsert(
                          UUID.randomUUID(),
                          household,
                          owner,
                          otherEntry,
                          "ACCEPTED",
                          "b".repeat(64))))
          .isInstanceOf(Exception.class);
      jdbcUpdate(
          connection,
          "UPDATE categorization_reviews SET status = 'SUPERSEDED', version = 1,"
              + " updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          first);
      jdbcExecute(
          connection,
          reviewInsert(UUID.randomUUID(), household, owner, entry, "OPEN", "b".repeat(64)));
      // History cannot silently duplicate an evaluated evidence revision.
      assertThatThrownBy(
              () ->
                  jdbcExecute(
                      openConnection(),
                      reviewInsert(
                          UUID.randomUUID(),
                          household,
                          owner,
                          entry,
                          "SUPERSEDED",
                          "a".repeat(64))))
          .isInstanceOf(Exception.class);
      assertThat(
              queryString(
                  connection,
                  "SELECT count(*) FROM categorization_reviews WHERE"
                      + " household_id = '"
                      + household
                      + "' AND owner_user_id = '"
                      + owner
                      + "' AND status = 'OPEN'"))
          .isEqualTo("1");
      UUID key = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO categorization_review_idempotency_keys"
              + " (actor_user_id, household_id, idempotency_key, request_fingerprint, review_id, created_at)"
              + " VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
          owner,
          household,
          key,
          "f".repeat(64),
          first);
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      openConnection(),
                      "INSERT INTO categorization_review_idempotency_keys"
                          + " (actor_user_id, household_id, idempotency_key, request_fingerprint, review_id, created_at)"
                          + " VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                      owner,
                      household,
                      key,
                      "e".repeat(64),
                      first))
          .isInstanceOf(Exception.class);
    }
  }

  private static String reviewInsert(
      UUID id, UUID household, UUID owner, UUID entry, String status, String fingerprint) {
    return "INSERT INTO categorization_reviews (id, household_id, owner_user_id, transaction_id,"
        + " suggested_category, source, confidence, reason_code, policy_version,"
        + " evidence_fingerprint, evaluated_transaction_version, status, version, created_at, updated_at)"
        + " VALUES ('"
        + id
        + "', '"
        + household
        + "', '"
        + owner
        + "', '"
        + entry
        + "', 'GROCERIES', 'HEURISTIC', 'HIGH', 'EXACT_MERCHANT', 'exact-merchant-v1', '"
        + fingerprint
        + "', 0, '"
        + status
        + "', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)";
  }

  private static String ruleInsert(
      UUID householdId,
      UUID ownerId,
      UUID entryId,
      String matchType,
      String matchKey,
      String matchLabel,
      String category) {
    return "INSERT INTO categorization_rules (id, household_id, owner_user_id,"
        + " source_transaction_id, match_type, match_key, match_label, category, status,"
        + " version, ruleset_version, created_at, updated_at)"
        + " VALUES ('"
        + UUID.randomUUID()
        + "', '"
        + householdId
        + "', '"
        + ownerId
        + "', '"
        + entryId
        + "', '"
        + matchType
        + "', '"
        + matchKey
        + "', '"
        + matchLabel
        + "', '"
        + category
        + "', 'ACTIVE', 0, 'OWNER_RULE_V1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)";
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
        "catrule"
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
        "Rule schema home");
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
      Connection connection, UUID householdId, UUID userId, UUID accountId) throws Exception {
    UUID id = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
            + " amount, currency, occurred_on, description, source, visibility, status,"
            + " refund_of_transaction_id, category, category_origin, category_assigned_at,"
            + " categorization_ruleset_version, category_rule_id,"
            + " categorization_evidence_fingerprint, version, created_at, updated_at)"
            + " VALUES (?, ?, ?, ?, 'EXPENSE', -5.00, 'BRL', DATE '2026-09-16', 'Rule source',"
            + " 'MANUAL', 'PRIVATE', 'POSTED', NULL, NULL, 'NONE', CURRENT_TIMESTAMP,"
            + " NULL, NULL, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        id,
        householdId,
        userId,
        accountId);
    return id;
  }

  private void insertRule(
      Connection connection,
      UUID id,
      UUID householdId,
      UUID userId,
      UUID entryId,
      String matchType,
      String matchKey,
      String matchLabel,
      String category)
      throws Exception {
    jdbcUpdate(
        connection,
        "INSERT INTO categorization_rules (id, household_id, owner_user_id,"
            + " source_transaction_id, match_type, match_key, match_label, category, status,"
            + " version, ruleset_version, created_at, updated_at)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, 'OWNER_RULE_V1', CURRENT_TIMESTAMP,"
            + " CURRENT_TIMESTAMP)",
        id,
        householdId,
        userId,
        entryId,
        matchType,
        matchKey,
        matchLabel,
        category);
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
    try (ResultSet result = query(connection, sql)) {
      assertThat(result.next()).isTrue();
      return result.getString(1);
    }
  }

  private ResultSet query(Connection connection, String sql) throws Exception {
    return connection.createStatement().executeQuery(sql);
  }
}
