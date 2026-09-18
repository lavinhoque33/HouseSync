package com.housesync.finance.activity.application;

import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.normalize;
import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.violation;
import static com.housesync.finance.transaction.domain.TransactionMoneyPolicy.checkSign;
import static com.housesync.finance.transaction.domain.TransactionMoneyPolicy.toResponseString;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionExhaustedException;
import com.housesync.finance.activity.persistence.ConnectionLedgerAssociationEntity;
import com.housesync.finance.activity.persistence.ConnectionLedgerAssociationRepository;
import com.housesync.finance.activity.persistence.ConnectionObservationEntity;
import com.housesync.finance.activity.persistence.ConnectionObservationRepository;
import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingEntity;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyEntity;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyKey;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.web.ConnectionExceptions.BankActivityNotFoundException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectedFinanceDisabledException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionDisconnectedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionIdempotencyConflictException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotReadyException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationAdmittedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationAlreadyConfirmedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationDismissedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationInvalidException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationNotPostedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ReconciliationRequiredException;
import com.housesync.finance.transaction.application.FinancialTransactionService;
import com.housesync.finance.transaction.domain.AllocationStatus;
import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationRepository;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionResponse;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Owner-private bank-activity inbox plus one-time ledger admission and reconciliation.
 *
 * <p>Reads are owner-scoped: foreign, other-owner, former-member, and missing resources all produce
 * an indistinguishable 404. Confirmation derives account, money, currency, date, source, and
 * visibility from the current observation and rejects those client fields through strict
 * unknown-field handling. Admission is atomic with its ledger association; a second key cannot
 * admit the same observation, and a replay reauthorizes before returning the persisted outcome.
 * Dismissal applies to any unadmitted observation, including pending ones, and never touches the
 * ledger. Pending, invalid, removed, and unreviewed observations never contribute to reporting.
 *
 * <p>Resolution keeps the confirmed ledger untouched for KEEP_LEDGER, applies selected bank
 * facts through the existing ledger patch value path for APPLY_BANK, and voids through the same
 * path for VOID_LEDGER. Replacement atomically voids the old entry, admits the replacement from the
 * current posted observation, and moves the CURRENT association while retaining VOIDED history.
 * Resolve and replace work after disconnect from any connection state except LINKING; they never
 * change connection generation/state, restart sync, or admit unselected accounts.
 */
@Service
public class BankActivityService {

  private static final String CONFIRM_OPERATION = "BANK_ACTIVITY_CONFIRM";
  private static final String DISMISS_OPERATION = "BANK_ACTIVITY_DISMISS";
  private static final String RESOLVE_OPERATION = "BANK_ACTIVITY_RESOLVE";
  private static final String REPLACE_OPERATION = "BANK_ACTIVITY_REPLACE";
  private static final String PRIVATE_VISIBILITY = "PRIVATE";
  private static final Set<String> STATE_FILTERS =
      Set.of("PENDING", "POSTED", "REMOVED", "INVALID");
  private static final Set<String> REVIEW_FILTERS = Set.of("UNREVIEWED", "CONFIRMED", "DISMISSED");
  private static final Set<String> DISMISS_REASONS = Set.of("ALREADY_RECORDED", "NOT_NEEDED");
  private static final Set<String> RESOLVE_ACTIONS =
      Set.of("KEEP_LEDGER", "APPLY_BANK", "VOID_LEDGER");
  private static final Set<String> APPLY_FIELDS = Set.of("amount", "occurredOn", "description");

  private final ConnectedFinanceProperties properties;
  private final ConnectionObservationRepository observations;
  private final ConnectionLedgerAssociationRepository associations;
  private final ConnectionAccountMappingRepository mappings;
  private final FinancialConnectionRepository connections;
  private final ConnectionOperationIdempotencyRepository idempotency;
  private final FinancialTransactionService transactionService;
  private final FinancialTransactionRepository transactionRepo;
  private final FinancialTransactionAllocationRepository allocations;
  private final HouseholdService households;
  private final Clock clock;
  private final EntityManager entityManager;
  private final TransactionTemplate transactions;

  public BankActivityService(
      ConnectedFinanceProperties properties,
      ConnectionObservationRepository observations,
      ConnectionLedgerAssociationRepository associations,
      ConnectionAccountMappingRepository mappings,
      FinancialConnectionRepository connections,
      ConnectionOperationIdempotencyRepository idempotency,
      FinancialTransactionService transactionService,
      FinancialTransactionRepository transactionRepo,
      FinancialTransactionAllocationRepository allocations,
      HouseholdService households,
      Clock clock,
      EntityManager entityManager,
      PlatformTransactionManager transactionManager) {
    this.properties = properties;
    this.observations = observations;
    this.associations = associations;
    this.mappings = mappings;
    this.connections = connections;
    this.idempotency = idempotency;
    this.transactionService = transactionService;
    this.transactionRepo = transactionRepo;
    this.allocations = allocations;
    this.households = households;
    this.clock = clock;
    this.entityManager = entityManager;
    this.transactions = new TransactionTemplate(transactionManager);
  }

  /** Filters are optional local identifiers and closed state tokens; never provider identities. */
  public record Filters(UUID connectionId, UUID accountId, String state, String reviewState) {}

  public record Page(
      List<View> items,
      int limit,
      int offset,
      boolean hasMore,
      long unreviewedCount,
      long changedCount) {}

  /** Safe projection: local IDs, exact money text, and private provider evidence only. */
  public record View(
      UUID id,
      UUID connectionId,
      UUID accountMappingId,
      UUID localAccountId,
      String state,
      String reviewState,
      String changeState,
      String amount,
      String currency,
      LocalDate occurredOn,
      LocalDate authorizedOn,
      String providerDescription,
      boolean descriptionValid,
      UUID pendingPredecessorObservationId,
      String invalidReason,
      String dismissedReason,
      int version,
      UUID ledgerTransactionId,
      Instant createdAt,
      Instant updatedAt) {}

  /**
   * Owner instructions for one confirmation; account, money, currency, date, and visibility are
   * derived from the current observation.
   */
  public record ConfirmRequest(
      int expectedVersion,
      TransactionKind kind,
      String description,
      String rawCategory,
      boolean categoryPresent,
      UUID refundOfTransactionId,
      boolean acknowledgeDisclosure) {}

  /**
   * Owner instructions for one review resolution; both versions are the optimistic concurrency
   * tokens. {@code fields} is the sorted subset of bank facts to apply and is only meaningful for
   * APPLY_BANK.
   */
  public record ResolveRequest(
      int expectedVersion, int expectedLedgerVersion, String action, List<String> fields) {}

  /**
   * Owner instructions for one atomic ledger replacement; account, money, currency, and date still
   * derive from the current posted observation while kind/description/category/refund follow the
   * owner's correction.
   */
  public record ReplaceRequest(
      int expectedVersion,
      int expectedLedgerVersion,
      TransactionKind kind,
      String description,
      String rawCategory,
      boolean categoryPresent,
      UUID refundOfTransactionId,
      boolean acknowledgeDisclosure,
      boolean acknowledgeAllocationRemoval) {}

  @org.springframework.transaction.annotation.Transactional(readOnly = true)
  public Page list(UUID householdId, UUID actorId, Filters filters, int limit, int offset) {
    requireEnabled();
    String state = validateFilter(filters.state(), STATE_FILTERS, "state");
    String reviewState = validateFilter(filters.reviewState(), REVIEW_FILTERS, "review");
    List<ConnectionObservationEntity> page =
        findOwnedPage(
            householdId,
            actorId,
            filters.connectionId(),
            filters.accountId(),
            state,
            reviewState,
            limit + 1,
            offset);
    if (page.isEmpty()) {
      households.requireFinanceMembership(householdId, actorId);
    }
    boolean hasMore = page.size() > limit;
    List<View> items = page.stream().limit(limit).map(this::toView).toList();
    return new Page(
        items,
        limit,
        offset,
        hasMore,
        observations.countUnreviewed(householdId, actorId),
        observations.countChangedAdmitted(householdId, actorId));
  }

  @org.springframework.transaction.annotation.Transactional(readOnly = true)
  public View get(UUID householdId, UUID observationId, UUID actorId) {
    requireEnabled();
    return observations
        .findOwnedScoped(householdId, observationId, actorId)
        .map(this::toView)
        .orElseGet(
            () -> {
              households.requireFinanceMembership(householdId, actorId);
              throw new BankActivityNotFoundException();
            });
  }

  public Decision confirm(
      UUID householdId,
      UUID observationId,
      UUID actorId,
      UUID idempotencyKey,
      ConfirmRequest request) {
    requireEnabled();
    String fingerprint = confirmFingerprint(observationId, request);
    try {
      return transactions.execute(
          status -> {
            households.lockForFinance(householdId, actorId);
            var replayed =
                replay(actorId, householdId, CONFIRM_OPERATION, idempotencyKey, fingerprint);
            if (replayed != null) {
              return replayConfirm(householdId, actorId, replayed);
            }
            // Row locks follow household -> connection -> observation -> account -> refund source.
            // The id-only probe avoids hydrating the observation before its connection is locked.
            UUID peekConnectionId =
                observations
                    .findOwnedConnectionId(householdId, observationId, actorId)
                    .orElseThrow(BankActivityNotFoundException::new);
            FinancialConnectionEntity connection =
                connections
                    .findOwnedForUpdate(householdId, peekConnectionId, actorId)
                    .orElseThrow(BankActivityNotFoundException::new);
            if (!"ACTIVE".equals(connection.getState())) {
              if ("SUSPENDED".equals(connection.getState())
                  || "DISCONNECTING".equals(connection.getState())
                  || "DISCONNECTED".equals(connection.getState())) {
                throw new ConnectionDisconnectedException();
              }
              throw new ConnectionNotReadyException();
            }
            ConnectionObservationEntity observation =
                observations
                    .findOwnedForUpdate(householdId, observationId, actorId)
                    .orElseThrow(BankActivityNotFoundException::new);
            if (observation.getVersion() != request.expectedVersion()) {
              throw new ResourceVersionConflictException();
            }
            if ("CONFIRMED".equals(observation.getReviewState())) {
              throw new ObservationAlreadyConfirmedException();
            }
            if ("DISMISSED".equals(observation.getReviewState())) {
              throw new ObservationDismissedException();
            }
            if ("INVALID".equals(observation.getState())) {
              throw new ObservationInvalidException();
            }
            if (!"POSTED".equals(observation.getState())) {
              throw new ObservationNotPostedException();
            }
            ConnectionAccountMappingEntity mapping =
                observation.getAccountMappingId() == null
                    ? null
                    : mappings.findById(observation.getAccountMappingId()).orElse(null);
            if (mapping == null
                || !mapping.isSelected()
                || !mapping.isEligible()
                || mapping.getLocalAccountId() == null) {
              throw new ConnectionNotReadyException();
            }
            Values values = validateDecision(observation, request);
            FinancialTransactionEntity transaction =
                admit(householdId, actorId, observation, mapping, values, request);
            observation.admitted(observation.getProviderRevision(), now());
            try {
              reserve(
                  actorId,
                  householdId,
                  CONFIRM_OPERATION,
                  idempotencyKey,
                  fingerprint,
                  transaction.getId());
            } catch (DataIntegrityViolationException concurrent) {
              throw new ConnectionIdempotencyConflictException();
            }
            observations.flush();
            return new Decision(
                toView(observation), transaction.getId(), transaction.getVersion(), false);
          });
    } catch (DataIntegrityViolationException race) {
      // The partial unique association index is the last line of defense for a concurrent second
      // confirmation: exactly one admission wins and the loser observes the safe already-confirmed
      // contract. Referential-integrity violations are real defects and stay 500s.
      Throwable cause = race.getMostSpecificCause();
      if (cause instanceof java.sql.SQLException sql && "23505".equals(sql.getSQLState())) {
        throw new ObservationAlreadyConfirmedException();
      }
      throw race;
    }
  }

  public Decision dismiss(
      UUID householdId,
      UUID observationId,
      UUID actorId,
      UUID idempotencyKey,
      int expectedVersion,
      String reason) {
    requireEnabled();
    if (reason == null || !DISMISS_REASONS.contains(reason)) {
      throw new ValidationFailedException(Map.of("reason", "Choose a dismissal reason."));
    }
    String fingerprint =
        fingerprint(
            DISMISS_OPERATION + "\0" + observationId + "\0" + expectedVersion + "\0" + reason);
    return transactions.execute(
        status -> {
          households.lockForFinance(householdId, actorId);
          var replayed =
              replay(actorId, householdId, DISMISS_OPERATION, idempotencyKey, fingerprint);
          if (replayed != null) {
            View view =
                observations
                    .findOwnedScoped(householdId, observationId, actorId)
                    .map(this::toView)
                    .orElseThrow(BankActivityNotFoundException::new);
            return new Decision(view, null, null, false);
          }
          UUID peekConnectionId =
              observations
                  .findOwnedConnectionId(householdId, observationId, actorId)
                  .orElseThrow(BankActivityNotFoundException::new);
          connections
              .findOwnedForUpdate(householdId, peekConnectionId, actorId)
              .orElseThrow(BankActivityNotFoundException::new);
          ConnectionObservationEntity observation =
              observations
                  .findOwnedForUpdate(householdId, observationId, actorId)
                  .orElseThrow(BankActivityNotFoundException::new);
          if (observation.getVersion() != expectedVersion) {
            throw new ResourceVersionConflictException();
          }
          if ("CONFIRMED".equals(observation.getReviewState())) {
            throw new ObservationAdmittedException();
          }
          Instant now = now();
          if (!"DISMISSED".equals(observation.getReviewState())) {
            observation.dismissed(reason, now);
          }
          try {
            reserve(
                actorId,
                householdId,
                DISMISS_OPERATION,
                idempotencyKey,
                fingerprint,
                observationId);
          } catch (DataIntegrityViolationException concurrent) {
            throw new ConnectionIdempotencyConflictException();
          }
          observations.flush();
          return new Decision(toView(observation), null, null, false);
        });
  }

  /**
   * Resolves one admitted review without silently rewriting history: KEEP_LEDGER records the
   * decision against the exact bank revision and leaves the confirmed ledger untouched; APPLY_BANK
   * corrects only the selected amount/date/description facts through the existing ledger patch
   * path; VOID_LEDGER voids through the same path after live refunds are gone. APPLY_BANK is
   * unavailable for removed observations. Both versions are checked after the documented locks are
   * held, so a stale request fails without a partial write. Resolution works after disconnect from
   * any connection state except LINKING and never changes connection generation/state, restarts
   * sync, or admits a new account.
   */
  public Decision resolve(
      UUID householdId,
      UUID observationId,
      UUID actorId,
      UUID idempotencyKey,
      ResolveRequest request) {
    requireEnabled();
    if (request.action() == null || !RESOLVE_ACTIONS.contains(request.action())) {
      throw new ValidationFailedException(Map.of("action", "Choose a supported resolution."));
    }
    List<String> fields = sortedResolveFields(request);
    String fingerprint = resolveFingerprint(observationId, request, fields);
    try {
      return transactions.execute(
          status -> {
            households.lockForFinance(householdId, actorId);
            var replayed =
                replay(actorId, householdId, RESOLVE_OPERATION, idempotencyKey, fingerprint);
            if (replayed != null) {
              return replayResolve(householdId, actorId, replayed);
            }
            FinancialConnectionEntity connection =
                lockConnectionForActivity(householdId, observationId, actorId);
            ConnectionObservationEntity observation =
                observations
                    .findOwnedForUpdate(householdId, observationId, actorId)
                    .orElseThrow(BankActivityNotFoundException::new);
            if (observation.getVersion() != request.expectedVersion()) {
              throw new ResourceVersionConflictException();
            }
            requireObservationCapacity(observation);
            requireResolvableState(observation, request.action());
            ConnectionLedgerAssociationEntity association =
                associations
                    .findByObservationIdAndState(observation.getId(), "CURRENT")
                    .orElseThrow(ReconciliationRequiredException::new);
            if ("KEEP_LEDGER".equals(request.action())) {
              FinancialTransactionEntity ledger =
                  transactionRepo
                      .findOwnedForUpdate(householdId, association.getTransactionId(), actorId)
                      .orElseThrow(BankActivityNotFoundException::new);
              if (ledger.getVersion() != request.expectedLedgerVersion()) {
                throw new TransactionVersionConflictException();
              }
              Instant now = now();
              observation.admitted(observation.getProviderRevision(), now);
              try {
                reserve(
                    actorId,
                    householdId,
                    RESOLVE_OPERATION,
                    idempotencyKey,
                    fingerprint,
                    ledger.getId());
              } catch (DataIntegrityViolationException concurrent) {
                throw new ConnectionIdempotencyConflictException();
              }
              observations.flush();
              return new Decision(toView(observation), ledger.getId(), ledger.getVersion(), false);
            }
            // APPLY_BANK and VOID_LEDGER delegate to the existing ledger patch value path,
            // which takes the account/refund/allocation locks in the documented order and
            // re-checks the ledger version after locking: a stale request fails there without
            // a partial write, and the observation decision below only records on success.
            FinancialTransactionEntity peek =
                transactionRepo
                    .findOwnedScoped(householdId, association.getTransactionId(), actorId)
                    .orElseThrow(BankActivityNotFoundException::new);
            if (peek.getVersion() != request.expectedLedgerVersion()) {
              throw new TransactionVersionConflictException();
            }
            FinancialTransactionResponse patched =
                transactionService.patch(
                    householdId,
                    peek.getId(),
                    actorId,
                    resolvePatch(observation, peek, request, fields));
            Instant now = now();
            observation.admitted(observation.getProviderRevision(), now);
            try {
              reserve(
                  actorId,
                  householdId,
                  RESOLVE_OPERATION,
                  idempotencyKey,
                  fingerprint,
                  peek.getId());
            } catch (DataIntegrityViolationException concurrent) {
              throw new ConnectionIdempotencyConflictException();
            }
            observations.flush();
            return new Decision(toView(observation), peek.getId(), patched.version(), false);
          });
    } catch (DataIntegrityViolationException race) {
      throw mapAssociationRace(race);
    }
  }

  /**
   * Atomically replaces one admitted ledger entry: voids the old entry under the existing manual-ledger
   * constraints (live refunds first, active allocation deactivated only with explicit
   * acknowledgement), admits the replacement from the current posted observation through the
   * confirmation value path, and moves the CURRENT association while retaining the VOIDED history
   * row. The replacement keeps the old entry's local account; a currency/account mismatch stays
   * blocked for a separately reviewed mapping correction.
   */
  public ReplaceDecision replaceLedger(
      UUID householdId,
      UUID observationId,
      UUID actorId,
      UUID idempotencyKey,
      ReplaceRequest request) {
    requireEnabled();
    String fingerprint = replaceFingerprint(observationId, request);
    try {
      return transactions.execute(
          status -> {
            households.lockForFinance(householdId, actorId);
            var replayed =
                replay(actorId, householdId, REPLACE_OPERATION, idempotencyKey, fingerprint);
            if (replayed != null) {
              return replayReplace(householdId, actorId, replayed);
            }
            FinancialConnectionEntity connection =
                lockConnectionForActivity(householdId, observationId, actorId);
            ConnectionObservationEntity observation =
                observations
                    .findOwnedForUpdate(householdId, observationId, actorId)
                    .orElseThrow(BankActivityNotFoundException::new);
            if (observation.getVersion() != request.expectedVersion()) {
              throw new ResourceVersionConflictException();
            }
            requireObservationCapacity(observation);
            if (!"POSTED".equals(observation.getState())) {
              throw new ReconciliationRequiredException();
            }
            ConnectionLedgerAssociationEntity association =
                associations
                    .findByObservationIdAndState(observation.getId(), "CURRENT")
                    .orElseThrow(ReconciliationRequiredException::new);
            FinancialTransactionEntity oldLedger =
                transactionRepo
                    .findOwnedScoped(householdId, association.getTransactionId(), actorId)
                    .orElseThrow(BankActivityNotFoundException::new);
            if (oldLedger.getVersion() != request.expectedLedgerVersion()) {
              throw new TransactionVersionConflictException();
            }
            UUID localAccountId = localAccountOf(observation);
            if (localAccountId == null
                || !localAccountId.equals(oldLedger.getAccountId())
                || observation.getCurrency() == null
                || !observation.getCurrency().equals(oldLedger.getCurrency().name())) {
              throw new ReconciliationRequiredException();
            }
            Values values =
                validateDecision(
                    observation,
                    new ConfirmRequest(
                        request.expectedVersion(),
                        request.kind(),
                        request.description(),
                        request.rawCategory(),
                        request.categoryPresent(),
                        request.refundOfTransactionId(),
                        request.acknowledgeDisclosure()));
            if (!request.acknowledgeAllocationRemoval()
                && allocations
                    .findActiveByTransactionId(oldLedger.getId(), AllocationStatus.ACTIVE)
                    .isPresent()) {
              throw new AllocationConflictException();
            }
            // The void below takes the canonical account/refund/allocation locks and re-checks
            // the ledger version: live refunds, a concurrent change, or a version-exhausted
            // counter all fail before any replacement is admitted. Its response carries the
            // post-void version reported for the superseded entry.
            FinancialTransactionResponse voided =
                transactionService.patch(
                    householdId,
                    oldLedger.getId(),
                    actorId,
                    new FinancialTransactionService.PatchFields(
                        request.expectedLedgerVersion(),
                        true,
                        null,
                        null,
                        false,
                        null,
                        false,
                        null,
                        false,
                        null,
                        false,
                        null,
                        false,
                        "VOIDED",
                        true));
            FinancialTransactionEntity replacement =
                transactionService.admitConnected(
                    householdId,
                    actorId,
                    new FinancialTransactionService.ConnectedAdmission(
                        localAccountId,
                        values.kind(),
                        values.amount(),
                        values.currency(),
                        observation.getOccurredOn(),
                        values.description(),
                        values.category(),
                        values.categoryPresent(),
                        values.kind() == TransactionKind.REFUND
                            ? request.refundOfTransactionId()
                            : null,
                        request.acknowledgeDisclosure()));
            Instant now = now();
            association.voided();
            // Flush the superseded row before inserting the replacement: the partial unique
            // CURRENT-association index would otherwise observe the insert while the old row
            // is still current within the same flush.
            associations.saveAndFlush(association);
            associations.save(
                new ConnectionLedgerAssociationEntity(
                    UUID.randomUUID(),
                    observation.getId(),
                    replacement.getId(),
                    householdId,
                    actorId,
                    localAccountId,
                    observation.getCurrency(),
                    observation.getProviderRevision(),
                    now));
            observation.admitted(observation.getProviderRevision(), now);
            try {
              reserve(
                  actorId,
                  householdId,
                  REPLACE_OPERATION,
                  idempotencyKey,
                  fingerprint,
                  replacement.getId());
            } catch (DataIntegrityViolationException concurrent) {
              throw new ConnectionIdempotencyConflictException();
            }
            associations.flush();
            observations.flush();
            FinancialTransactionResponse replacementView =
                transactionService.get(householdId, replacement.getId(), actorId);
            return new ReplaceDecision(
                toView(observation), replacementView, oldLedger.getId(), voided.version(), false);
          });
    } catch (DataIntegrityViolationException race) {
      throw mapAssociationRace(race);
    }
  }

  /**
   * Row locks follow household -> connection -> observation -> account -> refund source. The
   * id-only probe avoids hydrating the observation before its connection is locked, and every state
   * except LINKING stays reviewable after disconnect without touching generation/state.
   */
  private FinancialConnectionEntity lockConnectionForActivity(
      UUID householdId, UUID observationId, UUID actorId) {
    UUID peekConnectionId =
        observations
            .findOwnedConnectionId(householdId, observationId, actorId)
            .orElseThrow(BankActivityNotFoundException::new);
    FinancialConnectionEntity connection =
        connections
            .findOwnedForUpdate(householdId, peekConnectionId, actorId)
            .orElseThrow(BankActivityNotFoundException::new);
    if ("LINKING".equals(connection.getState())) {
      throw new ConnectionNotReadyException();
    }
    return connection;
  }

  private static void requireObservationCapacity(ConnectionObservationEntity observation) {
    if (observation.getVersion() == Integer.MAX_VALUE) {
      throw new ResourceVersionExhaustedException();
    }
  }

  private static void requireResolvableState(
      ConnectionObservationEntity observation, String action) {
    if ("APPLY_BANK".equals(action)) {
      if (!"POSTED".equals(observation.getState())) {
        throw new ReconciliationRequiredException();
      }
      return;
    }
    if (!"POSTED".equals(observation.getState()) && !"REMOVED".equals(observation.getState())) {
      throw new ReconciliationRequiredException();
    }
  }

  private static List<String> sortedResolveFields(ResolveRequest request) {
    List<String> fields = request.fields() == null ? List.of() : request.fields();
    if ("APPLY_BANK".equals(request.action())) {
      if (fields.isEmpty()) {
        throw new ValidationFailedException(Map.of("fields", "Choose at least one bank fact."));
      }
      List<String> sorted = new ArrayList<>(fields);
      for (String field : sorted) {
        if (field == null || !APPLY_FIELDS.contains(field)) {
          throw new ValidationFailedException(Map.of("fields", "Choose a supported bank fact."));
        }
      }
      Collections.sort(sorted);
      for (int i = 1; i < sorted.size(); i++) {
        if (sorted.get(i).equals(sorted.get(i - 1))) {
          throw new ValidationFailedException(Map.of("fields", "Choose each bank fact once."));
        }
      }
      return List.copyOf(sorted);
    }
    if (!fields.isEmpty()) {
      throw new ValidationFailedException(
          Map.of("fields", "Bank facts only apply with APPLY_BANK."));
    }
    return List.of();
  }

  /**
   * Builds the ledger patch for APPLY_BANK/VOID_LEDGER from the current bank revision. Only the
   * selected amount/date/description facts move; kind/currency/account/category/visibility and
   * refund links never change here. A currency drift or a bank sign flip against the confirmed kind
   * needs the replacement workflow instead.
   */
  private FinancialTransactionService.PatchFields resolvePatch(
      ConnectionObservationEntity observation,
      FinancialTransactionEntity ledger,
      ResolveRequest request,
      List<String> fields) {
    if ("VOID_LEDGER".equals(request.action())) {
      return new FinancialTransactionService.PatchFields(
          request.expectedLedgerVersion(),
          true,
          null,
          null,
          false,
          null,
          false,
          null,
          false,
          null,
          false,
          null,
          false,
          "VOIDED",
          true);
    }
    boolean applyAmount = fields.contains("amount");
    boolean applyDate = fields.contains("occurredOn");
    boolean applyDescription = fields.contains("description");
    String moneyAmount = null;
    String moneyCurrency = null;
    if (applyAmount) {
      if (observation.getAmount() == null
          || observation.getCurrency() == null
          || !observation.getCurrency().equals(ledger.getCurrency().name())) {
        throw new ReconciliationRequiredException();
      }
      Map<String, String> signErrors = new LinkedHashMap<>();
      checkSign(ledger.getKind(), observation.getAmount(), signErrors);
      if (!signErrors.isEmpty()) {
        throw new ReconciliationRequiredException();
      }
      SupportedCurrency currency;
      String scaledAmount;
      try {
        currency = SupportedCurrency.valueOf(observation.getCurrency());
        scaledAmount = toResponseString(observation.getAmount(), currency);
      } catch (IllegalArgumentException | ArithmeticException corrupt) {
        // Corrupt stored bank facts (unknown currency, overscale amount) cannot be applied;
        // like the confirmation path, they need review rather than a silent mapping fix.
        throw new ReconciliationRequiredException();
      }
      moneyAmount = scaledAmount;
      moneyCurrency = currency.name();
    }
    String occurredOn = null;
    if (applyDate) {
      if (observation.getOccurredOn() == null) {
        throw new ReconciliationRequiredException();
      }
      occurredOn = observation.getOccurredOn().toString();
    }
    String description = null;
    if (applyDescription) {
      if (!observation.isDescriptionValid() || observation.getProviderDescription() == null) {
        throw new ValidationFailedException(
            Map.of("fields", "The bank description needs an owner-supplied value."));
      }
      description = observation.getProviderDescription();
    }
    return new FinancialTransactionService.PatchFields(
        request.expectedLedgerVersion(),
        true,
        moneyAmount,
        moneyCurrency,
        applyAmount,
        occurredOn,
        applyDate,
        description,
        applyDescription,
        null,
        false,
        null,
        false,
        null,
        false);
  }

  private Decision replayResolve(
      UUID householdId, UUID actorId, ConnectionOperationIdempotencyEntity record) {
    // Reauthorize before replay: the association must still belong to this actor's household.
    ConnectionLedgerAssociationEntity association =
        associations
            .findByTransactionId(record.getResourceId())
            .filter(
                stored ->
                    stored.getHouseholdId().equals(householdId)
                        && stored.getOwnerUserId().equals(actorId))
            .orElseThrow(BankActivityNotFoundException::new);
    ConnectionObservationEntity observation =
        observations
            .findOwnedScoped(householdId, association.getObservationId(), actorId)
            .orElseThrow(BankActivityNotFoundException::new);
    Integer transactionVersion =
        transactionRepo
            .findById(record.getResourceId())
            .map(FinancialTransactionEntity::getVersion)
            .orElse(null);
    return new Decision(toView(observation), record.getResourceId(), transactionVersion, true);
  }

  private ReplaceDecision replayReplace(
      UUID householdId, UUID actorId, ConnectionOperationIdempotencyEntity record) {
    ConnectionLedgerAssociationEntity association =
        associations
            .findByTransactionId(record.getResourceId())
            .filter(
                stored ->
                    stored.getHouseholdId().equals(householdId)
                        && stored.getOwnerUserId().equals(actorId))
            .orElseThrow(BankActivityNotFoundException::new);
    ConnectionObservationEntity observation =
        observations
            .findOwnedScoped(householdId, association.getObservationId(), actorId)
            .orElseThrow(BankActivityNotFoundException::new);
    FinancialTransactionResponse replacement;
    try {
      replacement = transactionService.get(householdId, record.getResourceId(), actorId);
    } catch (RuntimeException missing) {
      throw new BankActivityNotFoundException();
    }
    List<ConnectionLedgerAssociationEntity> history =
        associations.findAllByObservationIdAndState(observation.getId(), "VOIDED");
    ConnectionLedgerAssociationEntity superseded =
        history.stream()
            .max((first, second) -> first.getCreatedAt().compareTo(second.getCreatedAt()))
            .orElse(null);
    UUID supersededId = superseded == null ? null : superseded.getTransactionId();
    Integer supersededVersion =
        supersededId == null
            ? null
            : transactionRepo
                .findById(supersededId)
                .map(FinancialTransactionEntity::getVersion)
                .orElse(null);
    return new ReplaceDecision(
        toView(observation), replacement, supersededId, supersededVersion, true);
  }

  private UUID localAccountOf(ConnectionObservationEntity observation) {
    if (observation.getAccountMappingId() == null) {
      return null;
    }
    return mappings
        .findById(observation.getAccountMappingId())
        .map(ConnectionAccountMappingEntity::getLocalAccountId)
        .orElse(null);
  }

  /**
   * The partial unique CURRENT-association index stays the last line of defense for a concurrent
   * second resolution: a concurrent winner surfaces as a stale-version conflict here because the
   * loser's observation version can no longer match. Referential-integrity violations are real
   * defects and stay 500s.
   */
  private static RuntimeException mapAssociationRace(DataIntegrityViolationException race) {
    Throwable cause = race.getMostSpecificCause();
    if (cause instanceof java.sql.SQLException sql && "23505".equals(sql.getSQLState())) {
      throw new ResourceVersionConflictException();
    }
    throw race;
  }

  /**
   * Validates owner instructions; account, money, currency, date, and visibility are server facts.
   */
  private Values validateDecision(ConnectionObservationEntity observation, ConfirmRequest request) {
    Map<String, String> errors = new LinkedHashMap<>();
    if (request.kind() == null) {
      errors.put("kind", "Choose expense, income, refund, or transfer.");
    }
    SupportedCurrency currency = null;
    try {
      currency = SupportedCurrency.valueOf(observation.getCurrency());
    } catch (RuntimeException rejected) {
      throw new ObservationInvalidException();
    }
    BigDecimal amount;
    try {
      amount = observation.getAmount().setScale(currency.scale());
    } catch (ArithmeticException rejected) {
      throw new ObservationInvalidException();
    }
    String description = request.description();
    if (description == null) {
      if (!observation.isDescriptionValid() || observation.getProviderDescription() == null) {
        errors.put("description", "Enter a description for this bank activity.");
      } else {
        description = observation.getProviderDescription();
      }
    }
    if (description != null) {
      String descriptionError = violation(description).orElse(null);
      if (descriptionError != null) {
        errors.put("description", descriptionError);
      } else {
        description = normalize(description);
      }
    }
    String category = null;
    if (request.categoryPresent() && request.rawCategory() != null) {
      try {
        category = TransactionCategory.valueOf(request.rawCategory()).name();
      } catch (IllegalArgumentException rejected) {
        errors.put("category", "Choose a supported category.");
      }
    }
    if (request.kind() != null) {
      checkSign(request.kind(), amount, errors);
    }
    if (request.kind() != TransactionKind.REFUND && request.refundOfTransactionId() != null) {
      errors.put("refundOfTransactionId", "Only refunds reference another entry.");
    }
    if (!errors.isEmpty()) {
      throw new ValidationFailedException(errors);
    }
    return new Values(
        request.kind(), amount, currency, description, category, request.categoryPresent());
  }

  private FinancialTransactionEntity admit(
      UUID householdId,
      UUID actorId,
      ConnectionObservationEntity observation,
      ConnectionAccountMappingEntity mapping,
      Values values,
      ConfirmRequest request) {
    FinancialTransactionEntity transaction =
        transactionService.admitConnected(
            householdId,
            actorId,
            new FinancialTransactionService.ConnectedAdmission(
                mapping.getLocalAccountId(),
                values.kind(),
                values.amount(),
                values.currency(),
                observation.getOccurredOn(),
                values.description(),
                values.category(),
                values.categoryPresent(),
                values.kind() == TransactionKind.REFUND ? request.refundOfTransactionId() : null,
                request.acknowledgeDisclosure()));
    associations.save(
        new ConnectionLedgerAssociationEntity(
            UUID.randomUUID(),
            observation.getId(),
            transaction.getId(),
            householdId,
            actorId,
            mapping.getLocalAccountId(),
            observation.getCurrency(),
            observation.getProviderRevision(),
            now()));
    associations.flush();
    return transaction;
  }

  private Decision replayConfirm(
      UUID householdId, UUID actorId, ConnectionOperationIdempotencyEntity record) {
    // Reauthorize before replay: the association must still belong to this actor's household.
    ConnectionLedgerAssociationEntity association =
        associations
            .findByTransactionId(record.getResourceId())
            .filter(
                stored ->
                    stored.getHouseholdId().equals(householdId)
                        && stored.getOwnerUserId().equals(actorId))
            .orElseThrow(BankActivityNotFoundException::new);
    ConnectionObservationEntity observation =
        observations
            .findOwnedScoped(householdId, association.getObservationId(), actorId)
            .orElseThrow(BankActivityNotFoundException::new);
    Integer transactionVersion =
        transactionRepo
            .findById(record.getResourceId())
            .map(FinancialTransactionEntity::getVersion)
            .orElse(null);
    return new Decision(toView(observation), record.getResourceId(), transactionVersion, true);
  }

  private List<ConnectionObservationEntity> findOwnedPage(
      UUID householdId,
      UUID actorId,
      UUID connectionId,
      UUID accountId,
      String state,
      String reviewState,
      int limit,
      int offset) {
    StringBuilder sql =
        new StringBuilder(
            "SELECT o.* FROM connection_observations o"
                + " JOIN household_members m ON m.household_id = o.household_id"
                + " AND m.user_id = :actorId"
                + " WHERE o.household_id = :householdId AND o.owner_user_id = :actorId");
    if (connectionId != null) {
      sql.append(" AND o.connection_id = :connectionId");
    }
    if (accountId != null) {
      sql.append(
          " AND EXISTS (SELECT 1 FROM financial_connection_account_mappings mp"
              + " WHERE mp.id = o.account_mapping_id AND mp.local_account_id = :accountId)");
    }
    if (state != null) {
      sql.append(" AND o.state = :state");
    }
    if (reviewState != null) {
      sql.append(" AND o.review_state = :reviewState");
    }
    sql.append(" ORDER BY o.created_at DESC, o.id DESC LIMIT :limit OFFSET :offset");
    Query query =
        entityManager.createNativeQuery(sql.toString(), ConnectionObservationEntity.class);
    query.setParameter("householdId", householdId);
    query.setParameter("actorId", actorId);
    if (connectionId != null) {
      query.setParameter("connectionId", connectionId);
    }
    if (accountId != null) {
      query.setParameter("accountId", accountId);
    }
    if (state != null) {
      query.setParameter("state", state);
    }
    if (reviewState != null) {
      query.setParameter("reviewState", reviewState);
    }
    query.setParameter("limit", limit);
    query.setParameter("offset", offset);
    @SuppressWarnings("unchecked")
    List<ConnectionObservationEntity> results = query.getResultList();
    return results;
  }

  private View toView(ConnectionObservationEntity observation) {
    UUID predecessorId = null;
    if (observation.getPendingPredecessorDigest() != null) {
      predecessorId =
          observations
              .findByConnectionIdAndRemoteTransactionDigest(
                  observation.getConnectionId(), observation.getPendingPredecessorDigest())
              .map(ConnectionObservationEntity::getId)
              .orElse(null);
    }
    UUID ledgerTransactionId =
        associations
            .findByObservationIdAndState(observation.getId(), "CURRENT")
            .map(ConnectionLedgerAssociationEntity::getTransactionId)
            .orElse(null);
    UUID localAccountId = null;
    if (observation.getAccountMappingId() != null) {
      localAccountId =
          mappings
              .findById(observation.getAccountMappingId())
              .map(ConnectionAccountMappingEntity::getLocalAccountId)
              .orElse(null);
    }
    String amount = null;
    if (observation.getAmount() != null && observation.getCurrency() != null) {
      try {
        amount =
            observation
                .getAmount()
                .setScale(SupportedCurrency.valueOf(observation.getCurrency()).scale())
                .toPlainString();
      } catch (RuntimeException incomplete) {
        amount = null;
      }
    }
    return new View(
        observation.getId(),
        observation.getConnectionId(),
        observation.getAccountMappingId(),
        localAccountId,
        observation.getState(),
        observation.getReviewState(),
        observation.getChangeState(),
        amount,
        observation.getCurrency(),
        observation.getOccurredOn(),
        observation.getAuthorizedOn(),
        observation.getProviderDescription(),
        observation.isDescriptionValid(),
        predecessorId,
        observation.getInvalidReason(),
        observation.getDismissedReason(),
        observation.getVersion(),
        ledgerTransactionId,
        observation.getCreatedAt(),
        observation.getUpdatedAt());
  }

  private String confirmFingerprint(UUID observationId, ConfirmRequest request) {
    return fingerprint(
        CONFIRM_OPERATION
            + "\0"
            + observationId
            + "\0"
            + request.expectedVersion()
            + "\0"
            + request.kind()
            + "\0"
            + request.description()
            + "\0"
            + decisionCategoryToken(
                request.kind(), request.rawCategory(), request.categoryPresent())
            + "\0"
            + request.refundOfTransactionId()
            + "\0"
            + request.acknowledgeDisclosure());
  }

  /**
   * Canonical category instruction shared by confirm and replace: a refund omission means INHERIT
   * and stays distinct from an explicit value (including explicit null), while a non-refund null
   * normalizes to uncategorized. Missing acknowledgements canonicalize to false at the call site
   * through primitive booleans.
   */
  private static String decisionCategoryToken(
      TransactionKind kind, String rawCategory, boolean categoryPresent) {
    if (kind == TransactionKind.REFUND) {
      return categoryPresent ? (rawCategory == null ? "NULL" : rawCategory) : "INHERIT";
    }
    return rawCategory == null ? "UNCATEGORIZED" : rawCategory;
  }

  private String resolveFingerprint(
      UUID observationId, ResolveRequest request, List<String> sortedFields) {
    return fingerprint(
        RESOLVE_OPERATION
            + "\0"
            + observationId
            + "\0"
            + request.expectedVersion()
            + "\0"
            + request.expectedLedgerVersion()
            + "\0"
            + request.action()
            + "\0"
            + String.join("\0", sortedFields));
  }

  private String replaceFingerprint(UUID observationId, ReplaceRequest request) {
    return fingerprint(
        REPLACE_OPERATION
            + "\0"
            + observationId
            + "\0"
            + request.expectedVersion()
            + "\0"
            + request.expectedLedgerVersion()
            + "\0"
            + request.kind()
            + "\0"
            + request.description()
            + "\0"
            + decisionCategoryToken(
                request.kind(), request.rawCategory(), request.categoryPresent())
            + "\0"
            + request.refundOfTransactionId()
            + "\0"
            + request.acknowledgeDisclosure()
            + "\0"
            + request.acknowledgeAllocationRemoval());
  }

  private String fingerprint(String canonical) {
    return ConnectionCrypto.sha256Hex(canonical);
  }

  private ConnectionOperationIdempotencyEntity replay(
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

  private void reserve(
      UUID actorId,
      UUID householdId,
      String operation,
      UUID key,
      String fingerprint,
      UUID resource) {
    idempotency.save(
        new ConnectionOperationIdempotencyEntity(
            new ConnectionOperationIdempotencyKey(actorId, householdId, operation, key),
            fingerprint,
            resource,
            null,
            now()));
    idempotency.flush();
  }

  private static String validateFilter(String value, Set<String> allowed, String field) {
    if (value == null) {
      return null;
    }
    if (!allowed.contains(value)) {
      throw new ValidationFailedException(Map.of(field, "Choose a supported filter."));
    }
    return value;
  }

  private void requireEnabled() {
    if (!properties.isEnabled()) {
      throw new ConnectedFinanceDisabledException();
    }
  }

  private Instant now() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  public record Decision(
      View activity, UUID transactionId, Integer transactionVersion, boolean replayed) {}

  /**
   * Replacement outcome: the current review plus the replacement entry. The activity's ledger
   * association field already points at the replacement; the superseded entry stays retained as
   * VOIDED history.
   */
  public record ReplaceDecision(
      View activity,
      FinancialTransactionResponse transaction,
      UUID supersededTransactionId,
      Integer supersededTransactionVersion,
      boolean replayed) {}

  private record Values(
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      String description,
      String category,
      boolean categoryPresent) {}
}
