package com.housesync.finance.activity.persistence;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface ProviderWebhookEventRepository
    extends JpaRepository<ProviderWebhookEventEntity, UUID> {

  /**
   * Atomic replay reservation. A conflict leaves the existing row untouched and returns 0, so a
   * replay never fails the request or logs a duplicate-key diagnostic.
   */
  @Modifying
  @Transactional
  @Query(
      nativeQuery = true,
      value =
          """
          INSERT INTO provider_webhook_events
            (id, provider, environment, signed_jwt_hash, body_hash, received_at)
          VALUES (:id, :provider, :environment, :signedJwtHash, :bodyHash, :receivedAt)
          ON CONFLICT (provider, environment, signed_jwt_hash, body_hash) DO NOTHING
          """)
  int reserve(
      @Param("id") UUID id,
      @Param("provider") String provider,
      @Param("environment") String environment,
      @Param("signedJwtHash") String signedJwtHash,
      @Param("bodyHash") String bodyHash,
      @Param("receivedAt") Instant receivedAt);

  @Query(
      "SELECT e FROM ProviderWebhookEventEntity e WHERE e.receivedAt <= :threshold ORDER BY e.receivedAt, e.id")
  List<ProviderWebhookEventEntity> findExpired(
      @Param("threshold") Instant threshold, Pageable page);

  @Modifying
  @Transactional
  @Query("DELETE FROM ProviderWebhookEventEntity e WHERE e.id IN :ids")
  int deleteByIds(@Param("ids") List<UUID> ids);
}
