package com.housesync.finance.account.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AccountIdempotencyRepository
    extends JpaRepository<AccountIdempotencyEntity, AccountIdempotencyKey> {}
