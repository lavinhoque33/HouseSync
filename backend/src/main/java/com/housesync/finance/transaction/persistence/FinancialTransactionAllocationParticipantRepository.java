package com.housesync.finance.transaction.persistence;

import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface FinancialTransactionAllocationParticipantRepository
    extends JpaRepository<
        FinancialTransactionAllocationParticipantEntity,
        FinancialTransactionAllocationParticipantEntity.Key> {

  /**
   * Frozen participants of the given allocations. Canonical ascending user-UUID ordering is applied
   * by the service with the documented string comparator, so the persisted shares map onto the same
   * positions the remainder awarding used.
   */
  @Query(
      "SELECT p FROM FinancialTransactionAllocationParticipantEntity p"
          + " WHERE p.allocationId IN :allocationIds")
  List<FinancialTransactionAllocationParticipantEntity> findByAllocationIdIn(
      @Param("allocationIds") Collection<UUID> allocationIds);
}
