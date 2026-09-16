package com.housesync.household;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationForbiddenException;
import com.housesync.household.invitation.web.InvitationResponses.InvitationCreatedResponse;
import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.housesync.household.web.HouseholdExceptions.LastOwnerRequiredException;
import com.housesync.household.web.HouseholdExceptions.MembershipForbiddenException;
import com.housesync.household.web.HouseholdExceptions.MembershipNotFoundException;
import com.housesync.household.web.HouseholdExceptions.MembershipSelfTargetException;
import com.housesync.household.web.HouseholdMemberResponse;
import com.housesync.household.web.HouseholdResponse;
import com.housesync.identity.web.IdentityExceptions;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
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
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Membership lifecycle against real PostgreSQL with an injected clock: roster privacy and ordering,
 * owner/member authorization, idempotent role changes, removal, leave, self-target rejection,
 * missing-target behavior, last-owner safety under concurrency, and invitation-write serialization
 * with role changes. Schema assertions keep the existing V4 membership schema authoritative without
 * a new migration.
 */
@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class HouseholdLifecyclePersistenceIT {

  static final Instant FIXED_NOW = Instant.parse("2026-09-15T08:00:00Z");

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
  @Autowired private InvitationService invitations;
  @Autowired private JdbcTemplate jdbc;

  @BeforeEach
  void cleanTables() {
    jdbc.update("DELETE FROM household_invitations");
    jdbc.update("DELETE FROM household_members");
    jdbc.update("DELETE FROM households");
    jdbc.update("DELETE FROM users");
  }

  // --- roster ---

  @Test
  void rosterShowsEveryCurrentMemberMinimalAndOrderedByEmailThenUserId() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("zeta@example.test");
    UUID other = seedUser("alpha@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");
    seedMembership(household.id(), other, "MEMBER");

    List<HouseholdMemberResponse> roster = households.listMembers(household.id(), owner);

    // Minimal {userId, email, role} projection ordered by email then user UUID; nothing else is
    // exposed.
    assertThat(roster)
        .containsExactly(
            new HouseholdMemberResponse(other, "alpha@example.test", "MEMBER"),
            new HouseholdMemberResponse(owner, "owner@example.test", "OWNER"),
            new HouseholdMemberResponse(member, "zeta@example.test", "MEMBER"));

    // Every current member sees the same roster, including themselves.
    assertThat(households.listMembers(household.id(), member)).isEqualTo(roster);
  }

  @Test
  void rosterRequiresCurrentActorMembershipWithGenericHouseholdNotFound() {
    UUID owner = seedUser("owner@example.test");
    UUID outsider = seedUser("outsider@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);

    // A non-member actor and a missing household share the generic household 404.
    assertThatThrownBy(() -> households.listMembers(household.id(), outsider))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThatThrownBy(() -> households.listMembers(UUID.randomUUID(), owner))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  @Test
  void rosterStaysCurrentAfterRemoval() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");

    households.removeMember(household.id(), member, owner);
    assertThat(households.listMembers(household.id(), owner))
        .containsExactly(new HouseholdMemberResponse(owner, "owner@example.test", "OWNER"));

    // The removed member no longer sees the roster either.
    assertThatThrownBy(() -> households.listMembers(household.id(), member))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  // --- role changes ---

  @Test
  void ownersPromoteAndDemoteMembersWithEqualAuthority() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    UUID third = seedUser("third@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");
    seedMembership(household.id(), third, "MEMBER");

    HouseholdMemberResponse promoted =
        households.updateMemberRole(household.id(), member, "OWNER", owner);
    assertThat(promoted)
        .isEqualTo(new HouseholdMemberResponse(member, "member@example.test", "OWNER"));
    assertThat(storedRole(household.id(), member)).isEqualTo("OWNER");

    // The new co-owner has equal authority: they promote another member and demote the original
    // owner. No hidden creator privilege exists.
    assertThat(households.updateMemberRole(household.id(), third, "OWNER", member).role())
        .isEqualTo("OWNER");
    assertThat(storedRole(household.id(), third)).isEqualTo("OWNER");
    assertThat(households.updateMemberRole(household.id(), owner, "MEMBER", member).role())
        .isEqualTo("MEMBER");
    assertThat(storedRole(household.id(), owner)).isEqualTo("MEMBER");
    // The demoted actor keeps their membership row, now as MEMBER.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?",
                Integer.class,
                household.id(),
                owner))
        .isEqualTo(1);
  }

  @Test
  void roleAssignmentIsIdempotentWhenRoleAlreadyMatches() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");

    HouseholdMemberResponse before =
        households.listMembers(household.id(), owner).stream()
            .filter(response -> response.userId().equals(member))
            .findFirst()
            .orElseThrow();

    // Re-assigning MEMBER to a MEMBER succeeds without changing anything.
    assertThat(households.updateMemberRole(household.id(), member, "MEMBER", owner))
        .isEqualTo(before);
    assertThat(storedRole(household.id(), member)).isEqualTo("MEMBER");

    // Promoting twice is idempotent too.
    households.updateMemberRole(household.id(), member, "OWNER", owner);
    assertThat(households.updateMemberRole(household.id(), member, "OWNER", owner).role())
        .isEqualTo("OWNER");
    assertThat(storedRole(household.id(), member)).isEqualTo("OWNER");
  }

  @Test
  void strictRoleValuesOnlyAcceptCanonicalNames() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");

    for (String rawRole : Arrays.asList(null, "", "owner", "member", "ADMIN", " OWNER", "OWNER ")) {
      assertThatThrownBy(() -> households.updateMemberRole(household.id(), member, rawRole, owner))
          .isInstanceOf(IdentityExceptions.ValidationFailedException.class)
          .satisfies(
              failure ->
                  assertThat(
                          ((IdentityExceptions.ValidationFailedException) failure).getFieldErrors())
                      .containsOnlyKeys("role"));
    }
    assertThat(storedRole(household.id(), member)).isEqualTo("MEMBER");
  }

  // --- authorization and targeting ---

  @Test
  void nonOwnerMemberCannotMutateAnotherMembership() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    UUID other = seedUser("other@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");
    seedMembership(household.id(), other, "MEMBER");

    assertThatThrownBy(() -> households.updateMemberRole(household.id(), other, "OWNER", member))
        .isInstanceOf(MembershipForbiddenException.class);
    assertThatThrownBy(() -> households.removeMember(household.id(), other, member))
        .isInstanceOf(MembershipForbiddenException.class);
    assertThat(storedRole(household.id(), other)).isEqualTo("MEMBER");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?",
                Integer.class,
                household.id(),
                other))
        .isEqualTo(1);
  }

  @Test
  void ownerTargetEndpointsRejectSelfTargeting() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");

    assertThatThrownBy(() -> households.updateMemberRole(household.id(), owner, "MEMBER", owner))
        .isInstanceOf(MembershipSelfTargetException.class);
    assertThatThrownBy(() -> households.removeMember(household.id(), owner, owner))
        .isInstanceOf(MembershipSelfTargetException.class);
    assertThat(storedRole(household.id(), owner)).isEqualTo("OWNER");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?",
                Integer.class,
                household.id()))
        .isEqualTo(2);
  }

  @Test
  void missingTargetIsMembershipNotFoundWhileMissingOrForeignHouseholdIsHouseholdNotFound() {
    UUID owner = seedUser("owner@example.test");
    UUID stranger = seedUser("stranger@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    households.create("Stranger home", stranger);

    // A target that is not a current member is the generic membership 404, without leaking
    // whether the user exists elsewhere.
    assertThatThrownBy(
            () -> households.updateMemberRole(household.id(), UUID.randomUUID(), "MEMBER", owner))
        .isInstanceOf(MembershipNotFoundException.class);
    assertThatThrownBy(() -> households.removeMember(household.id(), UUID.randomUUID(), owner))
        .isInstanceOf(MembershipNotFoundException.class);

    // Missing households and non-member actors share the generic household 404 on every route.
    assertThatThrownBy(
            () ->
                households.updateMemberRole(UUID.randomUUID(), UUID.randomUUID(), "MEMBER", owner))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThatThrownBy(
            () -> households.updateMemberRole(household.id(), stranger, "MEMBER", stranger))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThatThrownBy(() -> households.removeMember(household.id(), owner, stranger))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThatThrownBy(() -> households.leave(household.id(), stranger))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  // --- removal and leave ---

  @Test
  void ownerRemovesACoOwnerWhileAnotherOwnerRemains() {
    UUID firstOwner = seedUser("firstowner@example.test");
    UUID coOwner = seedUser("coowner@example.test");
    UUID remainingOwner = seedUser("remaining@example.test");
    HouseholdResponse household = households.create("Elm Street home", firstOwner);
    seedMembership(household.id(), coOwner, "MEMBER");
    seedMembership(household.id(), remainingOwner, "MEMBER");
    households.updateMemberRole(household.id(), coOwner, "OWNER", firstOwner);
    households.updateMemberRole(household.id(), remainingOwner, "OWNER", firstOwner);

    households.removeMember(household.id(), coOwner, firstOwner);

    // The removed co-owner loses household access immediately, and the two remaining owners
    // keep the household with exactly one owner row each.
    assertThatThrownBy(() -> households.listMembers(household.id(), coOwner))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThatThrownBy(() -> households.leave(household.id(), coOwner))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?"
                    + " AND role = 'OWNER'",
                Integer.class,
                household.id()))
        .isEqualTo(2);
    assertThat(storedRole(household.id(), firstOwner)).isEqualTo("OWNER");
    assertThat(storedRole(household.id(), remainingOwner)).isEqualTo("OWNER");
  }

  @Test
  void ownerRemovesAnotherMemberWithoutTouchingAnyoneElse() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    UUID other = seedUser("other@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");
    seedMembership(household.id(), other, "MEMBER");

    households.removeMember(household.id(), member, owner);

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?",
                Integer.class,
                household.id(),
                member))
        .isZero();
    assertThat(storedRole(household.id(), owner)).isEqualTo("OWNER");
    assertThat(storedRole(household.id(), other)).isEqualTo("MEMBER");
  }

  @Test
  void currentMemberLeavesThroughTheDedicatedOperation() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");

    households.leave(household.id(), member);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?",
                Integer.class,
                household.id(),
                member))
        .isZero();

    // Leaving again is the generic household 404, never a second removal.
    assertThatThrownBy(() -> households.leave(household.id(), member))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  @Test
  void lastOwnerCannotLeave() {
    UUID owner = seedUser("owner@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);

    assertThatThrownBy(() -> households.leave(household.id(), owner))
        .isInstanceOf(LastOwnerRequiredException.class);
    assertThat(storedRole(household.id(), owner)).isEqualTo("OWNER");
  }

  @Test
  void ownerCanLeaveWhenACoOwnerRemains() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");
    households.updateMemberRole(household.id(), member, "OWNER", owner);

    households.leave(household.id(), owner);

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?",
                Integer.class,
                household.id()))
        .isEqualTo(1);
    assertThat(storedRole(household.id(), member)).isEqualTo("OWNER");
  }

  @Test
  void demotedActorLosesOwnerPowersButKeepsMembership() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");

    // Promote, then demote: the actor ends as MEMBER while the owner stays in place.
    households.updateMemberRole(household.id(), member, "OWNER", owner);
    InvitationCreatedResponse invitation = invitations.create(household.id(), owner);
    households.updateMemberRole(household.id(), member, "MEMBER", owner);

    assertThat(storedRole(household.id(), member)).isEqualTo("MEMBER");
    // The demoted actor keeps membership but needs owner authority again to mutate others.
    assertThatThrownBy(() -> households.updateMemberRole(household.id(), owner, "MEMBER", member))
        .isInstanceOf(MembershipForbiddenException.class);
    // A demoted owner cannot commit owner-authorized invitation writes: create, list, or revoke
    // an invitation that was active at demotion time.
    assertThatThrownBy(() -> invitations.create(household.id(), member))
        .isInstanceOf(InvitationForbiddenException.class);
    assertThatThrownBy(() -> invitations.listActive(household.id(), member))
        .isInstanceOf(InvitationForbiddenException.class);
    assertThatThrownBy(() -> invitations.revoke(household.id(), invitation.id(), member))
        .isInstanceOf(InvitationForbiddenException.class);
    // The stale revocation changed nothing: the invitation remains active, and a current owner
    // can still revoke it.
    assertThat(
            jdbc.queryForObject(
                "SELECT revoked_at IS NULL AND accepted_at IS NULL FROM household_invitations"
                    + " WHERE id = ?",
                Boolean.class,
                invitation.id()))
        .isTrue();
    invitations.revoke(household.id(), invitation.id(), owner);
    assertThat(
            jdbc.queryForObject(
                "SELECT revoked_at IS NULL FROM household_invitations WHERE id = ?",
                Boolean.class,
                invitation.id()))
        .isFalse();
  }

  @Test
  void removedMemberLosesHouseholdAndInvitationAccessImmediately() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");

    households.removeMember(household.id(), member, owner);

    // Every route re-resolves current membership: the removed member gets the generic household
    // 404 on reads and leaves, and cannot commit invitation writes.
    assertThatThrownBy(() -> households.listMembers(household.id(), member))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThatThrownBy(() -> households.leave(household.id(), member))
        .isInstanceOf(HouseholdNotFoundException.class);
    assertThatThrownBy(() -> invitations.create(household.id(), member))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  // --- concurrency ---

  @Test
  void concurrentLeavesOfTwoOwnersKeepOneOwner() throws Exception {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), member, "MEMBER");
    households.updateMemberRole(household.id(), member, "OWNER", owner);

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<Boolean> ownerLeaves =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                  households.leave(household.id(), owner);
                  return true;
                } catch (LastOwnerRequiredException blocked) {
                  return false;
                }
              });
      Future<Boolean> memberLeaves =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                  households.leave(household.id(), member);
                  return true;
                } catch (LastOwnerRequiredException blocked) {
                  return false;
                }
              });
      start.countDown();
      boolean ownerLeft = ownerLeaves.get(60, TimeUnit.SECONDS);
      boolean memberLeft = memberLeaves.get(60, TimeUnit.SECONDS);

      // The lifecycle lock serializes the leaves: one succeeds, the other observes the
      // last-owner invariant, and exactly one OWNER row remains.
      assertThat(ownerLeft ^ memberLeft).isTrue();
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id = ?"
                      + " AND role = 'OWNER'",
                  Integer.class,
                  household.id()))
          .isEqualTo(1);
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id = ?",
                  Integer.class,
                  household.id()))
          .isEqualTo(1);
    } finally {
      pool.shutdownNow();
      pool.awaitTermination(30, TimeUnit.SECONDS);
    }
  }

  @Test
  void concurrentDemotionsOfTwoOwnersNeverRemoveTheFinalOwner() throws Exception {
    UUID owner = seedUser("owner@example.test");
    UUID coOwner = seedUser("coowner@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), coOwner, "MEMBER");
    households.updateMemberRole(household.id(), coOwner, "OWNER", owner);

    // Each co-owner demotes the other. Serialized by the household lock, the second attempt has
    // already lost owner authority, so the household keeps one owner.
    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<Boolean> ownerDemotes =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                  households.updateMemberRole(household.id(), coOwner, "MEMBER", owner);
                  return true;
                } catch (MembershipForbiddenException lostAuthority) {
                  return false;
                }
              });
      Future<Boolean> coOwnerDemotes =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                  households.updateMemberRole(household.id(), owner, "MEMBER", coOwner);
                  return true;
                } catch (MembershipForbiddenException lostAuthority) {
                  return false;
                }
              });
      start.countDown();
      boolean ownerDemoted = ownerDemotes.get(60, TimeUnit.SECONDS);
      boolean coOwnerDemoted = coOwnerDemotes.get(60, TimeUnit.SECONDS);

      // Exactly one demotion commits; the loser is no longer an owner and is denied.
      assertThat(ownerDemoted ^ coOwnerDemoted).isTrue();
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id = ?"
                      + " AND role = 'OWNER'",
                  Integer.class,
                  household.id()))
          .isEqualTo(1);
    } finally {
      pool.shutdownNow();
      pool.awaitTermination(30, TimeUnit.SECONDS);
    }
  }

  @Test
  void concurrentDemotionAndInvitationCreateSerialize() throws Exception {
    UUID owner = seedUser("owner@example.test");
    UUID coOwner = seedUser("coowner@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);
    seedMembership(household.id(), coOwner, "MEMBER");
    households.updateMemberRole(household.id(), coOwner, "OWNER", owner);

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<Boolean> demotion =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                households.updateMemberRole(household.id(), owner, "MEMBER", coOwner);
                return true;
              });
      Future<Boolean> creation =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                  invitations.create(household.id(), owner);
                  return true;
                } catch (InvitationForbiddenException staleOwner) {
                  return false;
                }
              });
      start.countDown();
      boolean demoted = demotion.get(60, TimeUnit.SECONDS);
      boolean created = creation.get(60, TimeUnit.SECONDS);

      // The demotion always completes: the lock guarantees the invitation write either commits
      // before it (owner still current) or is denied after it (stale owner).
      assertThat(demoted).isTrue();
      assertThat(storedRole(household.id(), owner)).isEqualTo("MEMBER");
      int invitationRows =
          jdbc.queryForObject(
              "SELECT COUNT(*) FROM household_invitations WHERE household_id = ?",
              Integer.class,
              household.id());
      assertThat(created).isEqualTo(invitationRows == 1);
      if (!created) {
        assertThat(invitationRows).isZero();
      }
    } finally {
      pool.shutdownNow();
      pool.awaitTermination(30, TimeUnit.SECONDS);
    }
  }

  // --- schema authority ---

  @Test
  void membershipSchemaKeepsCompositeKeyRoleConstraintAndForeignKeys() {
    // The lifecycle only changes role values or removes rows, so the V4 membership schema stays
    // authoritative and no migration is needed.
    List<String> primaryKey =
        jdbc.queryForList(
            "SELECT a.attname FROM pg_index i"
                + " JOIN pg_class c ON c.oid = i.indrelid"
                + " JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)"
                + " WHERE c.relname = 'household_members' AND i.indisprimary",
            String.class);
    assertThat(primaryKey).containsExactlyInAnyOrder("household_id", "user_id");

    String checkClause =
        jdbc.queryForObject(
            "SELECT check_clause FROM information_schema.check_constraints"
                + " WHERE constraint_name = 'household_members_role_check'",
            String.class);
    assertThat(checkClause).contains("OWNER").contains("MEMBER");

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM information_schema.table_constraints"
                    + " WHERE table_name = 'household_members'"
                    + " AND constraint_type = 'FOREIGN KEY'",
                Integer.class))
        .isEqualTo(2);

    assertThat(
            jdbc.queryForObject(
                "SELECT is_nullable FROM information_schema.columns"
                    + " WHERE table_name = 'household_members' AND column_name = 'role'",
                String.class))
        .isEqualTo("NO");
  }

  @Test
  void databaseRejectsUnknownRoleValues() {
    UUID owner = seedUser("owner@example.test");
    UUID member = seedUser("member@example.test");
    HouseholdResponse household = households.create("Elm Street home", owner);

    assertThatThrownBy(
            () ->
                jdbc.update(
                    "INSERT INTO household_members (household_id, user_id, role)"
                        + " VALUES (?, ?, 'ADMIN')",
                    household.id(),
                    member))
        .isInstanceOf(DataIntegrityViolationException.class);
    assertThat(storedRole(household.id(), owner)).isEqualTo("OWNER");
  }

  // --- helpers ---

  private UUID seedUser(String email) {
    UUID id = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
        id,
        email,
        "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000",
        Timestamp.from(FIXED_NOW));
    return id;
  }

  private void seedMembership(UUID householdId, UUID userId, String role) {
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)",
        householdId,
        userId,
        role);
  }

  private String storedRole(UUID householdId, UUID userId) {
    List<String> roles =
        jdbc.queryForList(
            "SELECT role FROM household_members WHERE household_id = ? AND user_id = ?",
            String.class,
            householdId,
            userId);
    return roles.isEmpty() ? null : roles.get(0);
  }
}
