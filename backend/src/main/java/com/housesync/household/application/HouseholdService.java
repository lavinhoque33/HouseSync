package com.housesync.household.application;

import com.housesync.household.domain.HouseholdNamePolicy;
import com.housesync.household.domain.MemberRole;
import com.housesync.household.domain.MemberRolePolicy;
import com.housesync.household.persistence.HouseholdEntity;
import com.housesync.household.persistence.HouseholdMemberEntity;
import com.housesync.household.persistence.HouseholdMemberId;
import com.housesync.household.persistence.HouseholdMemberRepository;
import com.housesync.household.persistence.HouseholdRepository;
import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.housesync.household.web.HouseholdExceptions.LastOwnerRequiredException;
import com.housesync.household.web.HouseholdExceptions.MembershipForbiddenException;
import com.housesync.household.web.HouseholdExceptions.MembershipNotFoundException;
import com.housesync.household.web.HouseholdExceptions.MembershipSelfTargetException;
import com.housesync.household.web.HouseholdMemberResponse;
import com.housesync.household.web.HouseholdResponse;
import com.housesync.identity.web.IdentityExceptions;
import jakarta.persistence.EntityManager;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Household create/access and membership lifecycle use cases.
 *
 * <p>The actor always comes from the authenticated {@code HouseSyncUserDetails} UUID supplied by
 * the controller; request bodies never assign ownership. Creation inserts the household and its
 * creator {@code OWNER} membership in one transaction so no household can exist without its owner
 * row. Reads resolve the household and the caller's current role together in one membership-scoped
 * database query on every request.
 *
 * <p>Every membership mutation locks the household row for update before resolving actor and target
 * roles, so role changes, removal, and leave serialize per household and concurrent mutations can
 * never remove the final owner. Owner-authorized invitation writes take the same lock, so a stale
 * owner cannot commit an invitation write after a completed demotion.
 */
@Service
public class HouseholdService {

  private final HouseholdRepository households;
  private final HouseholdMemberRepository memberships;
  private final Clock clock;
  private final EntityManager entityManager;

  public HouseholdService(
      HouseholdRepository households,
      HouseholdMemberRepository memberships,
      Clock clock,
      EntityManager entityManager) {
    this.households = households;
    this.memberships = memberships;
    this.clock = clock;
    this.entityManager = entityManager;
  }

  /** Creates a household and its creator {@code OWNER} membership atomically. */
  @Transactional
  public HouseholdResponse create(String rawName, UUID actorId) {
    HouseholdNamePolicy.violation(rawName)
        .ifPresent(
            message -> {
              throw new IdentityExceptions.ValidationFailedException(Map.of("name", message));
            });
    String name = HouseholdNamePolicy.normalize(rawName);
    UUID id = UUID.randomUUID();
    Instant createdAt = Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
    households.save(new HouseholdEntity(id, name, createdAt));
    memberships.save(new HouseholdMemberEntity(id, actorId, MemberRole.OWNER));
    return new HouseholdResponse(id, name, MemberRole.OWNER.name(), createdAt);
  }

  /** Lists the actor's households ordered by creation instant then ID. */
  @Transactional(readOnly = true)
  public List<HouseholdResponse> list(UUID actorId) {
    return memberships.findAllScopedForActor(actorId).stream()
        .map(HouseholdService::toResponse)
        .toList();
  }

  /**
   * Returns the household with the actor's current role in one membership-scoped query, else the
   * generic 404 for both missing and non-member households.
   */
  @Transactional(readOnly = true)
  public HouseholdResponse get(UUID householdId, UUID actorId) {
    return memberships
        .findScopedByHouseholdAndActor(householdId, actorId)
        .map(HouseholdService::toResponse)
        .orElseThrow(HouseholdNotFoundException::new);
  }

  /** Returns the minimal roster only while the actor is a current member. */
  @Transactional(readOnly = true)
  public List<HouseholdMemberResponse> listMembers(UUID householdId, UUID actorId) {
    List<HouseholdMemberView> roster = memberships.findRosterScopedForActor(householdId, actorId);
    if (roster.isEmpty()) {
      throw new HouseholdNotFoundException();
    }
    return roster.stream().map(HouseholdService::toMemberResponse).toList();
  }

  /**
   * Changes another member's role under the household's lifecycle lock. The requested role is
   * validated against the strict policy before the lock resolves target state; assigning the
   * current role is idempotent.
   */
  @Transactional
  public HouseholdMemberResponse updateMemberRole(
      UUID householdId, UUID targetUserId, String rawRole, UUID actorId) {
    MemberRolePolicy.violation(rawRole)
        .ifPresent(
            message -> {
              throw new IdentityExceptions.ValidationFailedException(Map.of("role", message));
            });
    MemberRole requestedRole = MemberRole.valueOf(rawRole);
    HouseholdMemberEntity actor = lockAndRequireMembership(householdId, actorId);
    requireOwner(actor);
    requireOtherActor(targetUserId, actorId);
    HouseholdMemberEntity target = requireMembership(householdId, targetUserId);
    if (target.getRole() == requestedRole) {
      return memberResponse(householdId, targetUserId);
    }
    if (target.getRole() == MemberRole.OWNER
        && requestedRole == MemberRole.MEMBER
        && memberships.countByHouseholdIdAndRole(householdId, MemberRole.OWNER) == 1) {
      throw new LastOwnerRequiredException();
    }
    target.setRole(requestedRole);
    memberships.save(target);
    return memberResponse(householdId, targetUserId);
  }

  /** Removes another current member under the household's lifecycle lock. */
  @Transactional
  public void removeMember(UUID householdId, UUID targetUserId, UUID actorId) {
    HouseholdMemberEntity actor = lockAndRequireMembership(householdId, actorId);
    requireOwner(actor);
    requireOtherActor(targetUserId, actorId);
    HouseholdMemberEntity target = requireMembership(householdId, targetUserId);
    if (target.getRole() == MemberRole.OWNER
        && memberships.countByHouseholdIdAndRole(householdId, MemberRole.OWNER) == 1) {
      throw new LastOwnerRequiredException();
    }
    memberships.delete(target);
  }

  /** Removes the actor's own membership unless it is the household's final owner. */
  @Transactional
  public void leave(UUID householdId, UUID actorId) {
    HouseholdMemberEntity actor = lockAndRequireMembership(householdId, actorId);
    if (actor.getRole() == MemberRole.OWNER
        && memberships.countByHouseholdIdAndRole(householdId, MemberRole.OWNER) == 1) {
      throw new LastOwnerRequiredException();
    }
    memberships.delete(actor);
  }

  /**
   * Serializes a finance mutation with membership lifecycle writes and rechecks current membership.
   * The caller owns the surrounding transaction so the household lock stays held through its write.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public void lockForFinance(UUID householdId, UUID actorId) {
    entityManager.createNativeQuery("SET LOCAL lock_timeout = '5s'").executeUpdate();
    lockAndRequireMembership(householdId, actorId);
  }

  /** Read-only membership guard for finance reads that found no owner-scoped rows. */
  @Transactional(readOnly = true, propagation = Propagation.MANDATORY)
  public void requireFinanceMembership(UUID householdId, UUID actorId) {
    memberships
        .findScopedByHouseholdAndActor(householdId, actorId)
        .orElseThrow(HouseholdNotFoundException::new);
  }

  /**
   * Current member user IDs for finance flows that validate participants or label membership
   * states. The caller owns the surrounding finance transaction and already holds the household
   * lifecycle lock, so membership cannot move between this read and the caller's write.
   */
  @Transactional(readOnly = true, propagation = Propagation.MANDATORY)
  public Set<UUID> currentMemberUserIds(UUID householdId) {
    return new LinkedHashSet<>(memberships.findCurrentUserIdsByHouseholdId(householdId));
  }

  /** Membership-scoped view to the authorized household DTO. Shared with invitations. */
  public static HouseholdResponse toResponse(HouseholdMembershipView view) {
    return new HouseholdResponse(
        view.householdId(), view.name(), view.role().name(), view.createdAt());
  }

  private HouseholdMemberEntity lockAndRequireMembership(UUID householdId, UUID actorId) {
    households.findByIdForUpdate(householdId).orElseThrow(HouseholdNotFoundException::new);
    return memberships
        .findById(new HouseholdMemberId(householdId, actorId))
        .orElseThrow(HouseholdNotFoundException::new);
  }

  private HouseholdMemberEntity requireMembership(UUID householdId, UUID userId) {
    return memberships
        .findById(new HouseholdMemberId(householdId, userId))
        .orElseThrow(MembershipNotFoundException::new);
  }

  private static void requireOwner(HouseholdMemberEntity actor) {
    if (actor.getRole() != MemberRole.OWNER) {
      throw new MembershipForbiddenException();
    }
  }

  private static void requireOtherActor(UUID targetUserId, UUID actorId) {
    if (targetUserId.equals(actorId)) {
      throw new MembershipSelfTargetException();
    }
  }

  private HouseholdMemberResponse memberResponse(UUID householdId, UUID userId) {
    return memberships
        .findMemberView(householdId, userId)
        .map(HouseholdService::toMemberResponse)
        .orElseThrow(MembershipNotFoundException::new);
  }

  private static HouseholdMemberResponse toMemberResponse(HouseholdMemberView member) {
    return new HouseholdMemberResponse(member.userId(), member.email(), member.role().name());
  }
}
