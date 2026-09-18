package com.housesync.finance.connection.persistence;

import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ConnectionLinkAttemptRepository
    extends JpaRepository<ConnectionLinkAttemptEntity, UUID> {

  @Query(
      "SELECT a FROM ConnectionLinkAttemptEntity a"
          + " WHERE a.id = :attemptId AND a.householdId = :householdId"
          + " AND a.ownerUserId = :actorId")
  Optional<ConnectionLinkAttemptEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("attemptId") UUID attemptId,
      @Param("actorId") UUID actorId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT a FROM ConnectionLinkAttemptEntity a"
          + " WHERE a.id = :attemptId AND a.householdId = :householdId"
          + " AND a.ownerUserId = :actorId")
  Optional<ConnectionLinkAttemptEntity> findOwnedForUpdate(
      @Param("householdId") UUID householdId,
      @Param("attemptId") UUID attemptId,
      @Param("actorId") UUID actorId);

  java.util.List<ConnectionLinkAttemptEntity> findByConnectionIdAndState(
      UUID connectionId, String state);

  java.util.List<ConnectionLinkAttemptEntity> findByConnectionIdAndStateIn(
      UUID connectionId, java.util.Collection<String> states);

  /**
   * Expired attempts that never reached exchange, for the scheduled scrubber. An attempt is due
   * when the earliest of the local attempt expiry and the provider token expiry has passed.
   * EXCHANGING rows stay with the completion path, which owns their outcome and token erasure.
   */
  @org.springframework.data.jpa.repository.Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
  @org.springframework.data.jpa.repository.Query(
      "SELECT a FROM ConnectionLinkAttemptEntity a"
          + " WHERE a.state = 'LINK_TOKEN_ISSUED'"
          + " AND (a.expiresAt <= :now"
          + " OR (a.linkTokenExpiresAt IS NOT NULL AND a.linkTokenExpiresAt <= :now))"
          + " ORDER BY a.expiresAt ASC, a.id ASC")
  java.util.List<ConnectionLinkAttemptEntity> findExpiredIssuedForScrub(
      @org.springframework.data.repository.query.Param("now") java.time.Instant now,
      org.springframework.data.domain.Pageable limit);
}
