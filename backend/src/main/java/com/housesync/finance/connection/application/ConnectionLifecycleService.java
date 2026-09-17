package com.housesync.finance.connection.application;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptEntity;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationEntity;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkEntity;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapterException;
import com.housesync.finance.connection.plaid.ProviderErrorClass;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionDisconnectedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotReadyException;
import com.housesync.finance.connection.web.ConnectionExceptions.ProviderTransientException;
import com.housesync.household.application.HouseholdService;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Reconnect, disconnect, remote-revocation, and membership-loss lifecycle.
 *
 * <p>Disconnect fences local state and generation immediately in the lifecycle transaction and
 * queues durable remote removal; the worker finishes removal without needing membership. Reconnect
 * start bumps generation plus version, and completion verifies the same generation so a late
 * completion cannot defeat a subsequent disconnect or removal.
 *
 * <p>Revocation claims carry a bounded fencing lease: only the holder of the current fence and
 * owner may commit an outcome. A crashed holder's lease expires and becomes reclaimable with a
 * higher fence, so a late loser can never commit over the winner.
 */
@Service
public class ConnectionLifecycleService extends ConnectedFinanceBase
    implements ConnectionMembershipHook {

  private static final Duration LEASE_DURATION = Duration.ofMinutes(2);

  private final RevocationRetryPolicy retryPolicy;
  private final String workerOwnerId;

  @Autowired
  public ConnectionLifecycleService(
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
      RevocationRetryPolicy retryPolicy) {
    this(
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
        transactionManager,
        retryPolicy,
        "revocation-" + UUID.randomUUID());
  }

  /**
   * Test-only construction with a distinct worker identity, so fence tests can prove that a
   * superseded lease holder cannot commit over the reclaiming worker. Production wiring always uses
   * the random-identity constructor above; nothing in production calls this.
   */
  public ConnectionLifecycleService(
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
      RevocationRetryPolicy retryPolicy,
      String workerOwnerId) {
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
    this.retryPolicy = retryPolicy;
    this.workerOwnerId = workerOwnerId;
  }

  /** Starts update-mode reconnect: fences workers, then attaches the provider Link token. */
  public ReconnectResult reconnect(
      UUID householdId, UUID connectionId, UUID actorId, UUID idempotencyKey, int expectedVersion) {
    requireEnabled();
    String fingerprint =
        fingerprint(
            "RECONNECT\0"
                + connectionId
                + "\0"
                + expectedVersion
                + "\0"
                + adapter.providerName()
                + "\0"
                + properties.environmentToken()
                + "\0UPDATE");
    Reservation reservation =
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              var replayed = replay(actorId, householdId, "RECONNECT", idempotencyKey, fingerprint);
              if (replayed != null) {
                return new Reservation(replayed.getResourceId(), true);
              }
              FinancialConnectionEntity connection =
                  lockOwnedConnection(householdId, connectionId, actorId);
              if (connection.getVersion() != expectedVersion) {
                throw new com.housesync.finance.account.web.FinancialAccountExceptions
                    .ResourceVersionConflictException();
              }
              requireReconnectEligible(connection);
              if (connection.getEncryptedCredential() == null) {
                throw new ConnectionNotReadyException();
              }
              requireVersionCapacity(connection);
              Instant now = now();
              connection.beginReconnect(now);
              UUID attemptId = UUID.randomUUID();
              Instant expiresAt = now.plusSeconds(properties.getAttemptTtlMinutes() * 60L);
              ConnectionLinkAttemptEntity attempt =
                  new ConnectionLinkAttemptEntity(
                      attemptId,
                      householdId,
                      actorId,
                      "UPDATE",
                      properties.environmentToken(),
                      connectionId,
                      now,
                      expiresAt);
              attempt.setExpectedGeneration(connection.getGeneration());
              attempts.save(attempt);
              try {
                reserve(
                    actorId, householdId, "RECONNECT", idempotencyKey, fingerprint, attemptId, now);
              } catch (DataIntegrityViolationException concurrent) {
                throw new ProviderTransientException();
              }
              attempts.flush();
              return new Reservation(attemptId, false);
            });
    if (reservation.replay()) {
      return transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            var stored = replay(actorId, householdId, "RECONNECT", idempotencyKey, fingerprint);
            if (stored == null) {
              throw new com.housesync.finance.connection.web.ConnectionExceptions
                  .ConnectionIdempotencyConflictException();
            }
            return new ReconnectResult(stored.getResourceId(), true);
          });
    }
    UUID attemptId = reservation.attemptId();
    String credential =
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              FinancialConnectionEntity connection =
                  lockOwnedConnection(householdId, connectionId, actorId);
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
    PlaidAdapter.LinkToken token;
    try {
      token = adapter.createUpdateLinkToken(credential);
    } catch (PlaidAdapterException failed) {
      transactions.execute(
          status -> {
            lockFinance(householdId, actorId);
            ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
            attempt.finish("FAILED", null, failed.getErrorClass().name(), now());
            attempts.saveAndFlush(attempt);
            return null;
          });
      throw mapReconnectFailure(failed);
    }
    transactions.execute(
        status -> {
          lockFinance(householdId, actorId);
          ConnectionLinkAttemptEntity attempt = lockOwnedAttempt(householdId, attemptId, actorId);
          Instant now = now();
          Instant expiresAt = earliest(attempt.getExpiresAt(), token.expiresAt());
          if (!now.isBefore(expiresAt)) {
            attempt.finish("EXPIRED", null, null, now);
            attempts.saveAndFlush(attempt);
            throw new com.housesync.finance.connection.web.ConnectionExceptions
                .LinkAttemptExpiredException();
          }
          attempt.storeLinkToken(
              crypto.encrypt(token.linkToken(), linkTokenScope(attemptId)),
              crypto.activeKeyId(),
              token.expiresAt(),
              now);
          attempts.saveAndFlush(attempt);
          return null;
        });
    return new ReconnectResult(attemptId, false);
  }

  /**
   * Reads back the encrypted replay copy of an update-mode Link token inside a membership-checked
   * transaction. Surfaces stored provider failures without their detail.
   */
  public ReconnectView reconnectView(
      UUID householdId, UUID connectionId, UUID attemptId, UUID actorId) {
    requireEnabled();
    ReconnectView view =
        transactions.execute(
            status -> {
              lockFinance(householdId, actorId);
              ConnectionLinkAttemptEntity attempt =
                  lockOwnedAttempt(householdId, attemptId, actorId);
              if (!connectionId.equals(attempt.getConnectionId())) {
                throw new com.housesync.finance.connection.web.ConnectionExceptions
                    .ConnectionNotFoundException();
              }
              if ("FAILED".equals(attempt.getState())) {
                String error = attempt.getErrorCode();
                if ("TRANSIENT".equals(error)
                    || "RATE_LIMITED".equals(error)
                    || "NOT_READY".equals(error)) {
                  throw new ProviderTransientException();
                }
                throw new ConnectionNotReadyException();
              }
              if (attempt.getEncryptedLinkToken() == null
                  || !"LINK_TOKEN_ISSUED".equals(attempt.getState())) {
                throw new ConnectionNotReadyException();
              }
              Instant now = now();
              Instant expiresAt = earliest(attempt.getExpiresAt(), attempt.getLinkTokenExpiresAt());
              if (!now.isBefore(expiresAt)) {
                attempt.finish("EXPIRED", null, null, now);
                attempts.saveAndFlush(attempt);
                return null;
              }
              String linkToken;
              try {
                linkToken =
                    crypto.decrypt(
                        attempt.getEncryptedLinkToken(), linkTokenScope(attempt.getId()));
              } catch (ConnectionCrypto.CredentialCryptoException failed) {
                throw new ConnectionNotReadyException();
              }
              return new ReconnectView(linkToken, expiresAt);
            });
    if (view == null) {
      throw new com.housesync.finance.connection.web.ConnectionExceptions
          .LinkAttemptExpiredException();
    }
    return view;
  }

  /**
   * Owner disconnect: fences state and generation locally and queues durable remote removal.
   * Returns the disconnect operation; remote confirmation is polled through the operation GET and
   * finished by the revocation worker.
   */
  public UUID disconnect(
      UUID householdId, UUID connectionId, UUID actorId, UUID idempotencyKey, int expectedVersion) {
    requireEnabled();
    String fingerprint = fingerprint("DISCONNECT\0" + connectionId + "\0" + expectedVersion);
    return transactions.execute(
        status -> {
          lockFinance(householdId, actorId);
          var replayed = replay(actorId, householdId, "DISCONNECT", idempotencyKey, fingerprint);
          if (replayed != null) {
            return replayed.getResourceId();
          }
          FinancialConnectionEntity connection =
              lockOwnedConnection(householdId, connectionId, actorId);
          if ("DISCONNECTED".equals(connection.getState())) {
            throw new ConnectionDisconnectedException();
          }
          if (connection.getVersion() != expectedVersion) {
            throw new com.housesync.finance.account.web.FinancialAccountExceptions
                .ResourceVersionConflictException();
          }
          Instant now = now();
          if (!"DISCONNECTING".equals(connection.getState())) {
            requireVersionCapacity(connection);
            connection.fence("DISCONNECTING", now);
          }
          UUID operationId = UUID.randomUUID();
          operations.save(
              new ConnectionOperationEntity(
                  operationId, householdId, actorId, connectionId, null, "DISCONNECT", now));
          queueRevocationIfAbsent(connectionId, now);
          try {
            reserve(
                actorId, householdId, "DISCONNECT", idempotencyKey, fingerprint, operationId, now);
          } catch (DataIntegrityViolationException concurrent) {
            throw new ProviderTransientException();
          }
          operations.flush();
          return operationId;
        });
  }

  /**
   * Membership leave/removal hook: runs inside the lifecycle transaction, suspends the departed
   * member's live connections with generation fencing, and queues revocation. Revocation work
   * survives the membership loss by design.
   */
  @Override
  @Transactional(propagation = Propagation.MANDATORY)
  public void suspendOwnerConnections(UUID householdId, UUID ownerUserId) {
    for (FinancialConnectionEntity summary :
        connections.findByHouseholdIdAndOwnerUserId(householdId, ownerUserId)) {
      var locked = connections.findByIdForUpdate(summary.getId()).orElse(null);
      if (locked == null
          || !locked.getHouseholdId().equals(householdId)
          || !locked.getOwnerUserId().equals(ownerUserId)) {
        continue;
      }
      Instant now = now();
      switch (locked.getState()) {
        case "LINKING", "ACTIVE", "REAUTH_REQUIRED", "ERROR" -> {
          // Version exhaustion must never fail membership removal: queue cleanup and
          // degrade to revocation-only when the fence cannot be recorded.
          try {
            requireVersionCapacity(locked);
          } catch (
              com.housesync.finance.account.web.FinancialAccountExceptions
                      .ResourceVersionExhaustedException
                  exhausted) {
            queueRevocationIfAbsent(locked.getId(), now);
            continue;
          }
          locked.fence("SUSPENDED", now);
          queueRevocationIfAbsent(locked.getId(), now);
        }
        case "DISCONNECTING", "SUSPENDED" -> queueRevocationIfAbsent(locked.getId(), now);
        default -> {
          // DISCONNECTED needs no cleanup.
        }
      }
    }
  }

  /**
   * Revocation worker: finishes confirmed or failed remote removals without requiring membership.
   * Ambiguous outcomes retain credentials and stay visibly retryable; only a confirmed removal
   * erases them. Claims hold a bounded fencing lease; crashed holders expire and are reclaimed.
   */
  @Scheduled(fixedDelayString = "${app.connected-finance.revocation-poll-ms:60000}")
  public void processDueRevocations() {
    if (!properties.isEnabled()) {
      return;
    }
    Instant now = now();
    for (ConnectionRevocationWorkEntity due : revocations.findDue(now, PageRequest.of(0, 10))) {
      processOneRevocation(due.getId());
    }
  }

  /**
   * Scheduled scrubber for link attempts that expired without ever reaching exchange. Terminal
   * token erasure happens without any client touch; EXCHANGING rows stay with the completion path,
   * which owns their outcome.
   */
  @Scheduled(fixedDelayString = "${app.connected-finance.attempt-cleanup-ms:300000}")
  public void scrubExpiredAttempts() {
    if (!properties.isEnabled()) {
      return;
    }
    transactions.execute(
        status -> {
          Instant now = now();
          for (ConnectionLinkAttemptEntity attempt :
              attempts.findExpiredIssuedForScrub(now, PageRequest.of(0, 50))) {
            attempt.finish("EXPIRED", null, null, now);
          }
          attempts.flush();
          return null;
        });
  }

  /** Test and operator entry point for one revocation without waiting for the schedule. */
  public void processOneRevocation(UUID workId) {
    if (!properties.isEnabled()) {
      return;
    }
    RevocationTarget target = claim(workId);
    if (target == null) {
      return;
    }
    if (target.credential() == null) {
      // Nothing remotely provisioned (link never completed): local completion suffices.
      transactions.execute(
          status -> {
            FinancialConnectionEntity connection =
                connections.findByIdForUpdate(target.connectionId()).orElse(null);
            ConnectionRevocationWorkEntity work =
                revocations.findByIdForUpdate(target.workId()).orElse(null);
            if (connection == null || work == null || !leaseMatches(work, target)) {
              return null;
            }
            Instant now = now();
            if (!"DISCONNECTED".equals(connection.getState())) {
              if (connection.getVersion() == Integer.MAX_VALUE) {
                work.fail("VERSION_EXHAUSTED", now);
                return null;
              }
              connection.confirmRemoteRemoval(now);
            }
            work.complete(now);
            succeedDisconnectOperations(connection.getId(), now);
            return null;
          });
      return;
    }
    try {
      adapter.removeItem(target.credential());
    } catch (PlaidAdapter.AmbiguousRemovalException unknown) {
      commitOutcome(target, "REMOVAL_UNKNOWN", null, true);
      return;
    } catch (PlaidAdapterException failed) {
      if (failed.getErrorClass() == ProviderErrorClass.CONSENT_REVOKED
          || failed.getErrorClass() == ProviderErrorClass.PERMANENT) {
        // The remote Item is already gone from the provider's perspective.
        commitRemoval(target);
        return;
      }
      commitOutcome(target, failed.getErrorClass().name(), failed.getRetryAfterSeconds(), false);
      return;
    } catch (RuntimeException unexpected) {
      commitOutcome(target, "REMOVAL_UNKNOWN", null, true);
      return;
    }
    commitRemoval(target);
  }

  /**
   * Atomic lease claim under a row lock: due queued work plus expired-lease in-progress work
   * (crashed recovery). Returns null when another holder owns the live lease.
   */
  private RevocationTarget claim(UUID workId) {
    return transactions.execute(
        status -> {
          ConnectionRevocationWorkEntity work = revocations.findByIdForUpdate(workId).orElse(null);
          if (work == null) {
            return null;
          }
          Instant now = now();
          boolean queuedDue =
              "QUEUED".equals(work.getState()) && !work.getNextRetryAt().isAfter(now);
          boolean leaseExpired =
              "IN_PROGRESS".equals(work.getState())
                  && (work.getLeaseExpiresAt() == null || !work.getLeaseExpiresAt().isAfter(now))
                  && !work.getNextRetryAt().isAfter(now);
          if (!queuedDue && !leaseExpired) {
            return null;
          }
          FinancialConnectionEntity connection =
              connections.findByIdForUpdate(work.getConnectionId()).orElse(null);
          if (connection == null) {
            work.fail("CONNECTION_GONE", now);
            return null;
          }
          if ("DISCONNECTED".equals(connection.getState())) {
            work.complete(now);
            return null;
          }
          String credential = null;
          if (connection.getEncryptedCredential() != null) {
            try {
              credential =
                  crypto.decrypt(
                      connection.getEncryptedCredential(), credentialScope(connection.getId()));
            } catch (ConnectionCrypto.CredentialCryptoException failed) {
              work.fail("CREDENTIAL_UNAVAILABLE", now);
              return null;
            }
          }
          work.claim(workerOwnerId, now.plus(LEASE_DURATION), now);
          revocations.saveAndFlush(work);
          return new RevocationTarget(
              work.getId(),
              connection.getId(),
              credential,
              work.getLeaseOwner(),
              work.getLeaseFence(),
              work.getAttemptCount());
        });
  }

  /** A commit is valid only while this holder still owns the lease fence. */
  private static boolean leaseMatches(
      ConnectionRevocationWorkEntity work, RevocationTarget target) {
    return "IN_PROGRESS".equals(work.getState())
        && target.leaseOwner().equals(work.getLeaseOwner())
        && work.getLeaseFence() == target.leaseFence();
  }

  private void commitOutcome(
      RevocationTarget target, String error, Long retryAfterSeconds, boolean unknownOutcome) {
    transactions.execute(
        status -> {
          ConnectionRevocationWorkEntity work =
              revocations.findByIdForUpdate(target.workId()).orElse(null);
          if (work == null || !leaseMatches(work, target)) {
            // Superseded by a reclaim: the current holder owns the outcome.
            return null;
          }
          Instant now = now();
          if (unknownOutcome) {
            // Ambiguous outcomes share the bounded budget: after six total attempts the
            // work fails visibly while retaining the credential for explicit owner retry.
            if (!retryPolicy.mayRetry(work.getAttemptCount())) {
              work.fail(error, now);
              return null;
            }
            work.retryLater(
                error,
                now.plus(retryPolicy.nextDelay(work.getAttemptCount(), retryAfterSeconds)),
                now);
            markDisconnectOperationsUnknown(target.connectionId(), now);
            return null;
          }
          if (!retryPolicy.mayRetry(work.getAttemptCount())) {
            work.fail(error, now);
            return null;
          }
          work.retryLater(
              error,
              now.plus(retryPolicy.nextDelay(work.getAttemptCount(), retryAfterSeconds)),
              now);
          return null;
        });
  }

  private void commitRemoval(RevocationTarget target) {
    transactions.execute(
        status -> {
          ConnectionRevocationWorkEntity work =
              revocations.findByIdForUpdate(target.workId()).orElse(null);
          if (work == null || !leaseMatches(work, target)) {
            return null;
          }
          FinancialConnectionEntity connection =
              connections.findByIdForUpdate(target.connectionId()).orElse(null);
          if (connection == null) {
            work.fail("CONNECTION_GONE", now());
            return null;
          }
          Instant now = now();
          if (!"DISCONNECTED".equals(connection.getState())) {
            if (connection.getVersion() == Integer.MAX_VALUE) {
              work.fail("VERSION_EXHAUSTED", now);
              return null;
            }
            connection.confirmRemoteRemoval(now);
          }
          work.complete(now);
          succeedDisconnectOperations(connection.getId(), now);
          return null;
        });
  }

  /**
   * A confirmed removal resolves every matching DISCONNECT operation, including ones that recorded
   * an ambiguous outcome while the remote result was unknown, so UI polling always converges on the
   * final success.
   */
  private void succeedDisconnectOperations(UUID connectionId, Instant now) {
    for (ConnectionOperationEntity operation :
        operations.findByConnectionIdAndOperationTypeAndStateIn(
            connectionId, "DISCONNECT", List.of("PENDING", "OUTCOME_UNKNOWN"))) {
      operation.finish("SUCCEEDED", null, now);
    }
  }

  private void markDisconnectOperationsUnknown(UUID connectionId, Instant now) {
    for (ConnectionOperationEntity operation :
        operations.findByConnectionIdAndOperationTypeAndState(
            connectionId, "DISCONNECT", "PENDING")) {
      operation.finish("OUTCOME_UNKNOWN", "REMOVAL_UNKNOWN", now);
    }
  }

  /**
   * Queues revocation unless live work exists. Terminal FAILED work is requeued with a fresh
   * attempt budget on explicit owner retry, so a failed cleanup never sticks forever while its
   * credential is retained.
   */
  private void queueRevocationIfAbsent(UUID connectionId, Instant now) {
    boolean open = false;
    for (ConnectionRevocationWorkEntity work : revocations.findByConnectionId(connectionId)) {
      if ("QUEUED".equals(work.getState()) || "IN_PROGRESS".equals(work.getState())) {
        open = true;
      } else if ("FAILED".equals(work.getState())) {
        work.requeue(now);
        open = true;
      }
    }
    if (!open) {
      revocations.save(new ConnectionRevocationWorkEntity(UUID.randomUUID(), connectionId, now));
      revocations.flush();
    }
  }

  private static void requireReconnectEligible(FinancialConnectionEntity connection) {
    switch (connection.getState()) {
      case "ACTIVE", "REAUTH_REQUIRED" -> {
        // Eligible for update mode.
      }
      case "SUSPENDED", "DISCONNECTING", "DISCONNECTED" ->
          throw new ConnectionDisconnectedException();
      default -> throw new ConnectionNotReadyException();
    }
  }

  private static RuntimeException mapReconnectFailure(PlaidAdapterException failed) {
    return switch (failed.getErrorClass()) {
      case TRANSIENT, RATE_LIMITED, NOT_READY -> new ProviderTransientException();
      default -> new ConnectionNotReadyException();
    };
  }

  private static Instant earliest(Instant first, Instant second) {
    if (first == null) return second;
    if (second == null) return first;
    return first.isBefore(second) ? first : second;
  }

  private record Reservation(UUID attemptId, boolean replay) {}

  public record ReconnectResult(UUID attemptId, boolean replayed) {}

  public record ReconnectView(String linkToken, Instant expiresAt) {}

  private record RevocationTarget(
      UUID workId,
      UUID connectionId,
      String credential,
      String leaseOwner,
      long leaseFence,
      int attempts) {}
}
