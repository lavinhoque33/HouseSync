package com.housesync.finance.connection.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ConnectionOperationRepository
    extends JpaRepository<ConnectionOperationEntity, UUID> {

  List<ConnectionOperationEntity> findByConnectionIdAndOperationTypeAndState(
      UUID connectionId, String operationType, String state);

  List<ConnectionOperationEntity> findByConnectionIdAndOperationTypeAndStateIn(
      UUID connectionId, String operationType, List<String> states);

  @Query(
      "SELECT o FROM ConnectionOperationEntity o"
          + " WHERE o.id = :operationId AND o.householdId = :householdId"
          + " AND o.ownerUserId = :actorId")
  Optional<ConnectionOperationEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("operationId") UUID operationId,
      @Param("actorId") UUID actorId);
}
