package com.housesync.finance.account.persistence;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface FinancialAccountRepository extends JpaRepository<FinancialAccountEntity, UUID> {

  @Query(
      value =
          "SELECT a.* FROM financial_accounts a"
              + " JOIN household_members m ON m.household_id = a.household_id"
              + " AND m.user_id = :actorId"
              + " WHERE a.household_id = :householdId AND a.owner_user_id = :actorId"
              + " AND (:status = 'ALL' OR a.status = :status)"
              + " ORDER BY a.created_at ASC, a.id ASC LIMIT :limit OFFSET :offset",
      nativeQuery = true)
  List<FinancialAccountEntity> findOwnedPage(
      @Param("householdId") UUID householdId,
      @Param("actorId") UUID actorId,
      @Param("status") String status,
      @Param("limit") int limit,
      @Param("offset") int offset);

  @Query(
      "SELECT a FROM FinancialAccountEntity a, HouseholdMemberEntity m"
          + " WHERE a.id = :accountId AND a.householdId = :householdId"
          + " AND a.ownerUserId = :actorId"
          + " AND m.householdId = a.householdId AND m.userId = :actorId")
  Optional<FinancialAccountEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("accountId") UUID accountId,
      @Param("actorId") UUID actorId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT a FROM FinancialAccountEntity a"
          + " WHERE a.id = :accountId AND a.householdId = :householdId"
          + " AND a.ownerUserId = :actorId")
  Optional<FinancialAccountEntity> findOwnedForUpdate(
      @Param("householdId") UUID householdId,
      @Param("accountId") UUID accountId,
      @Param("actorId") UUID actorId);
}
