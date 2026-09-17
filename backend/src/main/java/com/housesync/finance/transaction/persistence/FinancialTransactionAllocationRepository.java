package com.housesync.finance.transaction.persistence;

import com.housesync.finance.transaction.domain.AllocationStatus;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface FinancialTransactionAllocationRepository
    extends JpaRepository<FinancialTransactionAllocationEntity, UUID> {

  /**
   * The expense's active allocation, locked for update last in the documented order so create,
   * revoke, and void-deactivation serialize on the same row even under cross-feature races.
   */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT a FROM FinancialTransactionAllocationEntity a"
          + " WHERE a.transactionId = :transactionId"
          + " AND a.status = :active")
  Optional<FinancialTransactionAllocationEntity> findActiveForUpdate(
      @Param("transactionId") UUID transactionId, @Param("active") AllocationStatus active);

  @Query(
      "SELECT a FROM FinancialTransactionAllocationEntity a"
          + " WHERE a.transactionId = :transactionId"
          + " AND a.status = :active")
  Optional<FinancialTransactionAllocationEntity> findActiveByTransactionId(
      @Param("transactionId") UUID transactionId, @Param("active") AllocationStatus active);

  /**
   * Every active allocation of one household, for derived balances. Callers already hold the
   * household lifecycle lock, so the plain read is part of one consistent authorized snapshot.
   */
  @Query(
      "SELECT a FROM FinancialTransactionAllocationEntity a"
          + " WHERE a.householdId = :householdId AND a.status = :active"
          + " ORDER BY a.id ASC")
  List<FinancialTransactionAllocationEntity> findActiveByHouseholdId(
      @Param("householdId") UUID householdId, @Param("active") AllocationStatus active);
}
