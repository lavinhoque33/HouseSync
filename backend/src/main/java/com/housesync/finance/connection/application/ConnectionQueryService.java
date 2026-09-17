package com.housesync.finance.connection.application;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingEntity;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationEntity;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotFoundException;
import com.housesync.household.application.HouseholdService;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owner-scoped connection reads. Every read resolves the household membership together with the
 * resource, so foreign, missing, other-owner, and former-member resources share one 404.
 */
@Service
public class ConnectionQueryService extends ConnectedFinanceBase {

  public ConnectionQueryService(
      ConnectedFinanceProperties properties,
      FinancialConnectionRepository connections,
      ConnectionAccountMappingRepository mappings,
      ConnectionLinkAttemptRepository attempts,
      ConnectionOperationRepository operations,
      ConnectionOperationIdempotencyRepository idempotency,
      ConnectionRevocationWorkRepository revocations,
      HouseholdService households,
      ConnectionCrypto crypto,
      PlaidAdapter adapter,
      Clock clock,
      PlatformTransactionManager transactionManager) {
    super(
        properties,
        connections,
        mappings,
        attempts,
        operations,
        idempotency,
        revocations,
        households,
        crypto,
        adapter,
        clock,
        transactionManager);
  }

  @Transactional(readOnly = true)
  public ConnectionPage list(UUID householdId, UUID actorId, int limit, int offset) {
    requireEnabled();
    List<FinancialConnectionEntity> fetched =
        connections.findOwnedPage(householdId, actorId, limit + 1, offset);
    if (fetched.isEmpty()) {
      households.requireFinanceMembership(householdId, actorId);
    }
    boolean hasMore = fetched.size() > limit;
    return new ConnectionPage(fetched.stream().limit(limit).toList(), hasMore);
  }

  public record ConnectionPage(List<FinancialConnectionEntity> items, boolean hasMore) {}

  @Transactional(readOnly = true)
  public FinancialConnectionEntity get(UUID householdId, UUID connectionId, UUID actorId) {
    requireEnabled();
    return connections
        .findOwnedScoped(householdId, connectionId, actorId)
        .orElseGet(
            () -> {
              households.requireFinanceMembership(householdId, actorId);
              throw new ConnectionNotFoundException();
            });
  }

  @Transactional(readOnly = true)
  public MappingPage accounts(
      UUID householdId, UUID connectionId, UUID actorId, int limit, int offset) {
    requireEnabled();
    FinancialConnectionEntity connection = get(householdId, connectionId, actorId);
    List<ConnectionAccountMappingEntity> all = mappings.findByConnectionOrdered(connection.getId());
    if (offset >= all.size()) {
      return new MappingPage(List.of(), false);
    }
    int end = Math.min(all.size(), offset + limit);
    return new MappingPage(all.subList(offset, end), all.size() > end);
  }

  public record MappingPage(List<ConnectionAccountMappingEntity> items, boolean hasMore) {}

  @Transactional(readOnly = true)
  public ConnectionOperationEntity operation(UUID householdId, UUID operationId, UUID actorId) {
    requireEnabled();
    return operations
        .findOwnedScoped(householdId, operationId, actorId)
        .orElseGet(
            () -> {
              households.requireFinanceMembership(householdId, actorId);
              throw new ConnectionNotFoundException();
            });
  }
}
