package com.housesync.finance.connection.persistence;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ConnectionOperationIdempotencyRepository
    extends JpaRepository<ConnectionOperationIdempotencyEntity, ConnectionOperationIdempotencyKey> {

  List<ConnectionOperationIdempotencyEntity> findByResourceId(UUID resourceId);
}
