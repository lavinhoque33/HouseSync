package com.housesync.household.persistence;

import com.housesync.household.application.HouseholdMembershipView;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface HouseholdMemberRepository
    extends JpaRepository<HouseholdMemberEntity, HouseholdMemberId> {

  /**
   * One membership-scoped operation: the household plus the actor's current role, or empty when the
   * household is missing or the actor is not a current member.
   */
  @Query(
      "SELECT NEW com.housesync.household.application.HouseholdMembershipView"
          + " (h.id, h.name, m.role, h.createdAt)"
          + " FROM HouseholdEntity h, HouseholdMemberEntity m"
          + " WHERE m.householdId = h.id AND m.householdId = :householdId AND m.userId = :actorId")
  Optional<HouseholdMembershipView> findScopedByHouseholdAndActor(
      @Param("householdId") UUID householdId, @Param("actorId") UUID actorId);

  /**
   * Membership-scoped collection read: only households the actor currently belongs to, ordered by
   * creation instant then ID. The membership filter runs in PostgreSQL, not in memory.
   */
  @Query(
      "SELECT NEW com.housesync.household.application.HouseholdMembershipView"
          + " (h.id, h.name, m.role, h.createdAt)"
          + " FROM HouseholdEntity h, HouseholdMemberEntity m"
          + " WHERE m.householdId = h.id AND m.userId = :actorId"
          + " ORDER BY h.createdAt ASC, h.id ASC")
  List<HouseholdMembershipView> findAllScopedForActor(@Param("actorId") UUID actorId);
}
