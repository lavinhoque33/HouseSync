package com.housesync.household;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.domain.MemberRole;
import com.housesync.household.persistence.HouseholdEntity;
import com.housesync.household.persistence.HouseholdMemberEntity;
import com.housesync.household.persistence.HouseholdMemberRepository;
import com.housesync.household.persistence.HouseholdRepository;
import com.housesync.household.web.HouseholdExceptions;
import com.housesync.household.web.HouseholdResponse;
import com.housesync.identity.web.IdentityExceptions;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Household persistence against real PostgreSQL: V4 constraints, atomic creation, duplicate names,
 * membership uniqueness, restrictive foreign keys, and actor-scoped ordered reads.
 */
@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class HouseholdPersistenceIT {

  static final Instant FIXED_NOW = Instant.parse("2026-09-13T01:30:00.123456789Z");

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

  @Autowired private HouseholdService households;
  @Autowired private HouseholdRepository householdRepository;
  @Autowired private HouseholdMemberRepository memberships;
  @Autowired private JdbcTemplate jdbc;

  @BeforeEach
  void cleanHouseholdTables() {
    jdbc.update("DELETE FROM household_members");
    jdbc.update("DELETE FROM households");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void createAssignsOwnerMembershipAtomically() {
    UUID actor = seedUser();
    HouseholdResponse created = households.create("Elm Street home", actor);

    assertThat(created.id()).isNotNull();
    assertThat(created.name()).isEqualTo("Elm Street home");
    assertThat(created.role()).isEqualTo("OWNER");
    assertThat(created.createdAt()).isEqualTo(FIXED_NOW.truncatedTo(ChronoUnit.MICROS));
    assertThat(households.get(created.id(), actor)).isEqualTo(created);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?"
                    + " AND role = 'OWNER'",
                Integer.class,
                created.id(),
                actor))
        .isEqualTo(1);
  }

  @Test
  void duplicateNamesCreateDistinctHouseholds() {
    UUID actor = seedUser();
    HouseholdResponse first = households.create("Shared name", actor);
    HouseholdResponse second = households.create("Shared name", actor);

    assertThat(first.id()).isNotEqualTo(second.id());
    assertThat(households.list(actor))
        .extracting(HouseholdResponse::id)
        .containsExactlyInAnyOrder(first.id(), second.id());
  }

  @Test
  void multipleHouseholdsPerUserAreAllowed() {
    UUID actor = seedUser();
    households.create("First", actor);
    households.create("Second", actor);
    households.create("Third", actor);

    assertThat(households.list(actor)).hasSize(3);
  }

  @Test
  void createValidatesNameWithoutTouchingTheDatabase() {
    UUID actor = seedUser();
    assertThatThrownBy(() -> households.create("   ", actor))
        .isInstanceOf(IdentityExceptions.ValidationFailedException.class)
        .satisfies(
            failure ->
                assertThat(
                        ((IdentityExceptions.ValidationFailedException) failure).getFieldErrors())
                    .containsKey("name"));
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM households", Integer.class)).isZero();
  }

  @Test
  void listIsScopedToActorAndOrderedByCreatedAtThenId() {
    UUID actor = seedUser();
    UUID outsider = seedUser();
    Instant base = Instant.parse("2026-09-13T01:00:00Z");
    UUID older = seedHousehold("Older", base);
    UUID middleA = seedHousehold("Middle", base.plusSeconds(60));
    UUID middleB = seedHousehold("Middle", base.plusSeconds(60));
    UUID newer = seedHousehold("Newer", base.plusSeconds(120));
    UUID foreign = seedHousehold("Foreign", base.minusSeconds(60));
    for (UUID id : List.of(older, middleA, middleB, newer)) {
      memberships.save(new HouseholdMemberEntity(id, actor, MemberRole.OWNER));
    }
    memberships.save(new HouseholdMemberEntity(foreign, outsider, MemberRole.OWNER));

    List<HouseholdResponse> listed = households.list(actor);
    assertThat(listed).extracting(HouseholdResponse::id).doesNotContain(foreign);
    List<UUID> actual = listed.stream().map(HouseholdResponse::id).toList();
    assertThat(actual.get(0)).isEqualTo(older);
    assertThat(actual.get(3)).isEqualTo(newer);
    // Same instant breaks the tie by ascending ID in PostgreSQL's byte-wise UUID order
    // (Java's UUID.compareTo uses signed longs, so the expected order comes from the database).
    List<UUID> middlePair = actual.subList(1, 3);
    assertThat(middlePair).containsExactlyInAnyOrder(middleA, middleB);
    assertThat(middlePair)
        .containsExactlyElementsOf(
            jdbc.queryForList(
                "SELECT id FROM households WHERE id IN (?, ?) ORDER BY id",
                UUID.class,
                middleA,
                middleB));
    assertThat(listed).allSatisfy(response -> assertThat(response.role()).isEqualTo("OWNER"));
  }

  @Test
  void membershipCompositeKeyRejectsDuplicates() {
    UUID actor = seedUser();
    HouseholdResponse created = households.create("Elm Street home", actor);
    // A second owner row for the same pair violates the composite primary key. Inserted with raw
    // SQL because a repository save on an existing ID would merge (UPDATE) instead of inserting.
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)",
                    created.id(),
                    actor,
                    "OWNER"))
        .isInstanceOf(DataIntegrityViolationException.class);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?",
                Integer.class,
                created.id()))
        .isEqualTo(1);
  }

  @Test
  void removedMembershipMakesDetailNotFound() {
    UUID actor = seedUser();
    HouseholdResponse created = households.create("Elm Street home", actor);
    assertThat(households.get(created.id(), actor).id()).isEqualTo(created.id());

    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ? AND user_id = ?",
        created.id(),
        actor);
    assertThatThrownBy(() -> households.get(created.id(), actor))
        .isInstanceOf(HouseholdExceptions.HouseholdNotFoundException.class);
    assertThat(households.list(actor)).isEmpty();
  }

  @Test
  void seededMemberMembershipReturnsMemberRole() {
    UUID owner = seedUser();
    UUID member = seedUser();
    HouseholdResponse created = households.create("Elm Street home", owner);
    memberships.save(new HouseholdMemberEntity(created.id(), member, MemberRole.MEMBER));

    HouseholdResponse detail = households.get(created.id(), member);
    assertThat(detail.role()).isEqualTo("MEMBER");
    assertThat(detail.id()).isEqualTo(created.id());
    assertThat(detail.name()).isEqualTo("Elm Street home");
    assertThat(households.list(member))
        .extracting(HouseholdResponse::role)
        .containsExactly("MEMBER");
  }

  @Test
  void databaseRejectsUntrimmedBlankOverlengthAndNullNames() {
    UUID id = UUID.randomUUID();
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    id,
                    "  padded  ",
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    UUID.randomUUID(),
                    "   ",
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    UUID.randomUUID(),
                    "n".repeat(101),
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    UUID.randomUUID(),
                    null,
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM households", Integer.class)).isZero();
  }

  @Test
  void databaseRejectsUnicodeWhitespaceAndControlNames() {
    char nbsp = (char) 160;
    char figureSpace = (char) 0x2007;
    // Visually blank names made of space separators are rejected.
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    UUID.randomUUID(),
                    "" + nbsp + figureSpace,
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    // Outer Unicode-whitespace padding is rejected.
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    UUID.randomUUID(),
                    "" + nbsp + "Elm" + figureSpace,
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    // Interior control characters are rejected.
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    UUID.randomUUID(),
                    "Elm" + ((char) 7) + "Street",
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                    UUID.randomUUID(),
                    "Elm" + ((char) 127) + "Street",
                    Timestamp.from(FIXED_NOW)))
        .isInstanceOf(Exception.class);
    // Clean and interior-spaced names (including interior NBSP) still store.
    UUID stored = UUID.randomUUID();
    assertThat(
            jdbc.update(
                "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                stored,
                "Elm" + nbsp + "Street",
                Timestamp.from(FIXED_NOW)))
        .isEqualTo(1);
    // Hyphens and apostrophes are content, never boundary characters.
    UUID hyphenated = UUID.randomUUID();
    assertThat(
            jdbc.update(
                "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)",
                hyphenated,
                "Anne-Marie O'Brien-",
                Timestamp.from(FIXED_NOW)))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM households WHERE id IN (?, ?)",
                Integer.class,
                stored,
                hyphenated))
        .isEqualTo(2);
  }

  @Test
  void databaseRejectsUnknownRoles() {
    UUID actor = seedUser();
    UUID household = seedHousehold("Elm Street home", FIXED_NOW);
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)",
                    household,
                    actor,
                    "ADMIN"))
        .isInstanceOf(Exception.class);
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM household_members", Integer.class))
        .isZero();
  }

  @Test
  void foreignKeysStayRestrictive() {
    UUID actor = seedUser();
    HouseholdResponse created = households.create("Elm Street home", actor);
    assertThatThrownBy(() -> jdbc.update("DELETE FROM households WHERE id = ?", created.id()))
        .isInstanceOf(Exception.class);
    assertThatThrownBy(() -> jdbc.update("DELETE FROM users WHERE id = ?", actor))
        .isInstanceOf(Exception.class);
    assertThat(households.get(created.id(), actor).id()).isEqualTo(created.id());
  }

  @Test
  void failedMembershipInsertRollsBackTheHouseholdRow() {
    UUID missingActor = UUID.randomUUID();
    // No user row exists for this actor, so the membership foreign key fails inside the
    // application's own create transaction; the household insert must roll back with it.
    assertThatThrownBy(() -> households.create("Elm Street home", missingActor))
        .isInstanceOf(RuntimeException.class)
        .hasStackTraceContaining("household_members");
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM households", Integer.class)).isZero();
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM household_members", Integer.class))
        .isZero();
  }

  @Test
  void actorIndexSupportsMembershipScopedLists() {
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public'"
                    + " AND tablename = 'household_members' AND indexname = 'household_members_actor_idx'",
                Integer.class))
        .isEqualTo(1);
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

  private UUID seedHousehold(String name, Instant createdAt) {
    UUID id = UUID.randomUUID();
    householdRepository.save(new HouseholdEntity(id, name, createdAt));
    return id;
  }
}
