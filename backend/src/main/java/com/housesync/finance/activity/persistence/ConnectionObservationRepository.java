package com.housesync.finance.activity.persistence;

import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ConnectionObservationRepository
    extends JpaRepository<ConnectionObservationEntity, UUID> {

  @Query(
      """
      SELECT o FROM ConnectionObservationEntity o
      WHERE o.householdId = :householdId AND o.id = :observationId AND o.ownerUserId = :actorId
      """)
  Optional<ConnectionObservationEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("observationId") UUID observationId,
      @Param("actorId") UUID actorId);

  /**
   * Id-only projection used to acquire the connection lock before hydrating the observation. This
   * keeps the documented connection-before-observation order without caching a stale observation
   * that a concurrent sync or decision could then be compared against.
   */
  @Query(
      """
      SELECT o.connectionId FROM ConnectionObservationEntity o
      WHERE o.householdId = :householdId AND o.id = :observationId AND o.ownerUserId = :actorId
      """)
  Optional<UUID> findOwnedConnectionId(
      @Param("householdId") UUID householdId,
      @Param("observationId") UUID observationId,
      @Param("actorId") UUID actorId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      """
      SELECT o FROM ConnectionObservationEntity o
      WHERE o.householdId = :householdId AND o.id = :observationId AND o.ownerUserId = :actorId
      """)
  Optional<ConnectionObservationEntity> findOwnedForUpdate(
      @Param("householdId") UUID householdId,
      @Param("observationId") UUID observationId,
      @Param("actorId") UUID actorId);

  Optional<ConnectionObservationEntity> findByConnectionIdAndRemoteTransactionDigest(
      UUID connectionId, String remoteTransactionDigest);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      """
      SELECT o FROM ConnectionObservationEntity o
      WHERE o.connectionId = :connectionId AND o.remoteTransactionDigest = :digest
      """)
  Optional<ConnectionObservationEntity> findDigestForUpdate(
      @Param("connectionId") UUID connectionId, @Param("digest") String digest);

  @Query(
      """
      SELECT COUNT(o) FROM ConnectionObservationEntity o
      WHERE o.householdId = :householdId AND o.ownerUserId = :actorId
        AND o.reviewState = 'UNREVIEWED'
        AND o.state IN ('PENDING', 'POSTED')
      """)
  long countUnreviewed(@Param("householdId") UUID householdId, @Param("actorId") UUID actorId);

  @Query(
      """
      SELECT COUNT(o) FROM ConnectionObservationEntity o
      WHERE o.householdId = :householdId AND o.ownerUserId = :actorId
        AND o.changeState IS NOT NULL
      """)
  long countChangedAdmitted(@Param("householdId") UUID householdId, @Param("actorId") UUID actorId);
}
