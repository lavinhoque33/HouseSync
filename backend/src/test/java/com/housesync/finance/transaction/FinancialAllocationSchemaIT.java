package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Properties;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * V9 persistence proof on real PostgreSQL (ADR 0007): the fresh schema with allocation,
 * frozen-participant, and ALLOCATION_CREATE idempotency tables, restrictive stable-user foreign
 * keys, the one-active-allocation partial unique index, and the V8-to-V9 upgrade keeping all
 * earlier data and keys intact.
 */
@Testcontainers
class FinancialAllocationSchemaIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @Test
  void freshV9SchemaEnforcesOneActiveAllocationAndFrozenShareBounds() throws Exception {
    runMigrations(null);
    try (Connection connection = openConnection()) {
      UUID userId = insertUser(connection);
      UUID householdId = insertHousehold(connection, userId);
      UUID accountId = insertAccount(connection, householdId, userId, "USD");
      UUID expenseId =
          insertTransaction(
              connection, householdId, userId, accountId, "EXPENSE", "-10.00", "USD", null);

      UUID allocationId =
          insertAllocation(connection, expenseId, householdId, userId, "USD", "10.00", "ACTIVE");
      insertParticipant(connection, allocationId, userId, "USD", "10.00");

      // At most one ACTIVE allocation per expense; a revoked sibling does not count.
      UUID revokedId = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transaction_allocations (id, transaction_id, household_id,"
              + " payer_user_id, currency, original_amount, status, created_at, revoked_at)"
              + " SELECT ?, transaction_id, household_id, payer_user_id, currency,"
              + " original_amount, 'REVOKED', created_at, CURRENT_TIMESTAMP"
              + " FROM financial_transaction_allocations WHERE id = ?",
          revokedId,
          allocationId);
      assertThatThrownBy(
              () ->
                  insertAllocation(
                      connection, expenseId, householdId, userId, "USD", "10.00", "ACTIVE"))
          .isInstanceOf(Exception.class);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transaction_allocations"
                      + " WHERE transaction_id = '"
                      + expenseId
                      + "' AND status = 'ACTIVE'"))
          .isEqualTo(1);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM pg_indexes WHERE indexname ="
                      + " 'financial_transaction_allocations_one_active_idx'"))
          .isEqualTo(1);

      // The status allowlist and revocation pairing are enforced by the database itself.
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      connection,
                      "UPDATE financial_transaction_allocations SET status = 'VOIDED'"
                          + " WHERE id = ?",
                      allocationId))
          .isInstanceOf(Exception.class);
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      connection,
                      "UPDATE financial_transaction_allocations SET revoked_at = CURRENT_TIMESTAMP"
                          + " WHERE id = ?",
                      allocationId))
          .isInstanceOf(Exception.class);

      // The magnitude must be positive; foreign and missing expenses are refused by the
      // composite reference to the expense's own household, payer, and currency.
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      connection,
                      "UPDATE financial_transaction_allocations SET original_amount = -10.00"
                          + " WHERE id = ?",
                      allocationId))
          .isInstanceOf(Exception.class);
      assertThatThrownBy(
              () ->
                  insertAllocation(
                      connection, UUID.randomUUID(), householdId, userId, "USD", "10.00", "ACTIVE"))
          .isInstanceOf(Exception.class);
      assertThatThrownBy(
              () ->
                  insertAllocation(
                      connection, expenseId, householdId, userId, "CHF", "10.00", "ACTIVE"))
          .isInstanceOf(Exception.class);

      // A payer that is not the expense's owner cannot mirror the expense through the
      // composite reference.
      assertThatThrownBy(
              () ->
                  insertAllocation(
                      connection,
                      expenseId,
                      householdId,
                      insertUser(connection),
                      "USD",
                      "10.00",
                      "ACTIVE"))
          .isInstanceOf(Exception.class);

      // Whole-unit JPY magnitudes reject fractional values in the database itself.
      UUID jpyAccountId = insertAccount(connection, householdId, userId, "JPY");
      UUID jpyExpenseId =
          insertTransaction(
              connection, householdId, userId, jpyAccountId, "EXPENSE", "-1000", "JPY", null);
      UUID jpyAllocationId =
          insertAllocation(connection, jpyExpenseId, householdId, userId, "JPY", "1000", "ACTIVE");
      insertParticipant(connection, jpyAllocationId, userId, "JPY", "334");
      assertThatThrownBy(
              () ->
                  insertAllocation(
                      connection, jpyExpenseId, householdId, userId, "JPY", "1000.500", "ACTIVE"))
          .isInstanceOf(Exception.class);
      assertThatThrownBy(
              () ->
                  insertParticipant(
                      connection, jpyAllocationId, insertUser(connection), "JPY", "333.500"))
          .isInstanceOf(Exception.class);

      // Contract-valid tiny allocations persist exact ordered zero shares at the currency's
      // scale: JPY 1 across three participants is 1/0/0 in canonical user order and USD 0.01
      // across two is 0.01/0.00, with the persisted shares summing exactly to the magnitude.
      UUID tinyJpySecond = insertUser(connection);
      UUID tinyJpyThird = insertUser(connection);
      UUID tinyJpyPayer =
          java.util.List.of(userId, tinyJpySecond, tinyJpyThird).stream()
              .sorted(java.util.Comparator.comparing(UUID::toString))
              .findFirst()
              .orElseThrow();
      UUID tinyJpyExpenseId =
          insertTransaction(
              connection, householdId, userId, jpyAccountId, "EXPENSE", "-1", "JPY", null);
      UUID tinyJpyAllocationId =
          insertAllocation(connection, tinyJpyExpenseId, householdId, userId, "JPY", "1", "ACTIVE");
      insertParticipant(connection, tinyJpyAllocationId, tinyJpyPayer, "JPY", "1");
      for (UUID other : java.util.List.of(userId, tinyJpySecond, tinyJpyThird)) {
        if (!other.equals(tinyJpyPayer)) {
          insertParticipant(connection, tinyJpyAllocationId, other, "JPY", "0");
        }
      }
      assertThat(
              queryString(
                  connection,
                  "SELECT string_agg(share::text, ',' ORDER BY user_id::text)"
                      + " FROM financial_transaction_allocation_participants"
                      + " WHERE allocation_id = '"
                      + tinyJpyAllocationId
                      + "'"))
          .isEqualTo("1.000,0.000,0.000");
      UUID tinyUsdSecond = insertUser(connection);
      UUID tinyUsdFirst =
          userId.toString().compareTo(tinyUsdSecond.toString()) < 0 ? userId : tinyUsdSecond;
      UUID tinyUsdOther = tinyUsdFirst.equals(userId) ? tinyUsdSecond : userId;
      UUID tinyUsdExpenseId =
          insertTransaction(
              connection, householdId, userId, accountId, "EXPENSE", "-0.01", "USD", null);
      UUID tinyUsdAllocationId =
          insertAllocation(
              connection, tinyUsdExpenseId, householdId, userId, "USD", "0.01", "ACTIVE");
      insertParticipant(connection, tinyUsdAllocationId, tinyUsdFirst, "USD", "0.01");
      insertParticipant(connection, tinyUsdAllocationId, tinyUsdOther, "USD", "0.00");
      assertThat(
              queryString(
                  connection,
                  "SELECT string_agg(share::text, ',' ORDER BY user_id::text)"
                      + " FROM financial_transaction_allocation_participants"
                      + " WHERE allocation_id = '"
                      + tinyUsdAllocationId
                      + "'"))
          .isEqualTo("0.010,0.000");

      // Zero shares are contract-valid exact minor units (tiny magnitudes exhaust the
      // remainder rule); only negative shares are refused by the database itself.
      UUID zeroShareParticipant = insertUser(connection);
      insertParticipant(connection, allocationId, zeroShareParticipant, "USD", "0.00");
      assertThat(
              queryString(
                  connection,
                  "SELECT share::text FROM financial_transaction_allocation_participants"
                      + " WHERE allocation_id = '"
                      + allocationId
                      + "' AND user_id = '"
                      + zeroShareParticipant
                      + "'"))
          .isEqualTo("0.000");
      assertThatThrownBy(
              () ->
                  insertParticipant(
                      connection, allocationId, insertUser(connection), "USD", "-0.01"))
          .isInstanceOf(Exception.class);

      // Restrictive references: removing a user with frozen shares or an allocated expense
      // is refused, so departure never deletes recorded history.
      UUID participantId = insertUser(connection);
      insertParticipant(connection, allocationId, participantId, "USD", "3.34");
      assertThatThrownBy(
              () -> jdbcUpdate(connection, "DELETE FROM users WHERE id = ?", participantId))
          .isInstanceOf(Exception.class);
      assertThatThrownBy(
              () ->
                  jdbcUpdate(
                      connection, "DELETE FROM financial_transactions WHERE id = ?", expenseId))
          .isInstanceOf(Exception.class);

      // The ALLOCATION_CREATE key scope is unique per actor, household, and key.
      UUID keyId = UUID.randomUUID();
      insertAllocationKey(connection, userId, householdId, keyId, allocationId);
      assertThatThrownBy(
              () -> insertAllocationKey(connection, userId, householdId, keyId, allocationId))
          .isInstanceOf(Exception.class);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_allocation_idempotency_keys"
                      + " WHERE idempotency_key = '"
                      + keyId
                      + "'"))
          .isEqualTo(1);
    }
  }

  @Test
  void v8DatabaseUpgradesToV9WithSharingDataIntactAndAllocationsWritable() throws Exception {
    runMigrations("8");
    UUID userId;
    UUID householdId;
    UUID accountId;
    UUID expenseId;
    UUID refundId;
    UUID createKey;
    try (Connection connection = openConnection()) {
      userId = insertUser(connection);
      householdId = insertHousehold(connection, userId);
      accountId = insertAccount(connection, householdId, userId, "BRL");
      expenseId =
          insertTransaction(
              connection,
              householdId,
              userId,
              accountId,
              "EXPENSE",
              "-30.00",
              "BRL",
              null,
              "GROCERIES",
              "HOUSEHOLD");
      refundId =
          insertTransaction(
              connection, householdId, userId, accountId, "REFUND", "10.00", "BRL", expenseId);
      createKey = UUID.randomUUID();
      // A live V8 deployment already holds category/sharing data and transaction create keys.
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
      // Every V8 row, category, and key survives the V9 upgrade unchanged.
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transactions WHERE account_id = '"
                      + accountId
                      + "'"))
          .isEqualTo(2);
      assertThat(
              queryString(
                  connection,
                  "SELECT COALESCE(category, 'NULL') || ':' || visibility || ':' || status"
                      + " FROM financial_transactions WHERE id = '"
                      + expenseId
                      + "'"))
          .isEqualTo("GROCERIES:HOUSEHOLD:POSTED");
      assertThat(
              queryString(
                  connection,
                  "SELECT refund_of_transaction_id::text FROM financial_transactions"
                      + " WHERE id = '"
                      + refundId
                      + "'"))
          .isEqualTo(expenseId.toString());
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transaction_idempotency_keys"
                      + " WHERE idempotency_key = '"
                      + createKey
                      + "'"))
          .isEqualTo(1);

      // Allocations write cleanly against the upgraded schema and read back intact.
      UUID allocationId =
          insertAllocation(connection, expenseId, householdId, userId, "BRL", "30.00", "ACTIVE");
      UUID member = insertUser(connection);
      insertParticipant(connection, allocationId, userId, "BRL", "10.01");
      insertParticipant(connection, allocationId, member, "BRL", "19.99");
      UUID keyId = UUID.randomUUID();
      insertAllocationKey(connection, userId, householdId, keyId, allocationId);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transaction_allocation_participants"
                      + " WHERE allocation_id = '"
                      + allocationId
                      + "'"))
          .isEqualTo(2);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_allocation_idempotency_keys"
                      + " WHERE idempotency_key = '"
                      + keyId
                      + "'"))
          .isEqualTo(1);
      UUID revokedSibling = UUID.randomUUID();
      jdbcUpdate(
          connection,
          "INSERT INTO financial_transaction_allocations (id, transaction_id, household_id,"
              + " payer_user_id, currency, original_amount, status, created_at, revoked_at)"
              + " SELECT ?, transaction_id, household_id, payer_user_id, currency,"
              + " original_amount, 'REVOKED', created_at, CURRENT_TIMESTAMP"
              + " FROM financial_transaction_allocations WHERE id = ?",
          revokedSibling,
          allocationId);
      assertThat(
              queryInt(
                  connection,
                  "SELECT COUNT(*) FROM financial_transaction_allocations"
                      + " WHERE transaction_id = '"
                      + expenseId
                      + "'"))
          .isEqualTo(2);
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
        "Allocation home");
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
            + " VALUES (?, ?, ?, 'Allocation account', 'CHECKING', ?, 'MANUAL', 'PRIVATE',"
            + " 'ACTIVE', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
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
        connection, householdId, userId, accountId, kind, amount, currency, refundOf, null, null);
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
            + " VALUES (?, ?, ?, ?, ?, ?::numeric, ?, ?::date, 'Schema entry', 'MANUAL', ?,"
            + " 'POSTED', "
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
        visibility == null ? "PRIVATE" : visibility);
    return id;
  }

  private UUID insertAllocation(
      Connection connection,
      UUID expenseId,
      UUID householdId,
      UUID payerId,
      String currency,
      String amount,
      String status)
      throws Exception {
    UUID id = UUID.randomUUID();
    jdbcUpdate(
        connection,
        "INSERT INTO financial_transaction_allocations (id, transaction_id, household_id,"
            + " payer_user_id, currency, original_amount, status, created_at, revoked_at)"
            + " VALUES (?, ?, ?, ?, ?, ?::numeric, ?, CURRENT_TIMESTAMP, "
            + ("REVOKED".equals(status) ? "CURRENT_TIMESTAMP" : "NULL")
            + ")",
        id,
        expenseId,
        householdId,
        payerId,
        currency,
        amount,
        status);
    return id;
  }

  private void insertParticipant(
      Connection connection, UUID allocationId, UUID userId, String currency, String share)
      throws Exception {
    jdbcUpdate(
        connection,
        "INSERT INTO financial_transaction_allocation_participants"
            + " (allocation_id, user_id, currency, share)"
            + " VALUES (?, ?, ?, ?::numeric)",
        allocationId,
        userId,
        currency,
        share);
  }

  private void insertAllocationKey(
      Connection connection, UUID actorId, UUID householdId, UUID keyId, UUID allocationId)
      throws Exception {
    jdbcUpdate(
        connection,
        "INSERT INTO financial_allocation_idempotency_keys"
            + " (actor_user_id, household_id, operation, idempotency_key,"
            + " request_fingerprint, resource_id, created_at)"
            + " VALUES (?, ?, 'ALLOCATION_CREATE', ?, ?, ?, CURRENT_TIMESTAMP)",
        actorId,
        householdId,
        keyId,
        "b".repeat(64),
        allocationId);
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

  private int queryInt(Connection connection, String sql) throws Exception {
    try (Statement statement = connection.createStatement();
        ResultSet rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getInt(1);
    }
  }

  private String queryString(Connection connection, String sql) throws Exception {
    try (Statement statement = connection.createStatement();
        ResultSet rows = statement.executeQuery(sql)) {
      assertThat(rows.next()).isTrue();
      return rows.getString(1);
    }
  }
}
