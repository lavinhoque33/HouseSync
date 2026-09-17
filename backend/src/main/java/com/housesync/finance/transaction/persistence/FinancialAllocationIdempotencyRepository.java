package com.housesync.finance.transaction.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

public interface FinancialAllocationIdempotencyRepository
    extends JpaRepository<
        FinancialAllocationIdempotencyEntity, FinancialAllocationIdempotencyKey> {}
