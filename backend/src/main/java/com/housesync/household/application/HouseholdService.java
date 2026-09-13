package com.housesync.household.application;

import com.housesync.household.domain.HouseholdNamePolicy;
import com.housesync.household.domain.MemberRole;
import com.housesync.household.persistence.HouseholdEntity;
import com.housesync.household.persistence.HouseholdMemberEntity;
import com.housesync.household.persistence.HouseholdMemberRepository;
import com.housesync.household.persistence.HouseholdRepository;
import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.housesync.household.web.HouseholdResponse;
import com.housesync.identity.web.IdentityExceptions;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Household create/access use cases.
 *
 * <p>The actor always comes from the authenticated {@code HouseSyncUserDetails} UUID supplied by
 * the controller; request bodies never assign ownership. Creation inserts the household and its
 * creator {@code OWNER} membership in one transaction so no household can exist without its owner
 * row. Reads resolve the household and the caller's current role together in one membership-scoped
 * database query on every request.
 */
@Service
public class HouseholdService {

  private final HouseholdRepository households;
  private final HouseholdMemberRepository memberships;
  private final Clock clock;

  public HouseholdService(
      HouseholdRepository households, HouseholdMemberRepository memberships, Clock clock) {
    this.households = households;
    this.memberships = memberships;
    this.clock = clock;
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

  /** Membership-scoped view to the authorized household DTO. Shared with invitations. */
  public static HouseholdResponse toResponse(HouseholdMembershipView view) {
    return new HouseholdResponse(
        view.householdId(), view.name(), view.role().name(), view.createdAt());
  }
}
