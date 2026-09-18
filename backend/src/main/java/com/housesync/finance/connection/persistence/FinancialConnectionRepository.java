package com.housesync.finance.connection.persistence;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface FinancialConnectionRepository
    extends JpaRepository<FinancialConnectionEntity, UUID> {

  @Query(
      value =
          "SELECT c.* FROM financial_connections c"
              + " JOIN household_members m ON m.household_id = c.household_id"
              + " AND m.user_id = :actorId"
              + " WHERE c.household_id = :householdId AND c.owner_user_id = :actorId"
              + " ORDER BY c.created_at ASC, c.id ASC LIMIT :limit OFFSET :offset",
      nativeQuery = true)
  List<FinancialConnectionEntity> findOwnedPage(
      @Param("householdId") UUID householdId,
      @Param("actorId") UUID actorId,
      @Param("limit") int limit,
      @Param("offset") int offset);

  @Query(
      "SELECT c FROM FinancialConnectionEntity c, HouseholdMemberEntity m"
          + " WHERE c.id = :connectionId AND c.householdId = :householdId"
          + " AND c.ownerUserId = :actorId"
          + " AND m.householdId = c.householdId AND m.userId = :actorId")
  Optional<FinancialConnectionEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("connectionId") UUID connectionId,
      @Param("actorId") UUID actorId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT c FROM FinancialConnectionEntity c"
          + " WHERE c.id = :connectionId AND c.householdId = :householdId"
          + " AND c.ownerUserId = :actorId")
  Optional<FinancialConnectionEntity> findOwnedForUpdate(
      @Param("householdId") UUID householdId,
      @Param("connectionId") UUID connectionId,
      @Param("actorId") UUID actorId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("SELECT c FROM FinancialConnectionEntity c WHERE c.id = :connectionId")
  Optional<FinancialConnectionEntity> findByIdForUpdate(@Param("connectionId") UUID connectionId);

  List<FinancialConnectionEntity> findByHouseholdIdAndOwnerUserId(
      UUID householdId, UUID ownerUserId);

  Optional<FinancialConnectionEntity> findByProviderAndEnvironmentAndRemoteItemDigest(
      String provider, String environment, String remoteItemDigest);

  /**
   * Digest lookup that acquires the row lock in the same statement. Using this instead of a plain
   * read followed by {@link #findByIdForUpdate} guarantees the entity is hydrated from the locked
   * row rather than from a stale managed instance loaded before the lock.
   */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT c FROM FinancialConnectionEntity c"
          + " WHERE c.provider = :provider AND c.environment = :environment"
          + " AND c.remoteItemDigest = :remoteItemDigest")
  Optional<FinancialConnectionEntity> findDigestForUpdate(
      @Param("provider") String provider,
      @Param("environment") String environment,
      @Param("remoteItemDigest") String remoteItemDigest);
}
