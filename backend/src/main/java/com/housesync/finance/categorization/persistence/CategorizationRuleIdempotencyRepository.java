package com.housesync.finance.categorization.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

public interface CategorizationRuleIdempotencyRepository
    extends JpaRepository<CategorizationRuleIdempotencyEntity, CategorizationRuleIdempotencyKey> {}
