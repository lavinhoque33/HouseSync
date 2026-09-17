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

public interface ConnectionRevocationWorkRepository
    extends JpaRepository<ConnectionRevocationWorkEntity, UUID> {

  List<ConnectionRevocationWorkEntity> findByConnectionId(UUID connectionId);

  /**
   * Due work: queued rows past their retry time plus in-progress rows whose lease expired without a
   * commit (crashed worker recovery), including legacy rows that predate leases (null expiry is
   * always reclaimable). The claim path rechecks under a row lock.
   */
  @Query(
      "SELECT w FROM ConnectionRevocationWorkEntity w"
          + " WHERE w.nextRetryAt <= :now"
          + " AND (w.state = 'QUEUED'"
          + " OR (w.state = 'IN_PROGRESS'"
          + " AND (w.leaseExpiresAt IS NULL OR w.leaseExpiresAt <= :now)))"
          + " ORDER BY w.nextRetryAt ASC, w.id ASC")
  List<ConnectionRevocationWorkEntity> findDue(@Param("now") Instant now, Pageable limit);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("SELECT w FROM ConnectionRevocationWorkEntity w WHERE w.id = :workId")
  Optional<ConnectionRevocationWorkEntity> findByIdForUpdate(@Param("workId") UUID workId);
}
