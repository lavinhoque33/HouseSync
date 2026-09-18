package com.housesync.finance.connection.application;

import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionConflictException;
import com.housesync.finance.activity.domain.ObservationNormalizer;
import com.housesync.finance.activity.persistence.ConnectionObservationEntity;
import com.housesync.finance.activity.persistence.ConnectionObservationRepository;
import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingEntity;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationEntity;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkEntity;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundDeltaEntity;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundDeltaRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundEntity;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncWorkEntity;
import com.housesync.finance.connection.persistence.ConnectionSyncWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapterException;
import com.housesync.finance.connection.plaid.ProviderErrorClass;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionDisconnectedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotReadyException;
import com.housesync.finance.connection.web.ConnectionExceptions.ManualSyncRateLimitedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ProviderTransientException;
import com.housesync.household.application.HouseholdService;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Durable fenced transaction sync (connected-finance contract §5).
 *
 * <p>Demand is a monotonic sequence so wake-ups are never lost while a round runs. A worker claims
 * a database lease with an increasing fence, fetches pages outside long-held domain locks, stages
 * every page in a fenced round, and only the final page atomically applies staged observations and
 * advances the committed Item-wide cursor after rechecking generation, lease fence, membership and
 * selected-account eligibility. A crash, a superseded worker, an over-limit round, or a pagination
 * restart leaves the original committed cursor untouched; partially staged pages never become
 * visible activity. No provider call ever happens inside a domain write transaction.
 */
@Service
public class ConnectionSyncService extends ConnectedFinanceBase {

  private static final Duration LEASE_DURATION = Duration.ofMinutes(2);
  private static final long MANUAL_INTERVAL_SECONDS = 60;
  private static final Duration STAGED_TTL = Duration.ofHours(24);
  private static final Duration STALE_SWEEP_AGE = Duration.ofHours(6);

  private final ConnectionSyncWorkRepository work;
  private final ConnectionSyncRoundRepository rounds;
  private final ConnectionSyncRoundDeltaRepository deltas;
  private final ConnectionObservationRepository observations;
  private final ConnectionSyncDemandRegistrar demands;
  private final RevocationRetryPolicy retryPolicy;
  private final ConnectionLinkAttemptRepository attempts;
  private final String workerOwnerId;

  private final Semaphore globalPermits = new Semaphore(2);
  private final Set<UUID> inFlightConnections = ConcurrentHashMap.newKeySet();

  @Autowired
  public ConnectionSyncService(
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
      ConnectionSyncWorkRepository work,
      ConnectionSyncRoundRepository rounds,
      ConnectionSyncRoundDeltaRepository deltas,
      ConnectionObservationRepository observations,
      ConnectionSyncDemandRegistrar demands,
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
        work,
        rounds,
        deltas,
        observations,
        demands,
        retryPolicy,
        "sync-" + UUID.randomUUID());
  }

  /** Test-only worker identity so fence/supersession behavior can be proven deterministically. */
  public ConnectionSyncService(
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
      ConnectionSyncWorkRepository work,
      ConnectionSyncRoundRepository rounds,
      ConnectionSyncRoundDeltaRepository deltas,
      ConnectionObservationRepository observations,
      ConnectionSyncDemandRegistrar demands,
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
    this.work = work;
    this.rounds = rounds;
    this.deltas = deltas;
    this.observations = observations;
    this.demands = demands;
    this.retryPolicy = retryPolicy;
    this.attempts = attempts;
    this.workerOwnerId = workerOwnerId;
  }

  /**
   * Owner-requested manual sync: a durable SYNC operation behind a coalesced demand. The
   * per-connection 60-second interval returns a safe rate limit; a replay returns the persisted
   * operation without reapplying the interval.
   */
  public ManualSyncResult requestManual(
      UUID householdId, UUID connectionId, UUID actorId, UUID idempotencyKey, int expectedVersion) {
    requireEnabled();
    String fingerprint = fingerprint("SYNC\0" + connectionId + "\0" + expectedVersion);
    return transactions.execute(
        status -> {
          lockFinance(householdId, actorId);
          var replayed = replay(actorId, householdId, "SYNC", idempotencyKey, fingerprint);
          if (replayed != null) {
            // Authorization (household lock plus owner-scoped replay lookup) ran first; the
            // persisted operation is returned without re-running rate limiting.
            return new ManualSyncResult(replayed.getResourceId(), true);
          }
          FinancialConnectionEntity connection =
              lockOwnedConnection(householdId, connectionId, actorId);
          if (connection.getVersion() != expectedVersion) {
            throw new ResourceVersionConflictException();
          }
          switch (connection.getState()) {
            case "ACTIVE" -> {
              // Eligible.
            }
            case "SUSPENDED", "DISCONNECTING", "DISCONNECTED" ->
                throw new ConnectionDisconnectedException();
            default -> throw new ConnectionNotReadyException();
          }
          Instant now = now();
          ConnectionSyncWorkEntity workEntity =
              work.findByConnectionIdForUpdate(connectionId).orElse(null);
          if (workEntity == null) {
            demands.demand(connectionId, now);
            workEntity =
                work.findByConnectionIdForUpdate(connectionId)
                    .orElseThrow(
                        () -> new IllegalStateException("sync work row missing after demand"));
          } else {
            Instant lastManual = workEntity.getLastManualSyncAt();
            if (lastManual != null
                && lastManual.plusSeconds(MANUAL_INTERVAL_SECONDS).isAfter(now)) {
              throw new ManualSyncRateLimitedException();
            }
            workEntity.resetFailure(now);
            workEntity.demand(now);
          }
          workEntity.markManualSync(now);
          UUID operationId = UUID.randomUUID();
          operations.save(
              new ConnectionOperationEntity(
                  operationId, householdId, actorId, connectionId, null, "SYNC", now));
          try {
            reserve(actorId, householdId, "SYNC", idempotencyKey, fingerprint, operationId, now);
          } catch (DataIntegrityViolationException concurrent) {
            throw new ProviderTransientException();
          }
          operations.flush();
          return new ManualSyncResult(operationId, false);
        });
  }

  /** Scheduled worker sweep with a two-per-process global bound and one round per connection. */
  @Scheduled(fixedDelayString = "${app.connected-finance.sync-poll-ms:5000}")
  public void processDueSyncs() {
    if (!properties.isEnabled()) {
      return;
    }
    Instant now = now();
    for (ConnectionSyncWorkEntity due : work.findDue(now, PageRequest.of(0, 4))) {
      if (!inFlightConnections.add(due.getConnectionId())) {
        continue;
      }
      if (!globalPermits.tryAcquire()) {
        inFlightConnections.remove(due.getConnectionId());
        return;
      }
      try {
        processOne(due.getId());
      } finally {
        inFlightConnections.remove(due.getConnectionId());
        globalPermits.release();
      }
    }
  }

  /** Runs exactly one claimable round for the given work row; safe to call from tests/operators. */
  public void processOne(UUID workId) {
    if (!properties.isEnabled()) {
      return;
    }
    Claim claim = null;
    try {
      claim = claim(workId);
      if (claim == null) {
        return;
      }
      runRound(claim);
    } catch (RuntimeException unexpected) {
      Claim failedClaim = claim;
      if (failedClaim == null) {
        // The failure happened before this worker owned a lease (or inside the claim transaction,
        // which rolled back); there is no authoritative side effect to record.
        return;
      }
      transactions.execute(
          status -> {
            // Side effects are valid only while this exact lease owner and fence are current; a
            // superseded worker never marks the connection or operations failed.
            LockedWork locked = lockWorkOrdered(workId);
            if (locked == null
                || !locked.work().leaseHeldBy(workerOwnerId, failedClaim.fence(), now())) {
              return null;
            }
            Instant now = now();
            locked.work().fail("UNEXPECTED", now);
            if (locked.connection() != null) {
              locked.connection().markSyncState("FAILED", now);
            }
            failSyncOperations(locked.work().getConnectionId(), "UNEXPECTED", now);
            return null;
          });
    }
  }

  /** Periodic missed-webhook sweep; reads cached provider changes, never the refresh endpoint. */
  @Scheduled(fixedDelayString = "${app.connected-finance.sync-sweep-ms:3600000}")
  public void sweepStaleConnections() {
    if (!properties.isEnabled()) {
      return;
    }
    transactions.execute(
        status -> {
          Instant now = now();
          for (ConnectionSyncWorkEntity stale :
              work.findStaleIdle(now.minus(STALE_SWEEP_AGE), PageRequest.of(0, 25))) {
            demands.demand(stale.getConnectionId(), now);
          }
          return null;
        });
  }

  /**
   * Staged round data expires 24 hours after completion or abandonment. A crashed worker can leave
   * a STAGING round behind while its connection is inactive; the scrubber abandons and removes it
   * so orphaned staged pages never accumulate.
   */
  @Scheduled(fixedDelayString = "${app.connected-finance.sync-scrub-ms:600000}")
  public void scrubExpiredSyncData() {
    if (!properties.isEnabled()) {
      return;
    }
    transactions.execute(
        status -> {
          Instant now = now();
          for (ConnectionSyncRoundEntity round :
              rounds.findScrubbable(now.minus(STAGED_TTL), PageRequest.of(0, 50))) {
            if ("STAGING".equals(round.getState())) {
              round.abandon("LEASE_EXPIRED", now);
            }
            rounds.delete(round);
          }
          return null;
        });
  }

  private Claim claim(UUID workId) {
    return transactions.execute(
        status -> {
          // Lock order: connection, then its connection-scoped work row.
          LockedWork locked = lockWorkOrdered(workId);
          if (locked == null) {
            return null;
          }
          ConnectionSyncWorkEntity workEntity = locked.work();
          FinancialConnectionEntity connection = locked.connection();
          Instant now = now();
          boolean queuedDue =
              "QUEUED".equals(workEntity.getState())
                  && (workEntity.getNextRetryAt() == null
                      || !workEntity.getNextRetryAt().isAfter(now));
          boolean retryDue =
              "RETRY_WAIT".equals(workEntity.getState())
                  && (workEntity.getNextRetryAt() == null
                      || !workEntity.getNextRetryAt().isAfter(now));
          boolean crashedLease =
              "RUNNING".equals(workEntity.getState())
                  && (workEntity.getLeaseExpiresAt() == null
                      || !workEntity.getLeaseExpiresAt().isAfter(now));
          if (!queuedDue && !retryDue && !crashedLease) {
            return null;
          }
          if (connection == null) {
            workEntity.fail("CONNECTION_GONE", now);
            return null;
          }
          boolean reconnectInFlight =
              !attempts
                  .findByConnectionIdAndStateIn(
                      connection.getId(), List.of("LINK_TOKEN_ISSUED", "EXCHANGING"))
                  .isEmpty();
          if (!"ACTIVE".equals(connection.getState()) || reconnectInFlight) {
            // Fetch is suspended while the connection is inactive or a reconnect is in flight. A
            // reconnect keeps a manual request pending (its completion re-demands); an inactive
            // connection fails the pending operation instead of leaving it pending forever.
            workEntity.succeed(workEntity.getDemandSequence(), false, now);
            connection.markSyncState("IDLE", now);
            if (!"ACTIVE".equals(connection.getState())) {
              failSyncOperations(connection.getId(), inactiveSyncError(connection.getState()), now);
            }
            return null;
          }
          if (connection.getEncryptedCredential() == null) {
            workEntity.fail("CREDENTIAL_UNAVAILABLE", now);
            return null;
          }
          String credential;
          try {
            credential =
                crypto.decrypt(
                    connection.getEncryptedCredential(), credentialScope(connection.getId()));
          } catch (ConnectionCrypto.CredentialCryptoException failed) {
            workEntity.fail("CREDENTIAL_UNAVAILABLE", now);
            return null;
          }
          long fence = workEntity.claim(workerOwnerId, now.plus(LEASE_DURATION), now);
          connection.markSyncState("RUNNING", now);
          return new Claim(
              workEntity.getId(),
              connection.getId(),
              connection.getProvider(),
              connection.getEnvironment(),
              connection.getGeneration(),
              fence,
              workEntity.getDemandSequence(),
              connection.getCursor(),
              credential);
        });
  }

  /**
   * Consistent worker lock order: connection row first, then the connection-scoped work row. Every
   * browser, link, selection, and webhook path locks the same connection before touching work, so
   * no path can deadlock against a worker. The probe is an id-only projection so no stale work
   * entity can be hydrated before the lock; the locked read then hydrates the current row.
   */
  private LockedWork lockWorkOrdered(UUID workId) {
    UUID connectionId = work.findConnectionIdById(workId).orElse(null);
    if (connectionId == null) {
      return null;
    }
    FinancialConnectionEntity connection = connections.findByIdForUpdate(connectionId).orElse(null);
    ConnectionSyncWorkEntity locked = work.findByIdForUpdate(workId).orElse(null);
    if (locked == null) {
      return null;
    }
    return new LockedWork(locked, connection);
  }

  private static String inactiveSyncError(String connectionState) {
    return switch (connectionState) {
      case "REAUTH_REQUIRED" -> "REAUTH_REQUIRED";
      case "SUSPENDED", "DISCONNECTING", "DISCONNECTED" -> "CONNECTION_DISCONNECTED";
      default -> "CONNECTION_NOT_READY";
    };
  }

  private void runRound(Claim claim) {
    UUID roundId = createRound(claim);
    if (roundId == null) {
      return;
    }
    String cursor = claim.cursor();
    int deltaCount = 0;
    long byteCount = 0;
    try {
      while (true) {
        PlaidAdapter.SyncPage page = adapter.fetchTransactionChanges(claim.credential(), cursor);
        if (!stagePage(claim, roundId, page, deltaCount)) {
          abandonRound(claim, roundId, "LEASE_LOST", false);
          return;
        }
        deltaCount += page.upserts().size() + page.removedRemoteTransactionIds().size();
        byteCount += estimateBytes(page);
        if (deltaCount > properties.getSyncMaxRoundDeltas()
            || byteCount > properties.getSyncMaxRoundBytes()) {
          capacityFailure(claim, roundId);
          return;
        }
        if (!page.hasMore()) {
          commitRound(claim, roundId, page.nextCursor());
          return;
        }
        cursor = page.nextCursor();
      }
    } catch (PlaidAdapterException failed) {
      handleProviderFailure(claim, roundId, failed);
    } catch (RuntimeException unexpected) {
      abandonRound(claim, roundId, "UNEXPECTED", true);
    }
  }

  private UUID createRound(Claim claim) {
    return transactions.execute(
        status -> {
          LockedWork locked = lockWorkOrdered(claim.workId());
          if (locked == null || !locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now())) {
            return null;
          }
          ConnectionSyncRoundEntity round =
              new ConnectionSyncRoundEntity(
                  UUID.randomUUID(),
                  claim.connectionId(),
                  claim.generation(),
                  claim.fence(),
                  claim.cursor(),
                  now());
          rounds.saveAndFlush(round);
          return round.getId();
        });
  }

  /**
   * Stages one fetched page under the current lease. Staged deltas are invisible until commit; a
   * superseded worker cannot stage or commit anything.
   */
  private boolean stagePage(Claim claim, UUID roundId, PlaidAdapter.SyncPage page, int baseCount) {
    Boolean staged =
        transactions.execute(
            status -> {
              LockedWork locked = lockWorkOrdered(claim.workId());
              if (locked == null
                  || !locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now())) {
                return false;
              }
              ConnectionSyncRoundEntity round = rounds.findByIdForUpdate(roundId).orElse(null);
              if (round == null || !"STAGING".equals(round.getState())) {
                return false;
              }
              ObservationNormalizer.Scope scope =
                  new ObservationNormalizer.Scope(claim.provider(), claim.environment());
              List<ConnectionSyncRoundDeltaEntity> rows = new ArrayList<>();
              int sequence = baseCount;
              for (PlaidAdapter.ProviderTransaction transaction : page.upserts()) {
                ObservationNormalizer.Normalized normalized =
                    ObservationNormalizer.normalize(scope, transaction);
                rows.add(
                    new ConnectionSyncRoundDeltaEntity(
                        roundId,
                        ++sequence,
                        normalized.remoteTransactionDigest(),
                        normalized.remoteAccountDigest(),
                        false,
                        transaction.pending(),
                        normalized.providerRevision(),
                        normalized.amount(),
                        normalized.currency(),
                        normalized.occurredOn(),
                        normalized.authorizedOn(),
                        normalized.description(),
                        normalized.descriptionValid(),
                        normalized.pendingPredecessorDigest(),
                        normalized.invalidReason()));
              }
              for (String removedId : page.removedRemoteTransactionIds()) {
                rows.add(
                    new ConnectionSyncRoundDeltaEntity(
                        roundId,
                        ++sequence,
                        ObservationNormalizer.digest(scope, removedId),
                        null,
                        true,
                        false,
                        null,
                        null,
                        null,
                        null,
                        null,
                        null,
                        false,
                        null,
                        null));
              }
              deltas.saveAll(rows);
              deltas.flush();
              round.stagePage(
                  page.nextCursor(),
                  page.hasMore(),
                  rows.size(),
                  estimateBytes(page),
                  page.historyReady(),
                  now());
              return true;
            });
    return Boolean.TRUE.equals(staged);
  }

  /**
   * Final-page commit: staged observations, ledger-relevant review changes, cursor, success
   * timestamp, readiness, work completion, and SYNC operations all move in one transaction after
   * rechecking the lease fence, generation, membership, and selected-account eligibility.
   */
  private void commitRound(Claim claim, UUID roundId, String finalCursor) {
    transactions.execute(
        status -> {
          // Lock order: connection, then work, then the connection-scoped round.
          LockedWork locked = lockWorkOrdered(claim.workId());
          if (locked == null) {
            return null;
          }
          ConnectionSyncWorkEntity workEntity = locked.work();
          ConnectionSyncRoundEntity round = rounds.findByIdForUpdate(roundId).orElse(null);
          FinancialConnectionEntity connection = locked.connection();
          Instant now = now();
          if (round == null || !"STAGING".equals(round.getState())) {
            abandon(round, "SUPERSEDED", now);
            return null;
          }
          if (!workEntity.leaseHeldBy(workerOwnerId, claim.fence(), now())) {
            abandon(round, "LEASE_LOST", now);
            return null;
          }
          if (connection == null) {
            abandon(round, "CONNECTION_GONE", now);
            workEntity.fail("CONNECTION_GONE", now);
            return null;
          }
          if (connection.getGeneration() != round.getGeneration()) {
            abandon(round, "GENERATION_SUPERSEDED", now);
            workEntity.releaseLease(now);
            return null;
          }
          if (!households
              .currentMemberUserIds(connection.getHouseholdId())
              .contains(connection.getOwnerUserId())) {
            abandon(round, "MEMBERSHIP_LOST", now);
            workEntity.fail("MEMBERSHIP_LOST", now);
            connection.markSyncState("FAILED", now);
            failSyncOperations(connection.getId(), "MEMBERSHIP_LOST", now);
            return null;
          }
          List<ConnectionSyncRoundDeltaEntity> staged =
              deltas.findByRoundIdOrderBySequenceAsc(roundId);
          Map<String, ConnectionAccountMappingEntity> byDigest = new HashMap<>();
          List<ConnectionAccountMappingEntity> owned =
              mappings.findByConnectionForUpdate(connection.getId());
          for (ConnectionAccountMappingEntity mapping : owned) {
            byDigest.put(mapping.getRemoteAccountDigest(), mapping);
          }
          for (ConnectionSyncRoundDeltaEntity delta : staged) {
            applyDelta(connection, delta, byDigest, now);
          }
          for (ConnectionAccountMappingEntity mapping : owned) {
            if (mapping.isSelected()
                && mapping.getLocalAccountId() != null
                && !mapping.isHistoryImported()) {
              mapping.markHistoryImported(now);
            }
          }
          connection.commitSync(finalCursor, round.isHistoryReady(), now);
          boolean demandPending = workEntity.getDemandSequence() > claim.claimedSequence();
          round.apply(now);
          deltas.deleteByRoundId(roundId);
          workEntity.succeed(claim.claimedSequence(), demandPending, now);
          succeedSyncOperations(connection.getId(), now);
          return null;
        });
  }

  /**
   * Applies one staged delta. Unmapped provider account payloads are deliberately dropped after
   * consuming the Item cursor, and unselected eligible mappings retain nothing. A conflicting
   * mapping identity is never silently dropped: the observation is durably quarantined with an
   * IDENTITY_CONFLICT reason and stays owner-visible without touching the admitted account or
   * currency identity. Removed deltas leave one retained tombstone and an exact replay neither
   * bumps the version nor rewrites state.
   */
  private void applyDelta(
      FinancialConnectionEntity connection,
      ConnectionSyncRoundDeltaEntity delta,
      Map<String, ConnectionAccountMappingEntity> byDigest,
      Instant now) {
    if (delta.isRemoved()) {
      ConnectionObservationEntity existing =
          observations
              .findDigestForUpdate(connection.getId(), delta.getRemoteTransactionDigest())
              .orElse(null);
      if (existing == null) {
        observations.save(
            ConnectionObservationEntity.tombstone(
                UUID.randomUUID(),
                connection.getId(),
                connection.getHouseholdId(),
                connection.getOwnerUserId(),
                delta.getRemoteTransactionDigest(),
                now));
      } else if (!"REMOVED".equals(existing.getState())) {
        existing.removed(now);
      }
      return;
    }
    ConnectionAccountMappingEntity mapping =
        delta.getRemoteAccountDigest() == null
            ? null
            : byDigest.get(delta.getRemoteAccountDigest());
    if (mapping == null) {
      return;
    }
    boolean admitted = mapping.getLocalAccountId() != null;
    if (!mapping.isEligible()) {
      if (!admitted) {
        // A never-admitted ineligible mapping retains nothing, valid or invalid; the delta is
        // consumed only to advance the Item cursor.
        return;
      }
      // Durable identity conflict: an existing admitted local account's immutable kind or currency
      // now conflicts with provider metadata. Record owner-visible evidence without touching the
      // admitted account or currency identity.
      quarantineObservation(
          connection, mapping, delta, findDigest(connection, delta), "IDENTITY_CONFLICT", now);
      return;
    }
    if (!mapping.isSelected() || !admitted) {
      // Unselected or never-admitted eligible payloads are consumed only to advance the Item
      // cursor; no observation is retained, even when provider facts are invalid.
      return;
    }
    ConnectionObservationEntity existing = findDigest(connection, delta);
    if (delta.getInvalidReason() != null) {
      quarantineObservation(connection, mapping, delta, existing, delta.getInvalidReason(), now);
      return;
    }
    if (existing == null) {
      observations.save(
          new ConnectionObservationEntity(
              UUID.randomUUID(),
              connection.getId(),
              connection.getHouseholdId(),
              connection.getOwnerUserId(),
              mapping.getId(),
              delta.getRemoteTransactionDigest(),
              delta.getState(),
              delta.getProviderRevision(),
              delta.getAmount(),
              delta.getCurrency(),
              delta.getOccurredOn(),
              delta.getAuthorizedOn(),
              delta.getDescription(),
              delta.isDescriptionValid(),
              delta.getPendingPredecessorDigest(),
              now));
    } else {
      boolean materialChange =
          !Objects.equals(existing.getProviderRevision(), delta.getProviderRevision())
              || !existing.getState().equals(delta.getState());
      existing.revise(
          mapping.getId(),
          delta.getState(),
          delta.getProviderRevision(),
          delta.getAmount(),
          delta.getCurrency(),
          delta.getOccurredOn(),
          delta.getAuthorizedOn(),
          delta.getDescription(),
          delta.isDescriptionValid(),
          delta.getPendingPredecessorDigest(),
          materialChange,
          now);
    }
    // Explicit pending predecessor only: no heuristic matching when the provider omits it.
    if (delta.getPendingPredecessorDigest() != null) {
      observations
          .findDigestForUpdate(connection.getId(), delta.getPendingPredecessorDigest())
          .filter(predecessor -> "PENDING".equals(predecessor.getState()))
          .ifPresent(predecessor -> predecessor.removed(now));
    }
  }

  /**
   * Records one durable quarantine/flag for an observation that cannot be applied: a new INVALID
   * row, a coalesced review flag on an admitted row, or a quarantine of an existing unadmitted row.
   */
  private void quarantineObservation(
      FinancialConnectionEntity connection,
      ConnectionAccountMappingEntity mapping,
      ConnectionSyncRoundDeltaEntity delta,
      ConnectionObservationEntity existing,
      String reason,
      Instant now) {
    if (existing == null) {
      ConnectionObservationEntity observation =
          new ConnectionObservationEntity(
              UUID.randomUUID(),
              connection.getId(),
              connection.getHouseholdId(),
              connection.getOwnerUserId(),
              mapping.getId(),
              delta.getRemoteTransactionDigest(),
              "INVALID",
              delta.getProviderRevision(),
              delta.getAmount(),
              delta.getCurrency(),
              delta.getOccurredOn(),
              delta.getAuthorizedOn(),
              delta.getDescription(),
              delta.isDescriptionValid(),
              delta.getPendingPredecessorDigest(),
              now);
      observation.quarantine(reason, now);
      observations.save(observation);
    } else if ("CONFIRMED".equals(existing.getReviewState())) {
      // Retain the admitted facts and flag one review item instead of overwriting ledger meaning.
      existing.flagModified(now);
    } else {
      existing.quarantine(reason, now);
    }
  }

  private ConnectionObservationEntity findDigest(
      FinancialConnectionEntity connection, ConnectionSyncRoundDeltaEntity delta) {
    return observations
        .findDigestForUpdate(connection.getId(), delta.getRemoteTransactionDigest())
        .orElse(null);
  }

  private void handleProviderFailure(Claim claim, UUID roundId, PlaidAdapterException failed) {
    ProviderErrorClass errorClass = failed.getErrorClass();
    switch (errorClass) {
      case PAGINATION_RESTART -> {
        // Discard the unfinished round and restart from the original committed cursor.
        abandonRound(claim, roundId, "PAGINATION_RESTART", false);
        scheduleRetry(claim, "PAGINATION_RESTART", null);
      }
      case NOT_READY -> {
        abandonRound(claim, roundId, "NOT_READY", false);
        scheduleRetry(claim, "NOT_READY", null);
      }
      case TRANSIENT, RATE_LIMITED -> {
        abandonRound(claim, roundId, errorClass.name(), false);
        scheduleRetry(claim, errorClass.name(), failed.getRetryAfterSeconds());
      }
      case REAUTH_REQUIRED -> {
        abandonRound(claim, roundId, "REAUTH_REQUIRED", false);
        transactions.execute(
            status -> {
              LockedWork locked = lockWorkOrdered(claim.workId());
              if (locked == null
                  || !locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now())) {
                return null;
              }
              Instant now = now();
              FinancialConnectionEntity connection = locked.connection();
              if (connection != null && "ACTIVE".equals(connection.getState())) {
                connection.fence("REAUTH_REQUIRED", now);
              }
              locked.work().fail("REAUTH_REQUIRED", now);
              failSyncOperations(claim.connectionId(), "REAUTH_REQUIRED", now);
              return null;
            });
      }
      case CONSENT_REVOKED, PERMANENT -> {
        abandonRound(claim, roundId, errorClass.name(), false);
        transactions.execute(
            status -> {
              LockedWork locked = lockWorkOrdered(claim.workId());
              if (locked == null
                  || !locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now())) {
                return null;
              }
              Instant now = now();
              FinancialConnectionEntity connection = locked.connection();
              if (connection != null && !"DISCONNECTED".equals(connection.getState())) {
                connection.fence("SUSPENDED", now);
                queueRevocation(connection.getId(), now);
              }
              locked.work().fail(errorClass.name(), now);
              failSyncOperations(claim.connectionId(), errorClass.name(), now);
              return null;
            });
      }
      case INVALID_DATA -> {
        abandonRound(claim, roundId, "INVALID_DATA", false);
        transactions.execute(
            status -> {
              LockedWork locked = lockWorkOrdered(claim.workId());
              if (locked == null
                  || !locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now())) {
                return null;
              }
              Instant now = now();
              locked.work().fail("INVALID_DATA", now);
              if (locked.connection() != null) {
                locked.connection().markSyncState("FAILED", now);
              }
              failSyncOperations(claim.connectionId(), "INVALID_DATA", now);
              return null;
            });
      }
    }
  }

  private void scheduleRetry(Claim claim, String error, Long retryAfterSeconds) {
    transactions.execute(
        status -> {
          LockedWork locked = lockWorkOrdered(claim.workId());
          if (locked == null || !locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now())) {
            return null;
          }
          Instant now = now();
          if (!retryPolicy.mayRetry(locked.work().getAttemptCount())) {
            locked.work().fail(error, now);
            if (locked.connection() != null) {
              locked.connection().markSyncState("FAILED", now);
            }
            failSyncOperations(claim.connectionId(), error, now);
          } else {
            locked
                .work()
                .retryLater(
                    error,
                    now.plus(
                        retryPolicy.nextDelay(locked.work().getAttemptCount(), retryAfterSeconds)),
                    now);
            if (locked.connection() != null) {
              locked.connection().markSyncState("RETRY_WAIT", now);
            }
          }
          return null;
        });
  }

  /** Over-limit rounds preserve the original cursor and surface a resumable capacity failure. */
  private void capacityFailure(Claim claim, UUID roundId) {
    transactions.execute(
        status -> {
          LockedWork locked = lockWorkOrdered(claim.workId());
          ConnectionSyncRoundEntity round = rounds.findByIdForUpdate(roundId).orElse(null);
          Instant now = now();
          abandon(round, "ROUND_LIMIT", now);
          deltas.deleteByRoundId(roundId);
          if (locked != null && locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now)) {
            locked.work().fail("ROUND_LIMIT", now);
            if (locked.connection() != null) {
              locked.connection().markSyncState("FAILED", now);
            }
            failSyncOperations(claim.connectionId(), "ROUND_LIMIT", now);
          }
          return null;
        });
  }

  /**
   * Abandons this worker's own round. Visible work/connection/operation side effects happen only
   * while this exact lease owner and fence are current: a superseded worker cleans up its staged
   * rows but can never fail the reclaiming worker's connection or pending operations.
   */
  private void abandonRound(Claim claim, UUID roundId, String failureCode, boolean visibleFailure) {
    transactions.execute(
        status -> {
          // Lock order: connection, then work, then the round this worker owns.
          LockedWork locked = lockWorkOrdered(claim.workId());
          ConnectionSyncRoundEntity round = rounds.findByIdForUpdate(roundId).orElse(null);
          Instant now = now();
          abandon(round, failureCode, now);
          deltas.deleteByRoundId(roundId);
          if (visibleFailure
              && locked != null
              && locked.work().leaseHeldBy(workerOwnerId, claim.fence(), now)) {
            locked.work().fail(failureCode, now);
            if (locked.connection() != null) {
              locked.connection().markSyncState("FAILED", now);
            }
            failSyncOperations(claim.connectionId(), failureCode, now);
          }
          return null;
        });
  }

  private static void abandon(ConnectionSyncRoundEntity round, String failureCode, Instant now) {
    if (round != null && "STAGING".equals(round.getState())) {
      round.abandon(failureCode, now);
    }
  }

  private void succeedSyncOperations(UUID connectionId, Instant now) {
    for (ConnectionOperationEntity operation :
        operations.findByConnectionIdAndOperationTypeAndState(connectionId, "SYNC", "PENDING")) {
      operation.finish("SUCCEEDED", null, now);
    }
  }

  private void failSyncOperations(UUID connectionId, String error, Instant now) {
    for (ConnectionOperationEntity operation :
        operations.findByConnectionIdAndOperationTypeAndState(connectionId, "SYNC", "PENDING")) {
      operation.finish("FAILED", error, now);
    }
  }

  private void queueRevocation(UUID connectionId, Instant now) {
    revocations.save(new ConnectionRevocationWorkEntity(UUID.randomUUID(), connectionId, now));
    revocations.flush();
  }

  /** Rough staged-byte accounting used only for the documented 50 MiB round bound. */
  private static long estimateBytes(PlaidAdapter.SyncPage page) {
    long bytes = 256L * (page.upserts().size() + page.removedRemoteTransactionIds().size());
    for (PlaidAdapter.ProviderTransaction transaction : page.upserts()) {
      bytes += transaction.description() == null ? 0 : transaction.description().length();
      bytes += transaction.merchantName() == null ? 0 : transaction.merchantName().length();
    }
    return bytes;
  }

  public record ManualSyncResult(UUID operationId, boolean replayed) {}

  /** A connection-locked work row and its locked connection, in the documented lock order. */
  private record LockedWork(ConnectionSyncWorkEntity work, FinancialConnectionEntity connection) {}

  private record Claim(
      UUID workId,
      UUID connectionId,
      String provider,
      String environment,
      long generation,
      long fence,
      long claimedSequence,
      String cursor,
      String credential) {}
}
