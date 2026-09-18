package com.housesync.finance.connection.application;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingEntity;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptEntity;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationEntity;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyEntity;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyKey;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkEntity;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapterException;
import com.housesync.finance.connection.plaid.RemoteAccount;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionIdempotencyConflictException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotFoundException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotReadyException;
import com.housesync.finance.connection.web.ConnectionExceptions.LinkAttemptExpiredException;
import com.housesync.finance.connection.web.ConnectionExceptions.ProviderTransientException;
import com.housesync.household.application.HouseholdService;
import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * New-link and reconnect-completion lifecycle.
 *
 * <p>Intent and durable operations persist before any external call, and every external call runs
 * outside domain write transactions. An exchange that may have succeeded remotely while its
 * response was lost is recorded as {@code OUTCOME_UNKNOWN} with recovery instructions instead of a
 * blind retry or a false failure.
 */
@Service
public class ConnectionLinkService extends ConnectedFinanceBase {

  private final ConnectionSyncDemandRegistrar demands;

  public ConnectionLinkService(
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
    this.demands = demands;
  }

  /** Starts a new-link attempt: reserves intent, then attaches the provider Link token. */
  public StartResult start(UUID householdId, UUID actorId, UUID idempotencyKey) {
    requireEnabled();
    Reservation reservation =
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              String fingerprint = startFingerprint();
              var replayed =
                  replay(actorId, householdId, "LINK_START", idempotencyKey, fingerprint);
              Instant now = now();
              if (replayed != null) {
                return new Reservation(replayed.getResourceId(), true, now);
              }
              UUID attemptId = UUID.randomUUID();
              Instant expiresAt = now.plusSeconds(properties.getAttemptTtlMinutes() * 60L);
              attempts.save(
                  new ConnectionLinkAttemptEntity(
                      attemptId,
                      householdId,
                      actorId,
                      "NEW",
                      properties.environmentToken(),
                      null,
                      now,
                      expiresAt));
              try {
                reserve(
                    actorId,
                    householdId,
                    "LINK_START",
                    idempotencyKey,
                    fingerprint,
                    attemptId,
                    now);
              } catch (DataIntegrityViolationException concurrent) {
                // A concurrent reservation won this key; the client retries into replay.
                throw new ProviderTransientException();
              }
              attempts.flush();
              return new Reservation(attemptId, false, now);
            });
    if (reservation.replay()) {
      StartResult replayed =
          transactions.execute(
              status -> {
                lockFinance(householdId, actorId);
                return replayStart(householdId, actorId, idempotencyKey);
              });
      if (replayed == null) {
        throw new LinkAttemptExpiredException();
      }
      return replayed;
    }
    UUID attemptId = reservation.attemptId();
    PlaidAdapter.LinkToken token;
    try {
      token = adapter.createLinkToken(attemptId, linkUserId(householdId, actorId));
    } catch (PlaidAdapterException failed) {
      // Persist the failure first: throwing inside the transaction would roll the
      // markers back and lose the durable outcome.
      transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
            Instant now = now();
            attempt.finish("FAILED", null, failed.getErrorClass().name(), now);
            attempts.saveAndFlush(attempt);
            return null;
          });
      throw mapProviderFailure(failed);
    }
    StartResult attached =
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              ConnectionLinkAttemptEntity attempt =
                  lockOwnedAttempt(householdId, attemptId, actorId);
              Instant now = now();
              Instant expiresAt = earliest(attempt.getExpiresAt(), token.expiresAt());
              if (!now.isBefore(expiresAt)) {
                attempt.finish("EXPIRED", null, null, now);
                attempts.saveAndFlush(attempt);
                return null;
              }
              attempt.storeLinkToken(
                  crypto.encrypt(token.linkToken(), linkTokenScope(attemptId)),
                  crypto.activeKeyId(),
                  token.expiresAt(),
                  now);
              attempts.saveAndFlush(attempt);
              return new StartResult(attemptId, "NEW", token.linkToken(), expiresAt, false);
            });
    if (attached == null) {
      throw new LinkAttemptExpiredException();
    }
    return attached;
  }

  /**
   * Durably completes a link attempt. Always returns the persisted operation for durable outcomes;
   * 4xx preconditions (validation, auth, idempotency, expiry) throw instead.
   */
  public UUID complete(
      UUID householdId, UUID attemptId, UUID actorId, UUID idempotencyKey, String publicToken) {
    requireEnabled();
    if (publicToken != null && publicToken.length() > 512) {
      throw new ValidationFailedException(Map.of("publicToken", "Restart linking and try again."));
    }
    CompletionPlan plan =
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              ConnectionLinkAttemptEntity attempt =
                  lockOwnedAttempt(householdId, attemptId, actorId);
              Instant now = now();
              if ("EXPIRED".equals(attempt.getState())) {
                throw new LinkAttemptExpiredException();
              }
              if (!now.isBefore(attempt.getExpiresAt())) {
                attempt.finish("EXPIRED", null, null, now);
                attempts.saveAndFlush(attempt);
                return CompletionPlan.expiredPlan();
              }
              if (isTerminal(attempt)) {
                return terminalReplay(
                    householdId, actorId, attempt, idempotencyKey, publicToken, now);
              }
              if ("EXCHANGING".equals(attempt.getState())) {
                // A timed-out worker never re-exchanges; the outcome is unknown unless a
                // durable credential or result already proves completion.
                return markUnknown(
                    householdId,
                    actorId,
                    attempt,
                    "LINK_COMPLETE",
                    idempotencyKey,
                    publicToken,
                    now);
              }
              boolean isNew = "NEW".equals(attempt.getFlow());
              if (isNew && (publicToken == null || publicToken.isBlank())) {
                throw new ValidationFailedException(
                    Map.of("publicToken", "Restart linking and try again."));
              }
              if (!isNew && publicToken != null) {
                throw new ValidationFailedException(Map.of());
              }
              // Replay by key first: the stored HMAC key id recomputes the fingerprint,
              // so encryption-key rotation never turns a legitimate retry into a conflict.
              var record =
                  idempotency
                      .findById(
                          new ConnectionOperationIdempotencyKey(
                              actorId, householdId, "LINK_COMPLETE", idempotencyKey))
                      .orElse(null);
              if (record != null) {
                String expected = replayFingerprint(record, attempt, publicToken);
                if (!record.getRequestFingerprint().equals(expected)) {
                  throw new ConnectionIdempotencyConflictException();
                }
                return new CompletionPlan(record.getResourceId(), null, null, true, null);
              }
              String hmacKeyId = crypto.activeKeyId();
              String fingerprint = completeFingerprint(attempt, publicToken, hmacKeyId);
              UUID operationId = UUID.randomUUID();
              operations.save(
                  new ConnectionOperationEntity(
                      operationId,
                      householdId,
                      actorId,
                      attempt.getConnectionId(),
                      attemptId,
                      "LINK_COMPLETE",
                      now));
              if (isNew) {
                attempt.beginExchange(
                    operationId,
                    crypto.encrypt(publicToken, publicTokenScope(attemptId)),
                    crypto.activeKeyId(),
                    now);
              } else {
                attempt.beginUpdateCompletion(operationId, now);
              }
              try {
                reserve(
                    actorId,
                    householdId,
                    "LINK_COMPLETE",
                    idempotencyKey,
                    fingerprint,
                    operationId,
                    hmacKeyId,
                    now);
              } catch (DataIntegrityViolationException concurrent) {
                status.setRollbackOnly();
                return new CompletionPlan(null, null, null, true, null);
              }
              attempts.flush();
              operations.flush();
              return new CompletionPlan(
                  operationId, attempt.getFlow(), publicToken, false, attempt.getConnectionId());
            });
    if (plan.expired()) {
      throw new LinkAttemptExpiredException();
    }
    if (plan.replayOperation()) {
      return transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
            var record =
                idempotency
                    .findById(
                        new ConnectionOperationIdempotencyKey(
                            actorId, householdId, "LINK_COMPLETE", idempotencyKey))
                    .orElseThrow(ConnectionIdempotencyConflictException::new);
            String expected = replayFingerprint(record, attempt, publicToken);
            if (!record.getRequestFingerprint().equals(expected)) {
              throw new ConnectionIdempotencyConflictException();
            }
            return record.getResourceId();
          });
    }
    if (plan.knownOperation() != null) {
      return plan.knownOperation();
    }
    boolean isNew = "NEW".equals(plan.flow());
    if (!isNew) {
      return completeUpdate(plan.operationId(), attemptId, householdId, actorId);
    }
    return completeNew(plan.operationId(), attemptId, householdId, actorId, plan.publicToken());
  }

  private UUID completeNew(
      UUID operationId, UUID attemptId, UUID householdId, UUID actorId, String publicToken) {
    String remoteItemId;
    String accessToken;
    List<RemoteAccount> remoteAccounts;
    try {
      PlaidAdapter.ExchangeResult exchanged = adapter.exchangePublicToken(publicToken);
      remoteItemId = exchanged.remoteItemId();
      accessToken = exchanged.accessToken();
      remoteAccounts = adapter.fetchAccounts(accessToken);
    } catch (PlaidAdapter.AmbiguousExchangeException unknown) {
      return transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
            Instant now = now();
            attempt.finish("OUTCOME_UNKNOWN", null, "EXCHANGE_UNKNOWN", now);
            finishOperation(operationId, "OUTCOME_UNKNOWN", "EXCHANGE_UNKNOWN", now);
            return operationId;
          });
    } catch (PlaidAdapterException failed) {
      transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
            Instant now = now();
            attempt.finish("FAILED", null, failed.getErrorClass().name(), now);
            finishOperation(operationId, "FAILED", failed.getErrorClass().name(), now);
            return null;
          });
      throw mapProviderFailure(failed);
    } catch (RuntimeException unexpected) {
      return transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
            finishOperation(operationId, "OUTCOME_UNKNOWN", "EXCHANGE_UNKNOWN", now());
            attempt.finish("OUTCOME_UNKNOWN", null, "EXCHANGE_UNKNOWN", now());
            return operationId;
          });
    }
    final String itemId = remoteItemId;
    final String credential = accessToken;
    final List<RemoteAccount> discovered = remoteAccounts;
    try {
      UUID committed;
      try {
        committed =
            transactions.execute(
                status -> {
                  lockFinance(householdId, actorId);
                  return commitNewLink(
                      operationId, attemptId, householdId, actorId, itemId, credential, discovered);
                });
      } catch (DataIntegrityViolationException duplicate) {
        // The failed flush poisons that transaction; record the outcome in a fresh one.
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              ConnectionLinkAttemptEntity retry = lockOwnedAttempt(householdId, attemptId, actorId);
              Instant failedAt = now();
              retry.finish("FAILED", null, "ALREADY_LINKED", failedAt);
              finishOperation(operationId, "FAILED", "ALREADY_LINKED", failedAt);
              return null;
            });
        committed = null;
      }
      if (committed == null) {
        throw new ConnectionNotReadyException();
      }
      return committed;
    } catch (HouseholdNotFoundException membershipLost) {
      // Membership vanished mid-link: suspend immediately and queue revocation instead of
      // admitting accounts.
      return transactions.execute(
          status -> {
            Instant now = now();
            String digest = itemDigest(itemId);
            UUID connectionId = UUID.randomUUID();
            FinancialConnectionEntity connection =
                new FinancialConnectionEntity(
                    connectionId,
                    householdId,
                    actorId,
                    adapter.providerName(),
                    properties.environmentToken(),
                    digest,
                    crypto.encrypt(credential, credentialScope(connectionId)),
                    crypto.activeKeyId(),
                    now);
            connection.fence("SUSPENDED", now);
            connections.save(connection);
            queueRevocation(connection.getId(), now);
            ConnectionLinkAttemptEntity attempt =
                attempts.findById(attemptId).orElseThrow(ConnectionNotFoundException::new);
            attempt.finish("OUTCOME_UNKNOWN", connection.getId(), "MEMBERSHIP_REMOVED", now);
            finishOperation(operationId, "FAILED", "MEMBERSHIP_REMOVED", now);
            return operationId;
          });
    }
  }

  /**
   * Commits a new link inside the caller's transaction. Returns the connection id, or null when the
   * Item is already linked (FAILED markers are persisted; the caller throws outside the transaction
   * so the markers survive).
   */
  private UUID commitNewLink(
      UUID operationId,
      UUID attemptId,
      UUID householdId,
      UUID actorId,
      String remoteItemId,
      String accessToken,
      List<RemoteAccount> discovered) {
    Instant now = now();
    ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
    if (!"EXCHANGING".equals(attempt.getState()) || !operationId.equals(attempt.getOperationId())) {
      throw new ConnectionNotReadyException();
    }
    String digest = itemDigest(remoteItemId);
    var alreadyLinked =
        connections.findByProviderAndEnvironmentAndRemoteItemDigest(
            adapter.providerName(), properties.environmentToken(), digest);
    if (alreadyLinked.isPresent()) {
      attempt.finish("FAILED", null, "ALREADY_LINKED", now);
      finishOperation(operationId, "FAILED", "ALREADY_LINKED", now);
      return null;
    }
    UUID connectionId = UUID.randomUUID();
    FinancialConnectionEntity connection =
        new FinancialConnectionEntity(
            connectionId,
            householdId,
            actorId,
            adapter.providerName(),
            properties.environmentToken(),
            digest,
            crypto.encrypt(accessToken, credentialScope(connectionId)),
            crypto.activeKeyId(),
            now);
    connections.save(connection);
    // A unique-violation here propagates to the caller, which records FAILED markers in a
    // fresh transaction (this one is poisoned by the failed flush).
    connections.flush();
    storeDiscoveredMappings(connection, discovered, now);
    attempt.finish("SUCCEEDED", connectionId, null, now);
    ConnectionOperationEntity operation =
        operations.findById(operationId).orElseThrow(ConnectionNotFoundException::new);
    operation.bindConnection(connectionId, now);
    operation.finish("SUCCEEDED", null, now);
    // Persist an initial sync demand with the link so history is fetched even without a webhook.
    demands.demand(connectionId, now);
    return operationId;
  }

  private UUID completeUpdate(UUID operationId, UUID attemptId, UUID householdId, UUID actorId) {
    String credential =
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              ConnectionLinkAttemptEntity attempt =
                  lockOwnedAttempt(householdId, attemptId, actorId);
              FinancialConnectionEntity connection =
                  lockOwnedConnection(householdId, attempt.getConnectionId(), actorId);
              if (!"EXCHANGING".equals(attempt.getState())
                  || !operationId.equals(attempt.getOperationId())) {
                throw new ConnectionNotReadyException();
              }
              if (connection.getEncryptedCredential() == null) {
                throw new ConnectionNotReadyException();
              }
              try {
                return crypto.decrypt(
                    connection.getEncryptedCredential(), credentialScope(connection.getId()));
              } catch (ConnectionCrypto.CredentialCryptoException failed) {
                throw new ConnectionNotReadyException();
              }
            });
    // Explicit recovery verification before ACTIVE; the committed cursor is retained.
    final List<RemoteAccount> recovered;
    try {
      recovered = adapter.fetchAccounts(credential);
    } catch (RuntimeException unexpected) {
      if (unexpected instanceof PlaidAdapterException failed) {
        var errorClass = failed.getErrorClass();
        // An exhausted version counter must still leave a durable FAILED outcome behind;
        // the 409 surfaces outside the transaction so the markers survive.
        String outcome =
            transactions.execute(
                status -> {
                  lockFinance(householdId, actorId);
                  ConnectionLinkAttemptEntity attempt =
                      lockOwnedAttempt(householdId, attemptId, actorId);
                  Instant now = now();
                  if (errorClass
                      == com.housesync.finance.connection.plaid.ProviderErrorClass
                          .REAUTH_REQUIRED) {
                    FinancialConnectionEntity connection =
                        lockOwnedConnection(householdId, attempt.getConnectionId(), actorId);
                    if ("ACTIVE".equals(connection.getState())) {
                      if (connection.getVersion() == Integer.MAX_VALUE) {
                        attempt.finish("FAILED", null, "VERSION_EXHAUSTED", now);
                        finishOperation(operationId, "FAILED", "VERSION_EXHAUSTED", now);
                        return "exhausted";
                      }
                      connection.transition("REAUTH_REQUIRED", now);
                    }
                  } else if (errorClass
                          == com.housesync.finance.connection.plaid.ProviderErrorClass
                              .CONSENT_REVOKED
                      || errorClass
                          == com.housesync.finance.connection.plaid.ProviderErrorClass.PERMANENT) {
                    // The credential is dead: the connection must not stay importable. Fence
                    // it suspended and queue remote cleanup instead of leaving it ACTIVE.
                    FinancialConnectionEntity connection =
                        lockOwnedConnection(householdId, attempt.getConnectionId(), actorId);
                    if (connection.getVersion() == Integer.MAX_VALUE) {
                      attempt.finish("FAILED", null, "VERSION_EXHAUSTED", now);
                      finishOperation(operationId, "FAILED", "VERSION_EXHAUSTED", now);
                      return "exhausted";
                    }
                    connection.fence("SUSPENDED", now);
                    queueRevocation(connection.getId(), now);
                  }
                  attempt.finish("FAILED", null, errorClass.name(), now);
                  finishOperation(operationId, "FAILED", errorClass.name(), now);
                  return "failed";
                });
        if ("exhausted".equals(outcome)) {
          throw new com.housesync.finance.account.web.FinancialAccountExceptions
              .ResourceVersionExhaustedException();
        }
        if (errorClass == com.housesync.finance.connection.plaid.ProviderErrorClass.CONSENT_REVOKED
            || errorClass == com.housesync.finance.connection.plaid.ProviderErrorClass.PERMANENT) {
          throw new com.housesync.finance.connection.web.ConnectionExceptions
              .ConnectionDisconnectedException();
        }
        throw mapProviderFailure(failed);
      }
      return transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
            Instant now = now();
            attempt.finish("OUTCOME_UNKNOWN", null, "RECOVERY_UNKNOWN", now);
            finishOperation(operationId, "OUTCOME_UNKNOWN", "RECOVERY_UNKNOWN", now);
            return operationId;
          });
    }
    try {
      UpdateCommit commit =
          transactions.execute(
              status -> {
                lockFinance(householdId, actorId);
                Instant now = now();
                ConnectionLinkAttemptEntity attempt =
                    lockOwnedAttempt(householdId, attemptId, actorId);
                FinancialConnectionEntity connection =
                    lockOwnedConnection(householdId, attempt.getConnectionId(), actorId);
                if (!"EXCHANGING".equals(attempt.getState())
                    || !operationId.equals(attempt.getOperationId())) {
                  throw new ConnectionNotReadyException();
                }
                // A late completion cannot defeat a subsequent disconnect or membership
                // removal.
                if (attempt.getExpectedGeneration() == null
                    || connection.getGeneration() != attempt.getExpectedGeneration()) {
                  attempt.finish("FAILED", null, "GENERATION_SUPERSEDED", now);
                  finishOperation(operationId, "FAILED", "GENERATION_SUPERSEDED", now);
                  return UpdateCommit.rejectedPlan();
                }
                if (!"ACTIVE".equals(connection.getState())
                    && !"REAUTH_REQUIRED".equals(connection.getState())) {
                  attempt.finish("FAILED", null, "CONNECTION_INACTIVE", now);
                  finishOperation(operationId, "FAILED", "CONNECTION_INACTIVE", now);
                  return UpdateCommit.rejectedPlan();
                }
                storeDiscoveredMappings(connection, recovered, now);
                if (!"ACTIVE".equals(connection.getState())) {
                  requireVersionCapacity(connection);
                  connection.transition("ACTIVE", now);
                }
                attempt.finish("SUCCEEDED", connection.getId(), null, now);
                finishOperation(operationId, "SUCCEEDED", null, now);
                // Reconnect completion wakes the retained cursor with fresh demand.
                demands.demand(connection.getId(), now);
                return new UpdateCommit(operationId);
              });
      if (commit.rejected()) {
        throw new ConnectionNotReadyException();
      }
      return commit.operationId();
    } catch (HouseholdNotFoundException membershipLost) {
      return transactions.execute(
          status -> {
            // Membership vanished: the lifecycle hook owns suspension; record the outcome.
            ConnectionLinkAttemptEntity attempt =
                attempts.findById(attemptId).orElseThrow(ConnectionNotFoundException::new);
            Instant now = now();
            attempt.finish("OUTCOME_UNKNOWN", null, "MEMBERSHIP_REMOVED", now);
            finishOperation(operationId, "FAILED", "MEMBERSHIP_REMOVED", now);
            return operationId;
          });
    }
  }

  private CompletionPlan terminalReplay(
      UUID householdId,
      UUID actorId,
      ConnectionLinkAttemptEntity attempt,
      UUID idempotencyKey,
      String publicToken,
      Instant now) {
    var record =
        idempotency
            .findById(
                new ConnectionOperationIdempotencyKey(
                    actorId, householdId, "LINK_COMPLETE", idempotencyKey))
            .orElse(null);
    if (record != null) {
      String expected = replayFingerprint(record, attempt, publicToken);
      if (!record.getRequestFingerprint().equals(expected)) {
        // Same key, different canonical details: classic idempotency conflict.
        throw new ConnectionIdempotencyConflictException();
      }
      return new CompletionPlan(record.getResourceId(), null, null, true, null);
    }
    // Another key cannot trigger a second exchange on a completed attempt.
    if (!"LINK_TOKEN_ISSUED".equals(attempt.getState())) {
      throw new ConnectionNotReadyException();
    }
    throw new ConnectionIdempotencyConflictException();
  }

  private CompletionPlan markUnknown(
      UUID householdId,
      UUID actorId,
      ConnectionLinkAttemptEntity attempt,
      String operation,
      UUID idempotencyKey,
      String publicToken,
      Instant now) {
    var record =
        idempotency
            .findById(
                new ConnectionOperationIdempotencyKey(
                    actorId, householdId, operation, idempotencyKey))
            .orElse(null);
    if (record != null) {
      String expected = replayFingerprint(record, attempt, publicToken);
      if (!record.getRequestFingerprint().equals(expected)) {
        throw new ConnectionIdempotencyConflictException();
      }
      return new CompletionPlan(record.getResourceId(), null, null, true, null);
    }
    UUID operationId = attempt.getOperationId();
    if (operationId == null) {
      throw new ConnectionNotReadyException();
    }
    attempt.finish("OUTCOME_UNKNOWN", null, "EXCHANGE_UNKNOWN", now);
    finishOperation(operationId, "OUTCOME_UNKNOWN", "EXCHANGE_UNKNOWN", now);
    return new CompletionPlan(operationId, null, null, false, null);
  }

  private void storeDiscoveredMappings(
      FinancialConnectionEntity connection, List<RemoteAccount> discovered, Instant now) {
    for (RemoteAccount remote : discovered) {
      String digest = accountDigest(remote.remoteAccountId());
      var existing = mappings.findByConnectionIdAndRemoteAccountDigest(connection.getId(), digest);
      // Ineligible accounts keep a null classification with an explicit reason; no
      // fabricated USD/CHECKING fallback is ever persisted.
      String kind = eligibleKind(remote.kind());
      String rawCurrency =
          remote.currency() == null || remote.currency().isBlank() ? null : remote.currency();
      String currency = eligibleCurrency(rawCurrency);
      boolean eligible = kind != null && currency != null;
      String reason =
          eligible ? null : (kind == null ? "UNSUPPORTED_KIND" : "UNSUPPORTED_CURRENCY");
      String label = safeLabel(remote.name());
      if (existing.isPresent()) {
        ConnectionAccountMappingEntity mapping = existing.get();
        if (mapping.getLocalAccountId() != null) {
          // Admitted account identity is immutable: provider metadata never rewrites the
          // admitted kind, currency, or local label. A conflicting classification blocks
          // new admission for this mapping until the owner resolves it.
          if (kind == null
              || currency == null
              || !kind.equals(mapping.getKind())
              || !currency.equals(mapping.getCurrency())) {
            mapping.blockIdentityConflict("IDENTITY_CONFLICT", now);
          }
        } else {
          mapping.refreshMetadata(label, kind, currency, eligible, reason, now);
        }
      } else {
        mappings.save(
            new ConnectionAccountMappingEntity(
                UUID.randomUUID(),
                connection.getId(),
                connection.getHouseholdId(),
                connection.getOwnerUserId(),
                digest,
                label,
                kind,
                currency,
                eligible,
                reason,
                now));
      }
    }
    mappings.flush();
  }

  private StartResult replayStart(UUID householdId, UUID actorId, UUID idempotencyKey) {
    var stored = replay(actorId, householdId, "LINK_START", idempotencyKey, startFingerprint());
    if (stored == null) {
      throw new ConnectionIdempotencyConflictException();
    }
    ConnectionLinkAttemptEntity attempt =
        lockOwnedAttempt(householdId, stored.getResourceId(), actorId);
    Instant now = now();
    if (!"LINK_TOKEN_ISSUED".equals(attempt.getState())
        || attempt.getEncryptedLinkToken() == null) {
      if ("FAILED".equals(attempt.getState())) {
        throw mapStoredFailure(attempt.getErrorCode());
      }
      throw new ConnectionNotReadyException();
    }
    Instant expiresAt = earliest(attempt.getExpiresAt(), attempt.getLinkTokenExpiresAt());
    if (!now.isBefore(expiresAt)) {
      attempt.finish("EXPIRED", null, null, now);
      attempts.saveAndFlush(attempt);
      return null;
    }
    String linkToken;
    try {
      linkToken = crypto.decrypt(attempt.getEncryptedLinkToken(), linkTokenScope(attempt.getId()));
    } catch (ConnectionCrypto.CredentialCryptoException failed) {
      throw new ConnectionNotReadyException();
    }
    return new StartResult(attempt.getId(), attempt.getFlow(), linkToken, expiresAt, true);
  }

  private void finishOperation(UUID operationId, String state, String error, Instant now) {
    ConnectionOperationEntity operation =
        operations.findById(operationId).orElseThrow(ConnectionNotFoundException::new);
    operation.finish(state, error, now);
    operations.saveAndFlush(operation);
  }

  private void queueRevocation(UUID connectionId, Instant now) {
    revocations.save(new ConnectionRevocationWorkEntity(UUID.randomUUID(), connectionId, now));
    revocations.flush();
  }

  private String startFingerprint() {
    return fingerprint(
        "LINK_START\0"
            + adapter.providerName()
            + "\0"
            + properties.environmentToken()
            + "\0NEW\0US/CA:transactions");
  }

  private String completeFingerprint(
      ConnectionLinkAttemptEntity attempt, String publicToken, String hmacKeyId) {
    String tokenPart =
        "NEW".equals(attempt.getFlow()) && publicToken != null
            ? crypto.hmacHex(hmacKeyId, publicToken)
            : "";
    return fingerprint(
        "LINK_COMPLETE\0" + attempt.getId() + "\0" + attempt.getFlow() + "\0" + tokenPart);
  }

  /**
   * Recomputes a reserved fingerprint with its stored HMAC key. A retired key (removed from
   * configuration) maps to a safe idempotency conflict directing the client to a new key, never a
   * raw 500.
   */
  private String replayFingerprint(
      ConnectionOperationIdempotencyEntity record,
      ConnectionLinkAttemptEntity attempt,
      String publicToken) {
    String keyId = record.getHmacKeyId() == null ? crypto.activeKeyId() : record.getHmacKeyId();
    try {
      return completeFingerprint(attempt, publicToken, keyId);
    } catch (ConnectionCrypto.CredentialCryptoException retired) {
      throw new ConnectionIdempotencyConflictException();
    }
  }

  /**
   * Opaque Plaid user identity derived from the stable local owner (household plus user), never
   * email or provider data, and never exposed to the browser.
   */
  static String linkUserId(UUID householdId, UUID actorId) {
    return ConnectionCrypto.sha256Hex("link-user\0" + householdId + "\0" + actorId);
  }

  private String itemDigest(String remoteItemId) {
    return ConnectionCrypto.sha256Hex(
        adapter.providerName() + "\0" + properties.environmentToken() + "\0" + remoteItemId);
  }

  private String accountDigest(String remoteAccountId) {
    return ConnectionCrypto.sha256Hex(
        adapter.providerName() + "\0" + properties.environmentToken() + "\0" + remoteAccountId);
  }

  private static boolean isTerminal(ConnectionLinkAttemptEntity attempt) {
    return switch (attempt.getState()) {
      case "SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN", "EXPIRED" -> true;
      default -> false;
    };
  }

  private static Instant earliest(Instant first, Instant second) {
    if (first == null) return second;
    if (second == null) return first;
    return first.isBefore(second) ? first : second;
  }

  private static String eligibleKind(String kind) {
    return switch (kind) {
      case "CHECKING", "SAVINGS", "CREDIT_CARD" -> kind;
      default -> null;
    };
  }

  private static String eligibleCurrency(String currency) {
    if (currency == null) return null;
    try {
      SupportedCurrency.valueOf(currency);
      return currency;
    } catch (IllegalArgumentException rejected) {
      return null;
    }
  }

  static String safeLabel(String name) {
    if (name == null) return "Connected account";
    String trimmed = name.strip();
    if (trimmed.isEmpty()) return "Connected account";
    int[] codePoints = trimmed.codePoints().limit(101).toArray();
    if (codePoints.length > 100) {
      trimmed = new String(codePoints, 0, 100);
    }
    String cleaned = trimmed.replaceAll("[\\p{Cntrl}]", "");
    return cleaned.isEmpty() ? "Connected account" : cleaned;
  }

  private RuntimeException mapProviderFailure(PlaidAdapterException failed) {
    return switch (failed.getErrorClass()) {
      case TRANSIENT, RATE_LIMITED, NOT_READY -> new ProviderTransientException();
      default -> new ConnectionNotReadyException();
    };
  }

  private RuntimeException mapStoredFailure(String errorCode) {
    if ("TRANSIENT".equals(errorCode)
        || "RATE_LIMITED".equals(errorCode)
        || "NOT_READY".equals(errorCode)) {
      return new ProviderTransientException();
    }
    if ("MEMBERSHIP_REMOVED".equals(errorCode)) {
      throw new ConnectionNotFoundException();
    }
    return new ConnectionNotReadyException();
  }

  public record StartResult(
      UUID attemptId, String flow, String linkToken, Instant expiresAt, boolean replayed) {}

  private record Reservation(UUID attemptId, boolean replay, Instant now) {}

  private record UpdateCommit(UUID operationId) {
    boolean rejected() {
      return operationId == null;
    }

    static UpdateCommit rejectedPlan() {
      return new UpdateCommit(null);
    }
  }

  private record CompletionPlan(
      UUID operationId,
      String flow,
      String publicToken,
      boolean replayOperation,
      UUID connectionId) {
    UUID knownOperation() {
      return replayOperation ? null : (flow == null ? operationId : null);
    }

    boolean expired() {
      return operationId == null && flow == null && !replayOperation;
    }

    static CompletionPlan expiredPlan() {
      return new CompletionPlan(null, null, null, false, null);
    }
  }
}
