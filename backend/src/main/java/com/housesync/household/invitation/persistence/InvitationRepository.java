package com.housesync.household.invitation.persistence;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface InvitationRepository extends JpaRepository<InvitationEntity, UUID> {

  /**
   * Loads the invitation row with a write lock so concurrent acceptance versus acceptance, or
   * acceptance versus revocation, serializes to one winning terminal transition.
   */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("SELECT i FROM InvitationEntity i WHERE i.id = :id")
  Optional<InvitationEntity> findByIdForUpdate(@Param("id") UUID id);

  /**
   * Owner-scoped active list: unaccepted, unrevoked, unexpired invitations for one household,
   * ordered by creation instant then ID. The terminal-state filter runs in PostgreSQL, not in
   * memory; the partial index covers the unaccepted/unrevoked predicate.
   */
  @Query(
      "SELECT i FROM InvitationEntity i"
          + " WHERE i.householdId = :householdId"
          + " AND i.acceptedAt IS NULL AND i.revokedAt IS NULL AND i.expiresAt > :now"
          + " ORDER BY i.createdAt ASC, i.id ASC")
  List<InvitationEntity> findActiveByHousehold(
      @Param("householdId") UUID householdId, @Param("now") Instant now);
}
