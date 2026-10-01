package com.housesync.finance.connection.application;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptEntity;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyEntity;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyKey;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectedFinanceDisabledException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionIdempotencyConflictException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotFoundException;
import com.housesync.household.application.HouseholdService;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Shared connected-finance guards: explicit enablement, household lifecycle locking with the
 * documented lock order (household, then connection), owner-scoped loads with indistinguishable
 * 404s, canonical idempotency fingerprints, and ciphertext binding scopes.
 */
abstract class ConnectedFinanceBase {

  final ConnectedFinanceProperties properties;
  final FinancialConnectionRepository connections;
  final ConnectionAccountMappingRepository mappings;
  final ConnectionLinkAttemptRepository attempts;
  final ConnectionOperationRepository operations;
  final ConnectionOperationIdempotencyRepository idempotency;
  final ConnectionRevocationWorkRepository revocations;
  final HouseholdService households;
  final ConnectionCrypto crypto;
  final PlaidAdapter adapter;
  final Clock clock;
  final TransactionTemplate transactions;

  ConnectedFinanceBase(
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
    this.properties = properties;
    this.connections = connections;
    this.mappings = mappings;
    this.attempts = attempts;
    this.operations = operations;
    this.idempotency = idempotency;
    this.revocations = revocations;
    this.households = households;
    this.crypto = crypto;
    this.adapter = adapter;
    this.clock = clock;
    this.transactions = new TransactionTemplate(transactionManager);
  }

  void requireEnabled() {
    if (!properties.isEnabled()) {
      throw new ConnectedFinanceDisabledException();
    }
  }

  Instant now() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  String fingerprint(String canonical) {
    return ConnectionCrypto.sha256Hex(canonical);
  }

  /** Household lifecycle lock first; every finance mutation serializes with membership writes. */
  void lockFinance(UUID householdId, UUID actorId) {
    households.lockForFinance(householdId, actorId);
  }

  FinancialConnectionEntity lockOwnedConnection(UUID householdId, UUID connectionId, UUID actorId) {
    return connections
        .findOwnedForUpdate(householdId, connectionId, actorId)
        .orElseThrow(ConnectionNotFoundException::new);
  }

  ConnectionLinkAttemptEntity lockOwnedAttempt(UUID householdId, UUID attemptId, UUID actorId) {
    return attempts
        .findOwnedForUpdate(householdId, attemptId, actorId)
        .orElseThrow(ConnectionNotFoundException::new);
  }

  /**
   * Owner-scoped replay lookup with authorization already established by the surrounding household
   * lock: a miss means the key was never used, never a foreign resource.
   */
  ConnectionOperationIdempotencyEntity replay(
      UUID actorId, UUID householdId, String operation, UUID key, String fingerprint) {
    var stored =
        idempotency
            .findById(new ConnectionOperationIdempotencyKey(actorId, householdId, operation, key))
            .orElse(null);
    if (stored == null) {
      return null;
    }
    if (!stored.getRequestFingerprint().equals(fingerprint)) {
      throw new ConnectionIdempotencyConflictException();
    }
    return stored;
  }

  void reserve(
      UUID actorId,
      UUID householdId,
      String operation,
      UUID key,
      String fingerprint,
      UUID resource,
      Instant now) {
    reserve(actorId, householdId, operation, key, fingerprint, resource, null, now);
  }

  void reserve(
      UUID actorId,
      UUID householdId,
      String operation,
      UUID key,
      String fingerprint,
      UUID resource,
      String hmacKeyId,
      Instant now) {
    idempotency.save(
        new ConnectionOperationIdempotencyEntity(
            new ConnectionOperationIdempotencyKey(actorId, householdId, operation, key),
            fingerprint,
            resource,
            hmacKeyId,
            now));
    idempotency.flush();
  }

  /**
   * Every effective connection mutation bumps the optimistic version exactly once; an exhausted
   * counter maps to the existing version-exhausted contract, never a raw 500.
   */
  void requireVersionCapacity(FinancialConnectionEntity connection) {
    if (connection.getVersion() == Integer.MAX_VALUE) {
      throw new com.housesync.finance.account.web.FinancialAccountExceptions
          .ResourceVersionExhaustedException();
    }
  }

  static String linkTokenScope(UUID attemptId) {
    return "attempt/" + attemptId + "/link-token";
  }

  static String publicTokenScope(UUID attemptId) {
    return "attempt/" + attemptId + "/public-token";
  }

  static String credentialScope(UUID connectionId) {
    return "connection/" + connectionId + "/credential";
  }
}
