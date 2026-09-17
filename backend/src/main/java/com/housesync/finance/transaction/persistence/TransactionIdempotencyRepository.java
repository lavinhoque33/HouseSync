package com.housesync.finance.transaction.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

public interface TransactionIdempotencyRepository
    extends JpaRepository<TransactionIdempotencyEntity, TransactionIdempotencyKey> {}
