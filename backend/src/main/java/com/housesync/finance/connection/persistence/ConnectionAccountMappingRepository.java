package com.housesync.finance.connection.persistence;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ConnectionAccountMappingRepository
    extends JpaRepository<ConnectionAccountMappingEntity, UUID> {

  @Query(
      "SELECT m FROM ConnectionAccountMappingEntity m"
          + " WHERE m.connectionId = :connectionId ORDER BY m.createdAt ASC, m.id ASC")
  List<ConnectionAccountMappingEntity> findByConnectionOrdered(
      @Param("connectionId") UUID connectionId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT m FROM ConnectionAccountMappingEntity m"
          + " WHERE m.connectionId = :connectionId ORDER BY m.id ASC")
  List<ConnectionAccountMappingEntity> findByConnectionForUpdate(
      @Param("connectionId") UUID connectionId);

  Optional<ConnectionAccountMappingEntity> findByConnectionIdAndRemoteAccountDigest(
      UUID connectionId, String remoteAccountDigest);

  @Query(
      "SELECT m FROM ConnectionAccountMappingEntity m"
          + " WHERE m.id = :mappingId AND m.connectionId = :connectionId"
          + " AND m.householdId = :householdId AND m.ownerUserId = :actorId")
  Optional<ConnectionAccountMappingEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("connectionId") UUID connectionId,
      @Param("mappingId") UUID mappingId,
      @Param("actorId") UUID actorId);
}
