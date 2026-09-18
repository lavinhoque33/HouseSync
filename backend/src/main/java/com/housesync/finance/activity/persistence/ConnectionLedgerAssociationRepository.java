package com.housesync.finance.activity.persistence;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ConnectionLedgerAssociationRepository
    extends JpaRepository<ConnectionLedgerAssociationEntity, UUID> {

  Optional<ConnectionLedgerAssociationEntity> findByObservationIdAndState(
      UUID observationId, String state);

  Optional<ConnectionLedgerAssociationEntity> findByTransactionId(UUID transactionId);
}
