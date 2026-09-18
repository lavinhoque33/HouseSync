package com.housesync.finance.connection.persistence;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface ConnectionSyncWorkRepository
    extends JpaRepository<ConnectionSyncWorkEntity, UUID> {

  Optional<ConnectionSyncWorkEntity> findByConnectionId(UUID connectionId);

  /**
   * Id-only probe for the consistent lock order (connection, then work): it must not hydrate the
   * work entity before the connection row is locked, or a later locked read could return a stale
   * managed instance and lose a concurrent demand.
   */
  @Query("SELECT w.connectionId FROM ConnectionSyncWorkEntity w WHERE w.id = :id")
  Optional<UUID> findConnectionIdById(@Param("id") UUID id);

  /**
   * Atomic first-or-next demand. A single PostgreSQL statement creates the row or increments its
   * monotonic sequence, preserving a running round's lease fields. This avoids a flush-time unique
   * violation (which would poison the caller's persistence context) and needs no read-modify-write
   * race handling; callers that need the row re-read it under a row lock in the same transaction.
   */
  @Modifying
  @Transactional
  @Query(
      nativeQuery = true,
      value =
          """
          INSERT INTO connection_sync_work
            (id, connection_id, state, demand_sequence, committed_sequence, attempt_count,
             lease_fence, created_at, updated_at)
          VALUES (:id, :connectionId, 'QUEUED', 1, 0, 0, 0, :now, :now)
          ON CONFLICT (connection_id) DO UPDATE SET
            demand_sequence = connection_sync_work.demand_sequence + 1,
            state = CASE WHEN connection_sync_work.state = 'RUNNING'
              THEN 'RUNNING' ELSE 'QUEUED' END,
            next_retry_at = CASE WHEN connection_sync_work.state = 'RUNNING'
              THEN connection_sync_work.next_retry_at ELSE NULL END,
            last_error = CASE WHEN connection_sync_work.state = 'RUNNING'
              THEN connection_sync_work.last_error ELSE NULL END,
            updated_at = :now
          """)
  int upsertDemand(
      @Param("id") UUID id, @Param("connectionId") UUID connectionId, @Param("now") Instant now);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("SELECT w FROM ConnectionSyncWorkEntity w WHERE w.id = :id")
  Optional<ConnectionSyncWorkEntity> findByIdForUpdate(@Param("id") UUID id);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("SELECT w FROM ConnectionSyncWorkEntity w WHERE w.connectionId = :connectionId")
  Optional<ConnectionSyncWorkEntity> findByConnectionIdForUpdate(
      @Param("connectionId") UUID connectionId);

  /**
   * Work eligible for a worker claim: queued demand or a due retry, or a crashed round whose lease
   * expired. Visible FAILED work waits for an explicit owner retry or the periodic sweep.
   */
  @Query(
      """
      SELECT w FROM ConnectionSyncWorkEntity w
      WHERE (w.state = 'QUEUED' AND (w.nextRetryAt IS NULL OR w.nextRetryAt <= :now))
         OR (w.state = 'RETRY_WAIT' AND (w.nextRetryAt IS NULL OR w.nextRetryAt <= :now))
         OR (w.state = 'RUNNING' AND (w.leaseExpiresAt IS NULL OR w.leaseExpiresAt <= :now))
      ORDER BY w.updatedAt, w.id
      """)
  List<ConnectionSyncWorkEntity> findDue(@Param("now") Instant now, Pageable page);

  /**
   * Eligible connections for the periodic missed-webhook sweep: ACTIVE, idle work, and no
   * successful sync within the threshold. Reads only local state; no provider call happens here.
   */
  @Query(
      """
      SELECT w FROM ConnectionSyncWorkEntity w, FinancialConnectionEntity c
      WHERE c.id = w.connectionId
        AND c.state = 'ACTIVE'
        AND w.state = 'IDLE'
        AND (c.lastSuccessfulSyncAt IS NULL OR c.lastSuccessfulSyncAt <= :threshold)
      ORDER BY w.updatedAt, w.id
      """)
  List<ConnectionSyncWorkEntity> findStaleIdle(
      @Param("threshold") Instant threshold, Pageable page);
}
