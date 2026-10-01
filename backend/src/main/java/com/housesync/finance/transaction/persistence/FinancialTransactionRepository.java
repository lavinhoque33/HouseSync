package com.housesync.finance.transaction.persistence;

import com.housesync.finance.transaction.domain.TransactionStatus;
import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface FinancialTransactionRepository
    extends JpaRepository<FinancialTransactionEntity, UUID> {

  @Query(
      "SELECT t FROM FinancialTransactionEntity t, HouseholdMemberEntity m"
          + " WHERE t.id = :transactionId AND t.householdId = :householdId"
          + " AND t.ownerUserId = :actorId"
          + " AND m.householdId = t.householdId AND m.userId = :actorId")
  Optional<FinancialTransactionEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("transactionId") UUID transactionId,
      @Param("actorId") UUID actorId);

  /**
   * Authorized detail scope: the actor's own entry at any visibility, or another owner's entry
   * currently disclosed to the household. Membership is joined in the same query so a removed or
   * non-member actor never resolves the row at all.
   */
  @Query(
      "SELECT t FROM FinancialTransactionEntity t, HouseholdMemberEntity m"
          + " WHERE t.id = :transactionId AND t.householdId = :householdId"
          + " AND (t.ownerUserId = :actorId OR t.visibility = 'HOUSEHOLD')"
          + " AND m.householdId = t.householdId AND m.userId = :actorId")
  Optional<FinancialTransactionEntity> findVisibleScoped(
      @Param("householdId") UUID householdId,
      @Param("transactionId") UUID transactionId,
      @Param("actorId") UUID actorId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT t FROM FinancialTransactionEntity t"
          + " WHERE t.id = :transactionId AND t.householdId = :householdId"
          + " AND t.ownerUserId = :actorId")
  Optional<FinancialTransactionEntity> findOwnedForUpdate(
      @Param("householdId") UUID householdId,
      @Param("transactionId") UUID transactionId,
      @Param("actorId") UUID actorId);

  /**
   * Live posted refunds of one expense, locked for update in ascending UUID order so refund-group
   * operations never deadlock regardless of which member row they touch.
   */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT t FROM FinancialTransactionEntity t"
          + " WHERE t.refundOfTransactionId = :expenseId"
          + " AND t.status = :posted"
          + " ORDER BY t.id ASC")
  List<FinancialTransactionEntity> findLiveRefundsForUpdate(
      @Param("expenseId") UUID expenseId, @Param("posted") TransactionStatus posted);

  /**
   * Every linked refund of one expense (posted or voided), locked for update in ascending UUID
   * order. Refund-group mutations take this lock right after their source expense so the documented
   * source-first, ascending-refund order holds even when the patched row would otherwise be locked
   * before a lower sibling.
   */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT t FROM FinancialTransactionEntity t"
          + " WHERE t.refundOfTransactionId = :expenseId"
          + " ORDER BY t.id ASC")
  List<FinancialTransactionEntity> findGroupForUpdate(@Param("expenseId") UUID expenseId);

  /**
   * Authorized rows for derived balances: allocations are already household-scoped, so this only
   * re-checks the household bound while loading the contributing expenses and their currencies.
   */
  @Query(
      "SELECT t FROM FinancialTransactionEntity t"
          + " WHERE t.householdId = :householdId AND t.id IN :transactionIds")
  List<FinancialTransactionEntity> findHouseholdScopedByIds(
      @Param("householdId") UUID householdId,
      @Param("transactionIds") Collection<UUID> transactionIds);

  /**
   * Cumulative posted refund magnitude per expense, derived at read time for balances. Each row is
   * [expenseId, SUM(amount)]; empty result means the expense carries no posted refunds.
   */
  @Query(
      "SELECT t.refundOfTransactionId, SUM(t.amount) FROM FinancialTransactionEntity t"
          + " WHERE t.refundOfTransactionId IN :expenseIds AND t.status = :posted"
          + " GROUP BY t.refundOfTransactionId")
  List<Object[]> sumPostedRefunds(
      @Param("expenseIds") Collection<UUID> expenseIds, @Param("posted") TransactionStatus posted);
}
