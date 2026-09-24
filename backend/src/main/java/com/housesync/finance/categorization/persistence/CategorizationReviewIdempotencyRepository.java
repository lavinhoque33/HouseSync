package com.housesync.finance.categorization.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

public interface CategorizationReviewIdempotencyRepository
    extends JpaRepository<CategorizationReviewIdempotency, ReviewIdempotencyKey> {}
