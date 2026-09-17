package com.housesync.finance.transaction.application;

import static com.housesync.finance.transaction.domain.AllocationSharesPolicy.CANONICAL_USER_ORDER;
import static com.housesync.finance.transaction.domain.AllocationSharesPolicy.equalShares;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.account.persistence.FinancialAccountRepository;
import com.housesync.finance.account.web.FinancialAccountExceptions.FinancialAccountNotFoundException;
import com.housesync.finance.transaction.domain.AllocationStatus;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import com.housesync.finance.transaction.persistence.FinancialAllocationIdempotencyEntity;
import com.housesync.finance.transaction.persistence.FinancialAllocationIdempotencyKey;
import com.housesync.finance.transaction.persistence.FinancialAllocationIdempotencyRepository;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationParticipantEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationParticipantRepository;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationRepository;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.finance.transaction.web.FinancialAllocationResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.MoneyResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.ParticipantResponse;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationIdempotencyConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionForbiddenException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionExhaustedException;
import com.housesync.finance.transaction.web.MemberBalancesResponse;
import com.housesync.finance.transaction.web.MemberBalancesResponse.CurrencyBalancesResponse;
import com.housesync.finance.transaction.web.MemberBalancesResponse.MemberBalanceResponse;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Basic allocation use cases (ADR 0007): one active equal allocation per owner-created
 * {@code POSTED} {@code HOUSEHOLD} expense, frozen participant shares, durable create idempotency,
 * owner-only revoke, and derived per-currency member balances.
 *
 * <p>Locking follows the documented order: the household lifecycle lock first, then the expense's
 * account, then the expense row, then linked refund rows (held by the transaction service), then
 * the allocation row. Balances read under the lifecycle lock from one consistent authorized
 * snapshot; refund shares are derived at read time from the cumulative posted refund magnitude with
 * the same equal-division rule and are never persisted.
 */
@Service
public class FinancialAllocationService {

  private static final String CREATE_OPERATION = "ALLOCATION_CREATE";
  private static final String HOUSEHOLD_VISIBILITY = "HOUSEHOLD";
  private static final String REVOKED = "REVOKED";
  private static final String CURRENT = "CURRENT";
  private static final String DEPARTED = "DEPARTED";

  private final FinancialTransactionRepository transactions;
  private final FinancialTransactionAllocationRepository allocations;
  private final FinancialTransactionAllocationParticipantRepository participants;
  private final FinancialAllocationIdempotencyRepository idempotency;
  private final FinancialAccountRepository accounts;
  private final HouseholdService households;
  private final Clock clock;

  public FinancialAllocationService(
      FinancialTransactionRepository transactions,
      FinancialTransactionAllocationRepository allocations,
      FinancialTransactionAllocationParticipantRepository participants,
      FinancialAllocationIdempotencyRepository idempotency,
      FinancialAccountRepository accounts,
      HouseholdService households,
      Clock clock) {
    this.transactions = transactions;
    this.allocations = allocations;
    this.participants = participants;
    this.idempotency = idempotency;
    this.accounts = accounts;
    this.households = households;
    this.clock = clock;
  }

  /** Normalized create input; duplicate and malformed participants are rejected up front. */
  public record CreateFields(
      Integer expectedVersion,
      boolean expectedVersionPresent,
      List<String> rawParticipantUserIds,
      boolean participantUserIdsPresent) {}

  public record CreateResult(FinancialAllocationResponse allocation, boolean replayed) {}

  @Transactional
  public CreateResult create(
      UUID householdId, UUID transactionId, UUID actorId, UUID idempotencyKey, CreateFields raw) {
    CreateValues values = validateCreate(raw);
    households.lockForFinance(householdId, actorId);

    FinancialAllocationIdempotencyKey key =
        new FinancialAllocationIdempotencyKey(
            actorId, householdId, CREATE_OPERATION, idempotencyKey);
    String fingerprint =
        fingerprint(transactionId, values.expectedVersion(), values.participants());
    var existing = idempotency.findById(key);
    if (existing.isPresent()) {
      if (!existing.get().getRequestFingerprint().equals(fingerprint)) {
        throw new AllocationIdempotencyConflictException();
      }
      // Replay reauthorizes membership and financial ownership, then returns the current
      // representation (possibly now revoked); create preconditions are deliberately not
      // reapplied, so a since-revoked allocation still answers its durable key.
      FinancialTransactionAllocationEntity allocation =
          allocations
              .findById(existing.get().getResourceId())
              .filter(
                  stored ->
                      stored.getHouseholdId().equals(householdId)
                          && stored.getPayerUserId().equals(actorId))
              .orElseThrow(AllocationNotFoundException::new);
      FinancialTransactionEntity expense =
          transactions
              .findOwnedScoped(householdId, allocation.getTransactionId(), actorId)
              .orElseThrow(TransactionNotFoundException::new);
      return new CreateResult(toResponse(allocation, expense.getVersion()), true);
    }

    // Membership is already confirmed under the lifecycle lock; a resource miss is a
    // foreign/hidden/missing expense and stays a generic transaction 404 before any
    // eligibility signal, while a visible row owned by someone else answers 403.
    FinancialTransactionEntity peek =
        transactions
            .findVisibleScoped(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    if (!peek.getOwnerUserId().equals(actorId)) {
      // Sharing authorizes reading only; allocation mutation stays financial-owner-only.
      throw new TransactionForbiddenException();
    }
    if (peek.getKind() != TransactionKind.EXPENSE
        || peek.getStatus() != TransactionStatus.POSTED
        || !HOUSEHOLD_VISIBILITY.equals(peek.getVisibility())) {
      throw new AllocationConflictException();
    }
    // Lock order: household lifecycle, expense account, expense row, allocation rows.
    accounts
        .findOwnedForUpdate(householdId, peek.getAccountId(), actorId)
        .orElseThrow(FinancialAccountNotFoundException::new);
    FinancialTransactionEntity expense =
        transactions
            .findOwnedForUpdate(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);

    // The roster bounds the participant set, and the lifecycle lock held here means the
    // checked membership cannot be removed before the allocation commits.
    Set<UUID> roster = households.currentMemberUserIds(householdId);
    for (UUID participant : values.participants()) {
      if (!roster.contains(participant)) {
        throw new ValidationFailedException(
            Map.of("participantUserIds", "Choose the participants sharing this expense."));
      }
    }
    if (allocations.findActiveForUpdate(transactionId, AllocationStatus.ACTIVE).isPresent()) {
      throw new AllocationConflictException();
    }
    if (expense.getVersion() != values.expectedVersion()) {
      throw new TransactionVersionConflictException();
    }
    if (expense.getVersion() == Integer.MAX_VALUE) {
      // Fails before any allocation row, idempotency key reservation, or version bump, so a
      // fully-versioned expense stays immutable and the same key succeeds on a later retry.
      throw new TransactionVersionExhaustedException();
    }

    List<UUID> ordered = values.participants();
    SupportedCurrency currency = expense.getCurrency();
    BigDecimal magnitude = expense.getAmount().abs();
    List<BigDecimal> shares = equalShares(magnitude, currency, ordered.size());
    Instant now = now();
    FinancialTransactionAllocationEntity allocation =
        new FinancialTransactionAllocationEntity(
            UUID.randomUUID(),
            transactionId,
            householdId,
            expense.getOwnerUserId(),
            currency,
            magnitude,
            now);
    allocations.save(allocation);
    for (int index = 0; index < ordered.size(); index++) {
      participants.save(
          new FinancialTransactionAllocationParticipantEntity(
              allocation.getId(), ordered.get(index), currency.name(), shares.get(index)));
    }
    idempotency.save(
        new FinancialAllocationIdempotencyEntity(key, fingerprint, allocation.getId(), now));
    // A state-changing allocation create moves the expense version once, so stale expense
    // forms and concurrent allocation changes conflict on the next attempt.
    expense.allocationChanged(now);
    transactions.flush();
    allocations.flush();
    idempotency.flush();
    return new CreateResult(toResponse(allocation, expense.getVersion()), false);
  }

  @Transactional(readOnly = true)
  public FinancialAllocationResponse get(UUID householdId, UUID transactionId, UUID actorId) {
    FinancialTransactionEntity expense =
        transactions
            .findVisibleScoped(householdId, transactionId, actorId)
            .orElseGet(
                () -> {
                  // A miss is either a foreign/hidden entry for a current member (generic
                  // resource 404) or a non-member/removed actor (generic household 404);
                  // membership decides before any allocation state is disclosed.
                  households.requireFinanceMembership(householdId, actorId);
                  throw new TransactionNotFoundException();
                });
    FinancialTransactionAllocationEntity allocation =
        allocations
            .findActiveByTransactionId(transactionId, AllocationStatus.ACTIVE)
            .orElseThrow(AllocationNotFoundException::new);
    return toResponse(allocation, expense.getVersion());
  }

  /** Revoke input: exactly {@code expectedVersion} plus {@code status: "REVOKED"}. */
  public record RevokeFields(
      Integer expectedVersion,
      boolean expectedVersionPresent,
      String status,
      boolean statusPresent) {}

  @Transactional
  public FinancialAllocationResponse revoke(
      UUID householdId, UUID transactionId, UUID actorId, RevokeFields raw) {
    int expectedVersion = validateRevoke(raw);
    households.lockForFinance(householdId, actorId);
    FinancialTransactionEntity peek =
        transactions
            .findVisibleScoped(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    if (!peek.getOwnerUserId().equals(actorId)) {
      // Sharing authorizes reading only; allocation mutation stays financial-owner-only.
      throw new TransactionForbiddenException();
    }
    // Lock order: household lifecycle, expense account, expense row, allocation row.
    accounts
        .findOwnedForUpdate(householdId, peek.getAccountId(), actorId)
        .orElseThrow(FinancialAccountNotFoundException::new);
    FinancialTransactionEntity expense =
        transactions
            .findOwnedForUpdate(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    FinancialTransactionAllocationEntity allocation =
        allocations
            .findActiveForUpdate(transactionId, AllocationStatus.ACTIVE)
            .orElseThrow(AllocationNotFoundException::new);
    if (expense.getVersion() != expectedVersion) {
      throw new TransactionVersionConflictException();
    }
    if (expense.getVersion() == Integer.MAX_VALUE) {
      throw new TransactionVersionExhaustedException();
    }
    Instant now = now();
    allocation.revoked(now);
    // Revocation moves the expense version once, so a stale revoke call or a stale
    // recreation attempt conflicts instead of acting on moved state.
    expense.allocationChanged(now);
    transactions.saveAndFlush(expense);
    allocations.save(allocation);
    allocations.flush();
    return toResponse(allocation, expense.getVersion());
  }

  /**
   * Derived balances from one coherent authorized snapshot under the household lifecycle lock, so a
   * concurrent removal cannot produce a partially authorized read. Contributions come only from
   * active allocations on posted household expenses; the payer credit is {@code M - R} and each
   * participant's obligation is their frozen share minus their cumulative refund share, so every
   * currency's balances sum to exactly zero.
   */
  @Transactional
  public MemberBalancesResponse memberBalances(UUID householdId, UUID actorId) {
    households.lockForFinance(householdId, actorId);
    List<FinancialTransactionAllocationEntity> actives =
        allocations.findActiveByHouseholdId(householdId, AllocationStatus.ACTIVE);
    if (actives.isEmpty()) {
      return new MemberBalancesResponse(List.of());
    }
    List<UUID> allocationIds =
        actives.stream().map(FinancialTransactionAllocationEntity::getId).toList();
    Map<UUID, List<FinancialTransactionAllocationParticipantEntity>> frozen =
        participants.findByAllocationIdIn(allocationIds).stream()
            .collect(
                Collectors.groupingBy(
                    FinancialTransactionAllocationParticipantEntity::getAllocationId));
    List<UUID> expenseIds =
        actives.stream().map(FinancialTransactionAllocationEntity::getTransactionId).toList();
    Map<UUID, FinancialTransactionEntity> expensesById =
        transactions.findHouseholdScopedByIds(householdId, expenseIds).stream()
            .collect(Collectors.toMap(FinancialTransactionEntity::getId, Function.identity()));
    Map<UUID, BigDecimal> postedRefundSums =
        transactions.sumPostedRefunds(expenseIds, TransactionStatus.POSTED).stream()
            .collect(Collectors.toMap(row -> (UUID) row[0], row -> (BigDecimal) row[1]));
    Set<UUID> currentMembers = households.currentMemberUserIds(householdId);

    // Code-ordered ledger of exact-scale obligations per user per currency.
    Map<String, Map<UUID, BigDecimal>> ledger = new TreeMap<>();
    for (FinancialTransactionAllocationEntity allocation : actives) {
      FinancialTransactionEntity expense = expensesById.get(allocation.getTransactionId());
      if (expense == null
          || expense.getKind() != TransactionKind.EXPENSE
          || expense.getStatus() != TransactionStatus.POSTED
          || !HOUSEHOLD_VISIBILITY.equals(expense.getVisibility())) {
        // Active allocations exist only on eligible expenses; a drifted row contributes
        // nothing rather than corrupting the zero-sum ledger.
        continue;
      }
      SupportedCurrency currency = allocation.getCurrency();
      List<FinancialTransactionAllocationParticipantEntity> ordered =
          frozen.getOrDefault(allocation.getId(), List.of()).stream()
              .sorted(Comparator.comparing(row -> row.getUserId().toString()))
              .toList();
      BigDecimal magnitude = expense.getAmount().abs();
      BigDecimal refunded = postedRefundSums.getOrDefault(expense.getId(), BigDecimal.ZERO);
      addBalance(
          ledger, currency.name(), allocation.getPayerUserId(), magnitude.subtract(refunded));
      List<BigDecimal> refundShares = equalShares(refunded, currency, ordered.size());
      for (int index = 0; index < ordered.size(); index++) {
        // A participant owes their original share minus their cumulative refund share, so
        // the obligation enters the ledger as a negative "is owed" amount.
        BigDecimal obligation =
            ordered.get(index).getShare().subtract(refundShares.get(index)).negate();
        addBalance(ledger, currency.name(), ordered.get(index).getUserId(), obligation);
      }
    }

    List<CurrencyBalancesResponse> currencies = new ArrayList<>();
    for (Map.Entry<String, Map<UUID, BigDecimal>> entry : ledger.entrySet()) {
      SupportedCurrency currency = SupportedCurrency.valueOf(entry.getKey());
      List<MemberBalanceResponse> balances = new ArrayList<>();
      entry.getValue().entrySet().stream()
          .sorted(Map.Entry.comparingByKey(CANONICAL_USER_ORDER))
          .forEach(
              balance -> {
                if (balance.getValue().signum() == 0) {
                  // Exact zeros are omitted, so each emitted currency sums to zero.
                  return;
                }
                String membership = currentMembers.contains(balance.getKey()) ? CURRENT : DEPARTED;
                balances.add(
                    new MemberBalanceResponse(
                        balance.getKey().toString(),
                        membership,
                        balance.getValue().setScale(currency.scale()).toPlainString()));
              });
      if (!balances.isEmpty()) {
        currencies.add(new CurrencyBalancesResponse(entry.getKey(), balances));
      }
    }
    return new MemberBalancesResponse(List.copyOf(currencies));
  }

  private static void addBalance(
      Map<String, Map<UUID, BigDecimal>> ledger, String code, UUID userId, BigDecimal amount) {
    ledger
        .computeIfAbsent(code, ignored -> new LinkedHashMap<>())
        .merge(userId, amount, BigDecimal::add);
  }

  /** Only a current expectedVersion plus exactly REVOKED is a valid revoke request. */
  private static int validateRevoke(RevokeFields raw) {
    Map<String, String> errors = new LinkedHashMap<>();
    if (!raw.expectedVersionPresent()
        || raw.expectedVersion() == null
        || raw.expectedVersion() < 0) {
      errors.put("expectedVersion", "Provide the current transaction version.");
    }
    if (!raw.statusPresent() || raw.status() == null || !REVOKED.equals(raw.status())) {
      errors.put("status", "Only revoked status is accepted.");
    }
    if (!errors.isEmpty()) {
      throw new ValidationFailedException(errors);
    }
    return raw.expectedVersion();
  }

  private CreateValues validateCreate(CreateFields raw) {
    Map<String, String> errors = new LinkedHashMap<>();
    if (!raw.expectedVersionPresent()
        || raw.expectedVersion() == null
        || raw.expectedVersion() < 0) {
      errors.put("expectedVersion", "Provide the current transaction version.");
    }
    List<UUID> participants = new ArrayList<>();
    if (!raw.participantUserIdsPresent() || raw.rawParticipantUserIds() == null) {
      errors.put("participantUserIds", "Choose the participants sharing this expense.");
    } else if (raw.rawParticipantUserIds().isEmpty()) {
      errors.put("participantUserIds", "Choose the participants sharing this expense.");
    } else {
      Set<UUID> seen = new LinkedHashSet<>();
      boolean invalid = false;
      for (String rawId : raw.rawParticipantUserIds()) {
        if (rawId == null) {
          invalid = true;
          continue;
        }
        try {
          UUID parsed = UUID.fromString(rawId);
          // Duplicates are rejected before normalization rather than silently deduplicated.
          if (!seen.add(parsed)) {
            invalid = true;
          }
        } catch (IllegalArgumentException rejected) {
          invalid = true;
        }
      }
      if (invalid) {
        errors.put("participantUserIds", "Choose the participants sharing this expense.");
      } else {
        participants.addAll(seen.stream().sorted(CANONICAL_USER_ORDER).toList());
      }
    }
    if (!errors.isEmpty()) {
      throw new ValidationFailedException(errors);
    }
    return new CreateValues(raw.expectedVersion(), participants);
  }

  /**
   * Canonical create fingerprint: expense transaction ID, expected expense version, and the sorted
   * participant set. Equivalent requests replay; any other input under the same scoped key
   * conflicts.
   */
  private static String fingerprint(
      UUID transactionId, int expectedVersion, List<UUID> sortedParticipants) {
    String canonical =
        transactionId
            + "\u0000"
            + expectedVersion
            + "\u0000"
            + String.join("\u0000", sortedParticipants.stream().map(UUID::toString).toList());
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(canonical.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is required by the Java platform", impossible);
    }
  }

  private Instant now() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  /** Exact documented representation; shares are the persisted frozen originals in order. */
  private FinancialAllocationResponse toResponse(
      FinancialTransactionAllocationEntity allocation, int transactionVersion) {
    List<ParticipantResponse> ordered =
        participants.findByAllocationIdIn(List.of(allocation.getId())).stream()
            .sorted(Comparator.comparing(row -> row.getUserId().toString()))
            .map(
                row ->
                    new ParticipantResponse(
                        row.getUserId(),
                        new MoneyResponse(
                            row.getShare()
                                .setScale(allocation.getCurrency().scale())
                                .toPlainString(),
                            allocation.getCurrency().name())))
            .toList();
    return new FinancialAllocationResponse(
        allocation.getId(),
        allocation.getTransactionId(),
        allocation.getHouseholdId(),
        allocation.getPayerUserId(),
        allocation.getCurrency().name(),
        new MoneyResponse(
            allocation
                .getOriginalAmount()
                .setScale(allocation.getCurrency().scale())
                .toPlainString(),
            allocation.getCurrency().name()),
        ordered,
        allocation.getStatus().name(),
        allocation.getCreatedAt(),
        allocation.getRevokedAt(),
        transactionVersion);
  }

  private record CreateValues(Integer expectedVersion, List<UUID> participants) {}
}
