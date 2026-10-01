package com.housesync.finance.connection.application;

import com.housesync.finance.account.domain.FinancialAccountKind;
import com.housesync.finance.account.domain.FinancialAccountNamePolicy;
import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.account.persistence.FinancialAccountEntity;
import com.housesync.finance.account.persistence.FinancialAccountRepository;
import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingEntity;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionDisconnectedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotFoundException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotReadyException;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Explicit discovered-account selection. Selection canonically sorts the requested local mapping
 * IDs, admits each eligible mapping at most once by creating or reusing a private CONNECTED account
 * row, and preserves history on deselection. Requires ACTIVE with no reconnect attempt in flight.
 */
@Service
public class ConnectionSelectionService extends ConnectedFinanceBase {

  private final FinancialAccountRepository accounts;
  private final ConnectionSyncDemandRegistrar demands;

  public ConnectionSelectionService(
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
      PlatformTransactionManager transactionManager,
      FinancialAccountRepository accounts,
      ConnectionSyncDemandRegistrar demands) {
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
    this.accounts = accounts;
    this.demands = demands;
  }

  public SelectionResult select(
      UUID householdId,
      UUID connectionId,
      UUID actorId,
      UUID idempotencyKey,
      int expectedVersion,
      List<UUID> requestedMappingIds) {
    requireEnabled();
    if (requestedMappingIds == null) {
      throw new ValidationFailedException(Map.of("accountMappingIds", "Choose accounts to admit."));
    }
    if (new LinkedHashSet<>(requestedMappingIds).size() != requestedMappingIds.size()) {
      throw new ValidationFailedException(
          Map.of("accountMappingIds", "Choose each account only once."));
    }
    List<UUID> canonical = new ArrayList<>(new TreeSet<>(requestedMappingIds));
    String fingerprint =
        fingerprint(
            "ACCOUNTS_SELECT\0"
                + connectionId
                + "\0"
                + expectedVersion
                + "\0"
                + String.join(",", canonical.stream().map(UUID::toString).toList()));
    return transactions.execute(
        status -> {
          lockFinance(householdId, actorId);
          var replayed =
              replay(actorId, householdId, "ACCOUNTS_SELECT", idempotencyKey, fingerprint);
          if (replayed != null) {
            FinancialConnectionEntity current =
                lockOwnedConnection(householdId, connectionId, actorId);
            return new SelectionResult(
                current.getId(), current.getVersion(), true, selectedAccounts(connectionId));
          }
          FinancialConnectionEntity connection =
              lockOwnedConnection(householdId, connectionId, actorId);
          if (connection.getVersion() != expectedVersion) {
            throw new com.housesync.finance.account.web.FinancialAccountExceptions
                .ResourceVersionConflictException();
          }
          if (!"ACTIVE".equals(connection.getState())) {
            if ("SUSPENDED".equals(connection.getState())
                || "DISCONNECTING".equals(connection.getState())
                || "DISCONNECTED".equals(connection.getState())) {
              throw new ConnectionDisconnectedException();
            }
            throw new ConnectionNotReadyException();
          }
          if (!attempts.findByConnectionIdAndState(connectionId, "EXCHANGING").isEmpty()) {
            throw new ConnectionNotReadyException();
          }
          List<ConnectionAccountMappingEntity> owned =
              mappings.findByConnectionForUpdate(connectionId);
          Map<UUID, ConnectionAccountMappingEntity> byId = new LinkedHashMap<>();
          for (ConnectionAccountMappingEntity mapping : owned) {
            byId.put(mapping.getId(), mapping);
          }
          Set<UUID> requested = new LinkedHashSet<>(canonical);
          for (UUID id : requested) {
            ConnectionAccountMappingEntity mapping = byId.get(id);
            if (mapping == null) {
              households.requireFinanceMembership(householdId, actorId);
              throw new ConnectionNotFoundException();
            }
            if (!mapping.isEligible()) {
              throw new ValidationFailedException(
                  Map.of("accountMappingIds", "Choose only eligible accounts."));
            }
          }
          Instant now = now();
          boolean changed = false;
          boolean selectionAdded = false;
          boolean resetHistory = false;
          for (ConnectionAccountMappingEntity mapping : owned) {
            boolean want = requested.contains(mapping.getId());
            if (want && mapping.getLocalAccountId() == null) {
              // Defense in depth: eligibility already guarantees a classified kind and
              // currency, but a null classification must fail closed, never fabricate.
              if (mapping.getKind() == null || mapping.getCurrency() == null) {
                throw new ValidationFailedException(
                    Map.of("accountMappingIds", "Choose only eligible accounts."));
              }
              FinancialAccountEntity admitted =
                  FinancialAccountEntity.connected(
                      UUID.randomUUID(),
                      householdId,
                      actorId,
                      accountLabel(mapping),
                      FinancialAccountKind.valueOf(mapping.getKind()),
                      SupportedCurrency.valueOf(mapping.getCurrency()),
                      now);
              accounts.save(admitted);
              mapping.admit(admitted.getId(), now);
              changed = true;
              selectionAdded = true;
              if (!mapping.isHistoryImported() && connection.getCursor() != null) {
                resetHistory = true;
              }
            } else if (want && !mapping.isSelected()) {
              mapping.setSelected(true, now);
              changed = true;
              selectionAdded = true;
              if (!mapping.isHistoryImported() && connection.getCursor() != null) {
                resetHistory = true;
              }
            } else if (!want && mapping.isSelected()) {
              // Deselection blocks admission while retaining history and account identity.
              mapping.setSelected(false, now);
              changed = true;
            }
          }
          if (resetHistory) {
            // Adding an account whose history was never imported resets the Item-wide cursor so
            // the provider replays from the beginning; existing associations and deduplication
            // survive because observation identities are stable.
            connection.resetSyncProgress(now);
            demands.demand(connectionId, now);
          } else if (changed) {
            if (connection.getVersion() == Integer.MAX_VALUE) {
              throw new com.housesync.finance.account.web.FinancialAccountExceptions
                  .ResourceVersionExhaustedException();
            }
            connection.transition(connection.getState(), now);
          }
          if (selectionAdded) {
            demands.demand(connectionId, now);
          }
          try {
            reserve(
                actorId,
                householdId,
                "ACCOUNTS_SELECT",
                idempotencyKey,
                fingerprint,
                connectionId,
                now);
          } catch (DataIntegrityViolationException concurrent) {
            throw new com.housesync.finance.connection.web.ConnectionExceptions
                .ProviderTransientException();
          }
          accounts.flush();
          return new SelectionResult(
              connection.getId(), connection.getVersion(), false, selectedAccounts(connectionId));
        });
  }

  private List<com.housesync.finance.connection.web.ConnectionResponses.AccountSelectionItem>
      selectedAccounts(UUID connectionId) {
    List<com.housesync.finance.connection.web.ConnectionResponses.AccountSelectionItem> items =
        new ArrayList<>();
    for (ConnectionAccountMappingEntity mapping : mappings.findByConnectionOrdered(connectionId)) {
      if (mapping.getLocalAccountId() == null || !mapping.isSelected()) {
        continue;
      }
      accounts
          .findById(mapping.getLocalAccountId())
          .ifPresent(
              account ->
                  items.add(
                      new com.housesync.finance.connection.web.ConnectionResponses
                          .AccountSelectionItem(
                          account.getId(),
                          account.getName(),
                          account.getKind().name(),
                          account.getCurrency().name(),
                          account.getSource(),
                          account.getStatus().name(),
                          account.getVersion())));
    }
    return items;
  }

  private static String accountLabel(ConnectionAccountMappingEntity mapping) {
    String label = mapping.getDisplayName();
    if (FinancialAccountNamePolicy.violation(label).isPresent()) {
      return "Connected account";
    }
    return FinancialAccountNamePolicy.normalize(label);
  }

  public record SelectionResult(
      UUID connectionId,
      int version,
      boolean replayed,
      List<com.housesync.finance.connection.web.ConnectionResponses.AccountSelectionItem>
          accounts) {}
}
