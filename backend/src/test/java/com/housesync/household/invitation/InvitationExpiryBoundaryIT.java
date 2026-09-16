package com.housesync.household.invitation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationNotFoundException;
import com.housesync.household.invitation.web.InvitationResponses.InvitationCreatedResponse;
import com.housesync.household.web.HouseholdResponse;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
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
 * Exact expiry boundary against real PostgreSQL with an adjustable injected clock (no wall-clock
 * backdating, no sleeps): one microsecond before {@code expires_at} the capability is fully usable,
 * while at exactly {@code expires_at} preview, acceptance, listing, and revocation all report the
 * capability as unavailable without consuming or creating anything.
 */
@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class InvitationExpiryBoundaryIT {

  static final Instant CREATED = Instant.parse("2026-09-13T04:00:00Z");
  static final AtomicReference<Instant> NOW = new AtomicReference<>(CREATED);

  @TestConfiguration
  static class AdjustableClockConfiguration {
    @Bean
    @Primary
    Clock adjustableClock() {
      return new Clock() {
        @Override
        public ZoneId getZone() {
          return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
          return this;
        }

        @Override
        public Instant instant() {
          return NOW.get();
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
    NOW.set(CREATED);
    jdbc.update("DELETE FROM household_invitations");
    jdbc.update("DELETE FROM household_members");
    jdbc.update("DELETE FROM households");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void expiryInstantIsUnavailableButOneMicroBeforeIsActive() {
    UUID owner = seedUser();
    UUID recipient = seedUser();
    HouseholdResponse household = households.create("Elm Street home", owner);
    InvitationCreatedResponse created = invitations.create(household.id(), owner);
    Instant expires = created.expiresAt();
    assertThat(expires).isEqualTo(CREATED.plus(InvitationService.INVITATION_TTL));

    // One microsecond before expiry the capability is fully usable.
    NOW.set(expires.minus(1, ChronoUnit.MICROS));
    assertThat(invitations.preview(created.id().toString(), created.secret()).expiresAt())
        .isEqualTo(expires);
    assertThat(invitations.listActive(household.id(), owner)).hasSize(1);

    // At exactly expiresAt the capability is expired: preview, acceptance, listing, and
    // revocation all report it as unavailable.
    NOW.set(expires);
    assertThatThrownBy(() -> invitations.preview(created.id().toString(), created.secret()))
        .isInstanceOf(InvitationNotFoundException.class);
    assertThatThrownBy(
            () -> invitations.accept(created.id().toString(), created.secret(), recipient))
        .isInstanceOf(InvitationNotFoundException.class);
    assertThat(invitations.listActive(household.id(), owner)).isEmpty();
    assertThatThrownBy(() -> invitations.revoke(household.id(), created.id(), owner))
        .isInstanceOf(InvitationNotFoundException.class);

    // Nothing was consumed or created at the boundary: only the owner membership remains and
    // the row stays in its unaccepted, unrevoked terminal-free state.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?",
                Integer.class,
                household.id()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_invitations WHERE id = ?"
                    + " AND accepted_at IS NULL AND revoked_at IS NULL",
                Integer.class,
                created.id()))
        .isEqualTo(1);
  }

  private UUID seedUser() {
    UUID id = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
        id,
        "member" + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test",
        "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000",
        Timestamp.from(CREATED));
    return id;
  }
}
