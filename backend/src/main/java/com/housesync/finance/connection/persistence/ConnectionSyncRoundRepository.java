package com.housesync.finance.connection.persistence;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ConnectionSyncRoundRepository
    extends JpaRepository<ConnectionSyncRoundEntity, UUID> {

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("SELECT r FROM ConnectionSyncRoundEntity r WHERE r.id = :id")
  Optional<ConnectionSyncRoundEntity> findByIdForUpdate(@Param("id") UUID id);

  /**
   * Rounds whose staged deltas have expired. STAGING rounds are included: a crashed worker's round
   * cannot be reclaimed by anything else and is abandoned/scrubbed here once its TTL passes.
   */
  @Query(
      """
      SELECT r FROM ConnectionSyncRoundEntity r
      WHERE r.updatedAt <= :threshold
      ORDER BY r.updatedAt, r.id
      """)
  List<ConnectionSyncRoundEntity> findScrubbable(
      @Param("threshold") Instant threshold, Pageable page);

  Optional<ConnectionSyncRoundEntity> findByConnectionIdAndState(UUID connectionId, String state);
}
