package com.housesync.household.invitation;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationNotFoundException;
import com.housesync.household.invitation.web.InvitationResponses.InvitationCreatedResponse;
import com.housesync.household.web.HouseholdResponse;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Invitation concurrency against real PostgreSQL with an injected clock and start-latch
 * coordination (no sleeps, no in-memory database): concurrent acceptance versus acceptance, and
 * acceptance versus revocation, each produce one winning terminal transition with at most one
 * membership row.
 */
@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class InvitationConcurrencyIT {

  static final Instant FIXED_NOW = Instant.parse("2026-09-13T04:00:00Z");

  @TestConfiguration
  static class FixedClockConfiguration {
    @Bean
    @Primary
    Clock fixedClock() {
      return Clock.fixed(FIXED_NOW, ZoneOffset.UTC);
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
    jdbc.update("DELETE FROM household_invitations");
    jdbc.update("DELETE FROM household_members");
    jdbc.update("DELETE FROM households");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void concurrentAcceptsProduceOneWinnerAndOneMembership() throws Exception {
    UUID owner = seedUser();
    HouseholdResponse household = households.create("Elm Street home", owner);
    InvitationCreatedResponse created = invitations.create(household.id(), owner);
    UUID first = seedUser();
    UUID second = seedUser();

    ExecutorService pool = Executors.newFixedThreadPool(2);
    CountDownLatch start = new CountDownLatch(1);
    try {
      List<Future<AcceptOutcome>> futures = new ArrayList<>();
      for (UUID actor : List.of(first, second)) {
        futures.add(
            pool.submit(
                () -> {
                  start.await(10, TimeUnit.SECONDS);
                  try {
                    HouseholdResponse response =
                        invitations.accept(created.id().toString(), created.secret(), actor);
                    return new AcceptOutcome(actor, true, response.role());
                  } catch (InvitationNotFoundException miss) {
                    return new AcceptOutcome(actor, false, null);
                  }
                }));
      }
      start.countDown();
      AcceptOutcome firstOutcome = futures.get(0).get(60, TimeUnit.SECONDS);
      AcceptOutcome secondOutcome = futures.get(1).get(60, TimeUnit.SECONDS);

      // Exactly one actor wins; the loser sees the generic invitation 404.
      assertThat(List.of(firstOutcome.won(), secondOutcome.won()))
          .containsExactlyInAnyOrder(true, false);
      AcceptOutcome winner = firstOutcome.won() ? firstOutcome : secondOutcome;
      assertThat(winner.role()).isEqualTo("MEMBER");

      // At most one membership row exists beyond the owner: the winner's MEMBER row, and the
      // invitation records them.
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id = ?",
                  Integer.class,
                  household.id()))
          .isEqualTo(2);
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?"
                      + " AND role = 'MEMBER'",
                  Integer.class,
                  household.id(),
                  winner.actor()))
          .isEqualTo(1);
      assertThat(
              jdbc.queryForObject(
                  "SELECT accepted_by_user_id FROM household_invitations WHERE id = ?",
                  UUID.class,
                  created.id()))
          .isEqualTo(winner.actor());
      assertThat(
              jdbc.queryForObject(
                  "SELECT revoked_at FROM household_invitations WHERE id = ?",
                  Timestamp.class,
                  created.id()))
          .isNull();
    } finally {
      pool.shutdownNow();
    }
  }

  @Test
  void concurrentAcceptAndRevokeProduceOneTerminalResult() throws Exception {
    UUID owner = seedUser();
    HouseholdResponse household = households.create("Elm Street home", owner);
    InvitationCreatedResponse created = invitations.create(household.id(), owner);
    UUID recipient = seedUser();

    ExecutorService pool = Executors.newFixedThreadPool(2);
    CountDownLatch start = new CountDownLatch(1);
    try {
      Future<Boolean> accept =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                  invitations.accept(created.id().toString(), created.secret(), recipient);
                  return true;
                } catch (InvitationNotFoundException miss) {
                  return false;
                }
              });
      Future<Boolean> revoke =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                  invitations.revoke(household.id(), created.id(), owner);
                  return true;
                } catch (InvitationNotFoundException miss) {
                  return false;
                }
              });
      start.countDown();
      boolean acceptWon = accept.get(60, TimeUnit.SECONDS);
      boolean revokeWon = revoke.get(60, TimeUnit.SECONDS);

      // Exactly one terminal transition wins.
      assertThat(acceptWon ^ revokeWon).isTrue();
      int memberships =
          jdbc.queryForObject(
              "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?",
              Integer.class,
              household.id(),
              recipient);
      if (acceptWon) {
        assertThat(memberships).isEqualTo(1);
        assertThat(
                jdbc.queryForObject(
                    "SELECT accepted_by_user_id FROM household_invitations WHERE id = ?",
                    UUID.class,
                    created.id()))
            .isEqualTo(recipient);
        // The losing revocation now observes the accepted terminal state.
        try {
          invitations.revoke(household.id(), created.id(), owner);
          assertThat(false).as("revoke of an accepted invitation must fail").isTrue();
        } catch (InvitationNotFoundException expected) {
          // Expected: accepted rows revoke as 404.
        }
      } else {
        assertThat(memberships).isZero();
        assertThat(
                jdbc.queryForObject(
                    "SELECT revoked_at FROM household_invitations WHERE id = ?",
                    Timestamp.class,
                    created.id()))
            .isNotNull();
        // The losing acceptance now observes the revoked terminal state.
        try {
          invitations.accept(created.id().toString(), created.secret(), recipient);
          assertThat(false).as("accept of a revoked invitation must fail").isTrue();
        } catch (InvitationNotFoundException expected) {
          // Expected: revoked rows accept as 404.
        }
      }
    } finally {
      pool.shutdownNow();
    }
  }

  private record AcceptOutcome(UUID actor, boolean won, String role) {}

  @Test
  void concurrentSameActorDoubleAcceptConsumesOnceAndBothSucceed() throws Exception {
    UUID owner = seedUser();
    HouseholdResponse household = households.create("Elm Street home", owner);
    InvitationCreatedResponse created = invitations.create(household.id(), owner);
    UUID recipient = seedUser();

    ExecutorService pool = Executors.newFixedThreadPool(2);
    CountDownLatch start = new CountDownLatch(1);
    try {
      // Whichever attempt locks the row first consumes the invitation; the other observes the
      // recorded accepting actor and replays idempotently. Both succeed either way.
      List<Future<HouseholdResponse>> futures = new ArrayList<>();
      for (int i = 0; i < 2; i++) {
        futures.add(
            pool.submit(
                () -> {
                  start.await(10, TimeUnit.SECONDS);
                  return invitations.accept(created.id().toString(), created.secret(), recipient);
                }));
      }
      start.countDown();
      HouseholdResponse first = futures.get(0).get(60, TimeUnit.SECONDS);
      HouseholdResponse second = futures.get(1).get(60, TimeUnit.SECONDS);
      assertThat(first.id()).isEqualTo(household.id());
      assertThat(second.id()).isEqualTo(household.id());
      assertThat(first.role()).isEqualTo("MEMBER");
      assertThat(second.role()).isEqualTo("MEMBER");

      // Exactly one membership row exists for the actor and the invitation records them once.
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?",
                  Integer.class,
                  household.id(),
                  recipient))
          .isEqualTo(1);
      assertThat(
              jdbc.queryForObject(
                  "SELECT accepted_by_user_id FROM household_invitations WHERE id = ?",
                  UUID.class,
                  created.id()))
          .isEqualTo(recipient);
      assertThat(
              jdbc.queryForObject(
                  "SELECT revoked_at FROM household_invitations WHERE id = ?",
                  Timestamp.class,
                  created.id()))
          .isNull();
    } finally {
      pool.shutdownNow();
    }
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
