package com.housesync.finance.activity.application;

import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.normalize;
import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.violation;
import static com.housesync.finance.transaction.domain.TransactionMoneyPolicy.checkSign;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionConflictException;
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
import com.housesync.finance.transaction.application.FinancialTransactionService;
import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
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
 * Owner-private bank-activity inbox plus one-time ledger admission.
 *
 * <p>Reads are owner-scoped: foreign, other-owner, former-member, and missing resources all produce
 * an indistinguishable 404. Confirmation derives account, money, currency, date, source, and
 * visibility from the current observation and rejects those client fields through strict
 * unknown-field handling. Admission is atomic with its ledger association; a second key cannot
 * admit the same observation, and a replay reauthorizes before returning the persisted outcome.
 * Dismissal applies to any unadmitted observation, including pending ones, and never touches the
 * ledger. Pending, invalid, removed, and unreviewed observations never contribute to reporting.
 */
@Service
public class BankActivityService {

  private static final String CONFIRM_OPERATION = "BANK_ACTIVITY_CONFIRM";
  private static final String DISMISS_OPERATION = "BANK_ACTIVITY_DISMISS";
  private static final String PRIVATE_VISIBILITY = "PRIVATE";
  private static final Set<String> STATE_FILTERS =
      Set.of("PENDING", "POSTED", "REMOVED", "INVALID");
  private static final Set<String> REVIEW_FILTERS = Set.of("UNREVIEWED", "CONFIRMED", "DISMISSED");
  private static final Set<String> DISMISS_REASONS = Set.of("ALREADY_RECORDED", "NOT_NEEDED");

  private final ConnectedFinanceProperties properties;
  private final ConnectionObservationRepository observations;
  private final ConnectionLedgerAssociationRepository associations;
  private final ConnectionAccountMappingRepository mappings;
  private final FinancialConnectionRepository connections;
  private final ConnectionOperationIdempotencyRepository idempotency;
  private final FinancialTransactionService transactionService;
  private final FinancialTransactionRepository transactionRepo;
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
    String category;
    if (request.kind() == TransactionKind.REFUND) {
      category =
          request.categoryPresent()
              ? (request.rawCategory() == null ? "NULL" : request.rawCategory())
              : "INHERIT";
    } else {
      category = request.rawCategory() == null ? "UNCATEGORIZED" : request.rawCategory();
    }
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
            + category
            + "\0"
            + request.refundOfTransactionId()
            + "\0"
            + request.acknowledgeDisclosure());
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

  private record Values(
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      String description,
      String category,
      boolean categoryPresent) {}
}
