package com.housesync.household.invitation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.invitation.application.InvitationSecrets;
import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.persistence.InvitationRepository;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationServiceException;
import com.housesync.household.invitation.web.InvitationResponses.InvitationCreatedResponse;
import com.housesync.household.persistence.HouseholdMemberRepository;
import com.housesync.household.persistence.HouseholdRepository;
import com.housesync.household.web.HouseholdResponse;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Digest-collision handling against real PostgreSQL with an injected clock and a scripted secret
 * source (no sleeps, no in-memory database): one server-side regeneration attempt succeeds, while a
 * second consecutive collision fails safe without exposing either value.
 */
@SpringBootTest
@Testcontainers
class InvitationCollisionIT {

  static final Instant FIXED_NOW = Instant.parse("2026-09-13T04:00:00Z");

  static final Deque<String> SCRIPTED_SECRETS = new ArrayDeque<>();

  @TestConfiguration
  static class FixedClockConfiguration {
    @Bean
    @Primary
    Clock fixedClock() {
      return Clock.fixed(FIXED_NOW, ZoneOffset.UTC);
    }
  }

  @TestConfiguration
  static class ScriptedSecretsConfiguration {
    @Bean
    @Primary
    InvitationService scriptedInvitationService(
        InvitationRepository invitations,
        HouseholdRepository households,
        HouseholdMemberRepository memberships,
        JdbcTemplate jdbc,
        PlatformTransactionManager transactions,
        Clock clock) {
      return new InvitationService(
          invitations, households, memberships, jdbc, transactions, clock) {
        @Override
        protected String newSecret() {
          String scripted = SCRIPTED_SECRETS.poll();
          return scripted != null ? scripted : super.newSecret();
        }
      };
    }
  }

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @DynamicPropertySource
  static void databaseProperties(DynamicPropertyRegistry registry) {
    registry.add("DB_HOST", POSTGRES::getHost);
    registry.add("DB_PORT", POSTGRES::getFirstMappedPort);
    registry.add("DB_NAME", POSTGRES::getDatabaseName);
    registry.add("DB_USER", POSTGRES::getUsername);
    registry.add("DB_PASSWORD", POSTGRES::getPassword);
  }

  @Autowired private InvitationService invitations;
  @Autowired private HouseholdService households;
  @Autowired private JdbcTemplate jdbc;

  @BeforeEach
  void cleanTables() {
    SCRIPTED_SECRETS.clear();
    jdbc.update("DELETE FROM household_invitations");
    jdbc.update("DELETE FROM household_members");
    jdbc.update("DELETE FROM households");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void singleCollisionRegeneratesOnceThenSucceeds() {
    UUID owner = seedUser();
    HouseholdResponse household = households.create("Elm Street home", owner);
    String colliding = InvitationSecrets.generate();
    insertWithDigest(UUID.randomUUID(), household.id(), owner, digestOf(colliding));
    String fresh = InvitationSecrets.generate();
    SCRIPTED_SECRETS.add(colliding);
    SCRIPTED_SECRETS.add(fresh);

    InvitationCreatedResponse created = invitations.create(household.id(), owner);

    assertThat(created.secret()).isEqualTo(fresh);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_invitations WHERE household_id = ?",
                Integer.class,
                household.id()))
        .isEqualTo(2);
    assertThat(SCRIPTED_SECRETS).isEmpty();
  }

  @Test
  void doubleCollisionFailsSafeWithoutNewRow() {
    UUID owner = seedUser();
    HouseholdResponse household = households.create("Elm Street home", owner);
    String colliding = InvitationSecrets.generate();
    insertWithDigest(UUID.randomUUID(), household.id(), owner, digestOf(colliding));
    SCRIPTED_SECRETS.add(colliding);
    SCRIPTED_SECRETS.add(colliding);

    assertThatThrownBy(() -> invitations.create(household.id(), owner))
        .isInstanceOf(InvitationServiceException.class);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_invitations WHERE household_id = ?",
                Integer.class,
                household.id()))
        .isEqualTo(1);
  }

  private void insertWithDigest(UUID id, UUID householdId, UUID creatorId, byte[] digest) {
    jdbc.update(
        "INSERT INTO household_invitations (id, household_id, created_by_user_id, secret_hash,"
            + " created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        householdId,
        creatorId,
        digest,
        Timestamp.from(FIXED_NOW),
        Timestamp.from(FIXED_NOW.plus(InvitationService.INVITATION_TTL)));
  }

  private static byte[] digestOf(String secret) {
    return InvitationSecrets.sha256(InvitationSecrets.decodeStrict(secret));
  }

  private UUID seedUser() {
    UUID id = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
        id,
        "member" + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test",
        "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000",
        Timestamp.from(FIXED_NOW));
    return id;
  }
}
