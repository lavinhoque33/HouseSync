package com.housesync.household.invitation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Invitation persistence against real PostgreSQL: fresh V5 migration and validation, digest-only
 * storage with no raw-secret column, the seven-day boundary, restrictive foreign keys, rollback,
 * terminal-state checks, and the partial active-list index.
 */
@Testcontainers
class InvitationSchemaIT {

  static final Instant CREATED = Instant.parse("2026-09-13T04:00:00Z");

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  private Properties credentials;

  @BeforeEach
  void migrateFresh() throws Exception {
    credentials = new Properties();
    credentials.setProperty("user", POSTGRES.getUsername());
    credentials.setProperty("password", POSTGRES.getPassword());
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement clean =
            connection.prepareStatement("DROP SCHEMA public CASCADE; CREATE SCHEMA public")) {
      clean.execute();
    }
    Flyway flyway =
        Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .locations("classpath:db/migration")
            .load();
    assertThat(flyway.migrate().migrationsExecuted).isEqualTo(10);
    flyway.validate();
    assertThat(flyway.info().applied()).hasSize(10);
  }

  @Test
  void invitationTableHasExactlyTheContractedColumns() throws Exception {
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement columns =
            connection.prepareStatement(
                "SELECT column_name FROM information_schema.columns"
                    + " WHERE table_schema = 'public' AND table_name = 'household_invitations'"
                    + " ORDER BY ordinal_position")) {
      List<String> names = new ArrayList<>();
      try (ResultSet rows = columns.executeQuery()) {
        while (rows.next()) {
          names.add(rows.getString(1));
        }
      }
      // Digest-only storage: no raw secret, email, role, recipient, status, or provider column.
      assertThat(names)
          .containsExactly(
              "id",
              "household_id",
              "created_by_user_id",
              "secret_hash",
              "created_at",
              "expires_at",
              "accepted_at",
              "accepted_by_user_id",
              "revoked_at");
    }
  }

  @Test
  void secretHashIsUniqueAndConstrainedTo32Bytes() throws Exception {
    Seed seed = seedHousehold();
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(new byte[32]);
    insertInvitation(
        UUID.randomUUID(),
        seed.householdId(),
        seed.userId(),
        digest,
        CREATED,
        CREATED.plusSeconds(7 * 24 * 3600));

    // A second row with the same digest violates the unique secret hash.
    assertThatThrownBy(
            () ->
                insertInvitation(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    digest,
                    CREATED,
                    CREATED.plusSeconds(7 * 24 * 3600)))
        .isInstanceOf(Exception.class);

    // Digests shorter or longer than 32 bytes violate the length check.
    assertThatThrownBy(
            () ->
                insertInvitation(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    new byte[31],
                    CREATED,
                    CREATED.plusSeconds(7 * 24 * 3600)))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(
            () ->
                insertInvitation(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    new byte[33],
                    CREATED,
                    CREATED.plusSeconds(7 * 24 * 3600)))
        .isInstanceOf(Exception.class);

    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement count =
            connection.prepareStatement("SELECT COUNT(*) FROM household_invitations")) {
      try (ResultSet rows = count.executeQuery()) {
        rows.next();
        assertThat(rows.getInt(1)).isEqualTo(1);
      }
    }
  }

  @Test
  void expiryMustBeAfterCreation() throws Exception {
    Seed seed = seedHousehold();
    // Equal instants violate the expiry check.
    assertThatThrownBy(
            () ->
                insertInvitation(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    digest(1),
                    CREATED,
                    CREATED))
        .isInstanceOf(Exception.class);
    // Earlier expiry violates the check as well.
    assertThatThrownBy(
            () ->
                insertInvitation(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    digest(2),
                    CREATED,
                    CREATED.minusSeconds(1)))
        .isInstanceOf(Exception.class);
    // The seven-day boundary stores exactly.
    UUID id = UUID.randomUUID();
    Instant expires = CREATED.plusSeconds(7 * 24 * 3600);
    insertInvitation(id, seed.householdId(), seed.userId(), digest(3), CREATED, expires);
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement select =
            connection.prepareStatement(
                "SELECT expires_at FROM household_invitations WHERE id = ?")) {
      select.setObject(1, id);
      try (ResultSet rows = select.executeQuery()) {
        assertThat(rows.next()).isTrue();
        assertThat(rows.getTimestamp(1).toInstant()).isEqualTo(expires);
      }
    }
  }

  @Test
  void acceptanceFieldsArePairedAndExclusiveWithRevocation() throws Exception {
    Seed seed = seedHousehold();
    // Accepted instant without an actor violates the pairing check.
    assertThatThrownBy(
            () ->
                insertTerminal(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    digest(11),
                    CREATED,
                    CREATED.plusSeconds(3600),
                    CREATED.plusSeconds(60),
                    null,
                    null))
        .isInstanceOf(Exception.class);
    // Accepted actor without an instant violates the pairing check.
    assertThatThrownBy(
            () ->
                insertTerminal(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    digest(12),
                    CREATED,
                    CREATED.plusSeconds(3600),
                    null,
                    seed.userId(),
                    null))
        .isInstanceOf(Exception.class);
    // Acceptance and revocation together violate the exclusivity check.
    assertThatThrownBy(
            () ->
                insertTerminal(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    digest(13),
                    CREATED,
                    CREATED.plusSeconds(3600),
                    CREATED.plusSeconds(60),
                    seed.userId(),
                    CREATED.plusSeconds(120)))
        .isInstanceOf(Exception.class);
    // Paired acceptance alone and revocation alone are valid terminal states.
    insertTerminal(
        UUID.randomUUID(),
        seed.householdId(),
        seed.userId(),
        digest(14),
        CREATED,
        CREATED.plusSeconds(3600),
        CREATED.plusSeconds(60),
        seed.userId(),
        null);
    insertTerminal(
        UUID.randomUUID(),
        seed.householdId(),
        seed.userId(),
        digest(15),
        CREATED,
        CREATED.plusSeconds(3600),
        null,
        null,
        CREATED.plusSeconds(60));
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement count =
            connection.prepareStatement("SELECT COUNT(*) FROM household_invitations")) {
      try (ResultSet rows = count.executeQuery()) {
        rows.next();
        assertThat(rows.getInt(1)).isEqualTo(2);
      }
    }
  }

  @Test
  void foreignKeysStayRestrictive() throws Exception {
    Seed seed = seedHousehold();
    UUID invitationId = UUID.randomUUID();
    insertInvitation(
        invitationId,
        seed.householdId(),
        seed.userId(),
        digest(21),
        CREATED,
        CREATED.plusSeconds(3600));

    // Households, creators, and accepting users referenced by invitations cannot be deleted.
    assertThatThrownBy(() -> update("DELETE FROM households WHERE id = ?", seed.householdId()))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(() -> update("DELETE FROM users WHERE id = ?", seed.userId()))
        .isInstanceOf(Exception.class);

    // Dangling household, creator, and accepter references are rejected.
    assertThatThrownBy(
            () ->
                insertInvitation(
                    UUID.randomUUID(),
                    UUID.randomUUID(),
                    seed.userId(),
                    digest(22),
                    CREATED,
                    CREATED.plusSeconds(3600)))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(
            () ->
                insertInvitation(
                    UUID.randomUUID(),
                    seed.householdId(),
                    UUID.randomUUID(),
                    digest(23),
                    CREATED,
                    CREATED.plusSeconds(3600)))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(
            () ->
                insertTerminal(
                    UUID.randomUUID(),
                    seed.householdId(),
                    seed.userId(),
                    digest(24),
                    CREATED,
                    CREATED.plusSeconds(3600),
                    CREATED.plusSeconds(60),
                    UUID.randomUUID(),
                    null))
        .isInstanceOf(Exception.class);

    // The invitation row itself survives the failed deletions.
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement select =
            connection.prepareStatement(
                "SELECT COUNT(*) FROM household_invitations WHERE id = ?")) {
      select.setObject(1, invitationId);
      try (ResultSet rows = select.executeQuery()) {
        rows.next();
        assertThat(rows.getInt(1)).isEqualTo(1);
      }
    }
  }

  @Test
  void failedInvitationInsertRollsBack() throws Exception {
    Seed seed = seedHousehold();
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials)) {
      connection.setAutoCommit(false);
      try (PreparedStatement insert =
          connection.prepareStatement(
              "INSERT INTO household_invitations (id, household_id, created_by_user_id,"
                  + " secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")) {
        insert.setObject(1, UUID.randomUUID());
        insert.setObject(2, seed.householdId());
        insert.setObject(3, seed.userId());
        insert.setBytes(4, digest(31));
        insert.setTimestamp(5, Timestamp.from(CREATED));
        insert.setTimestamp(6, Timestamp.from(CREATED.plusSeconds(3600)));
        assertThat(insert.executeUpdate()).isEqualTo(1);
      }
      connection.rollback();
      try (PreparedStatement count =
              connection.prepareStatement("SELECT COUNT(*) FROM household_invitations");
          ResultSet rows = count.executeQuery()) {
        rows.next();
        assertThat(rows.getInt(1)).isZero();
      }
    }
  }

  @Test
  void partialActiveListIndexExists() throws Exception {
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement index =
            connection.prepareStatement(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'"
                    + " AND tablename = 'household_invitations'"
                    + " AND indexname = 'household_invitations_active_list_idx'")) {
      try (ResultSet rows = index.executeQuery()) {
        assertThat(rows.next()).isTrue();
        assertThat(rows.getString(1))
            .contains("(household_id, created_at, id)")
            .contains("WHERE")
            .contains("accepted_at IS NULL")
            .contains("revoked_at IS NULL");
      }
    }
  }

  private record Seed(UUID userId, UUID householdId) {}

  private Seed seedHousehold() throws Exception {
    UUID userId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    update(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
        userId,
        "owner" + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test",
        "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000",
        Timestamp.from(CREATED));
    update(
        "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
        householdId,
        "Elm Street home",
        Timestamp.from(CREATED));
    return new Seed(userId, householdId);
  }

  private void insertInvitation(
      UUID id, UUID householdId, UUID creatorId, byte[] digest, Instant created, Instant expires)
      throws Exception {
    insertTerminal(id, householdId, creatorId, digest, created, expires, null, null, null);
  }

  private void insertTerminal(
      UUID id,
      UUID householdId,
      UUID creatorId,
      byte[] digest,
      Instant created,
      Instant expires,
      Instant acceptedAt,
      UUID acceptedBy,
      Instant revokedAt)
      throws Exception {
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement insert =
            connection.prepareStatement(
                "INSERT INTO household_invitations (id, household_id, created_by_user_id,"
                    + " secret_hash, created_at, expires_at, accepted_at, accepted_by_user_id,"
                    + " revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
      insert.setObject(1, id);
      insert.setObject(2, householdId);
      insert.setObject(3, creatorId);
      insert.setBytes(4, digest);
      insert.setTimestamp(5, Timestamp.from(created));
      insert.setTimestamp(6, Timestamp.from(expires));
      if (acceptedAt == null) {
        insert.setTimestamp(7, null);
      } else {
        insert.setTimestamp(7, Timestamp.from(acceptedAt));
      }
      insert.setObject(8, acceptedBy);
      if (revokedAt == null) {
        insert.setTimestamp(9, null);
      } else {
        insert.setTimestamp(9, Timestamp.from(revokedAt));
      }
      assertThat(insert.executeUpdate()).isEqualTo(1);
    }
  }

  private void update(String sql, Object... args) throws Exception {
    try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), credentials);
        PreparedStatement statement = connection.prepareStatement(sql)) {
      for (int i = 0; i < args.length; i++) {
        statement.setObject(i + 1, args[i]);
      }
      statement.executeUpdate();
    }
  }

  private static byte[] digest(int seed) throws Exception {
    return MessageDigest.getInstance("SHA-256").digest(new byte[] {(byte) seed});
  }
}
