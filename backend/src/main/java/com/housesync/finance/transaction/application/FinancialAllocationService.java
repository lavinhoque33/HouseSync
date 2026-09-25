package com.housesync.finance.transaction.application;

import static com.housesync.finance.transaction.domain.AllocationSharesPolicy.CANONICAL_USER_ORDER;
import static com.housesync.finance.transaction.domain.AllocationSharesPolicy.equalShares;
import static com.housesync.finance.transaction.domain.AllocationSharesPolicy.refundShares;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.account.persistence.FinancialAccountRepository;
import com.housesync.finance.account.web.FinancialAccountExceptions.FinancialAccountNotFoundException;
import com.housesync.finance.categorization.application.CategorizationReviewService;
import com.housesync.finance.transaction.domain.AllocationMethod;
import com.housesync.finance.transaction.domain.AllocationRefundPolicy;
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
import com.housesync.finance.transaction.web.FinancialAllocationPreviewResponse;
import com.housesync.finance.transaction.web.FinancialAllocationRequests.ExactShareRequest;
import com.housesync.finance.transaction.web.FinancialAllocationResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.ImpactParticipantResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.ImpactResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.MoneyResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.ParticipantResponse;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationIdempotencyConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionForbiddenException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionExhaustedException;
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
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Allocation creation, preview, revocation and zero-sum balances. Lifecycle/account/expense/group
 * locks precede allocation locks. Original shares are immutable; current cumulative refund shares
 * are derived from the allocation's persisted policy rather than individual refund records.
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
  private final ObjectProvider<CategorizationReviewService> categorizationReviews;

  public FinancialAllocationService(
      FinancialTransactionRepository transactions,
      FinancialTransactionAllocationRepository allocations,
      FinancialTransactionAllocationParticipantRepository participants,
      FinancialAllocationIdempotencyRepository idempotency,
      FinancialAccountRepository accounts,
      HouseholdService households,
      Clock clock,
      ObjectProvider<CategorizationReviewService> categorizationReviews) {
    this.transactions = transactions;
    this.allocations = allocations;
    this.participants = participants;
    this.idempotency = idempotency;
    this.accounts = accounts;
    this.households = households;
    this.clock = clock;
    this.categorizationReviews = categorizationReviews;
  }

  /** Normalized create input; duplicate and malformed participants are rejected up front. */
  public record CreateFields(
      Integer expectedVersion,
      boolean expectedVersionPresent,
      List<String> rawParticipantUserIds,
      boolean participantUserIdsPresent,
      List<ExactShareRequest> rawParticipantShares,
      boolean participantSharesPresent) {}

  public record CreateResult(FinancialAllocationResponse allocation, boolean replayed) {}

  @Transactional
  public CreateResult create(
      UUID householdId, UUID transactionId, UUID actorId, UUID idempotencyKey, CreateFields raw) {
    CreateValues values = validateCreate(raw);
    // Group locks precede allocation locks; impact is calculated from the entire refund group.
    households.lockForFinance(householdId, actorId);

    FinancialAllocationIdempotencyKey key =
        new FinancialAllocationIdempotencyKey(
            actorId, householdId, CREATE_OPERATION, idempotencyKey);
    String fingerprint =
        values.method() == AllocationMethod.EQUAL
            ? fingerprint(transactionId, values.expectedVersion(), values.participants())
            : exactFingerprint(transactionId, values);
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
      return new CreateResult(toResponse(allocation, expense.getVersion(), householdId), true);
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
    transactions.findGroupForUpdate(transactionId);

    // The roster bounds the participant set, and the lifecycle lock held here means the
    // checked membership cannot be removed before the allocation commits.
    Set<UUID> roster = households.currentMemberUserIds(householdId);
    for (UUID participant : values.participants()) {
      if (!roster.contains(participant)) {
        throw new ValidationFailedException(
            Map.of(
                values.method() == AllocationMethod.EXACT
                    ? "participantShares"
                    : "participantUserIds",
                "Choose current household participants."));
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
    List<BigDecimal> shares =
        values.method() == AllocationMethod.EQUAL
            ? equalShares(magnitude, currency, ordered.size())
            : validatedExactShares(values, currency, magnitude);
    Instant now = now();
    FinancialTransactionAllocationEntity allocation =
        new FinancialTransactionAllocationEntity(
            UUID.randomUUID(),
            transactionId,
            householdId,
            expense.getOwnerUserId(),
            currency,
            magnitude,
            values.method(),
            values.method() == AllocationMethod.EQUAL
                ? AllocationRefundPolicy.EQUAL_V1
                : AllocationRefundPolicy.EXACT_JEFFERSON_V1,
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
    categorizationReviews.getObject().ledgerChanged(expense, false);
    transactions.flush();
    allocations.flush();
    idempotency.flush();
    return new CreateResult(toResponse(allocation, expense.getVersion(), householdId), false);
  }

  @Transactional
  public FinancialAllocationResponse get(UUID householdId, UUID transactionId, UUID actorId) {
    households.lockForFinance(householdId, actorId);
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
    return toResponse(allocation, expense.getVersion(), householdId);
  }

  /**
   * Read-only calculation under the same lifecycle/account/expense/refund-group ordering as create.
   */
  @Transactional
  public FinancialAllocationPreviewResponse preview(
      UUID householdId, UUID transactionId, UUID actorId, CreateFields raw) {
    CreateValues values = validateCreate(raw);
    households.lockForFinance(householdId, actorId);
    FinancialTransactionEntity peek =
        transactions
            .findVisibleScoped(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    if (!peek.getOwnerUserId().equals(actorId)) throw new TransactionForbiddenException();
    if (peek.getKind() != TransactionKind.EXPENSE
        || peek.getStatus() != TransactionStatus.POSTED
        || !HOUSEHOLD_VISIBILITY.equals(peek.getVisibility()))
      throw new AllocationConflictException();
    accounts
        .findOwnedForUpdate(householdId, peek.getAccountId(), actorId)
        .orElseThrow(FinancialAccountNotFoundException::new);
    FinancialTransactionEntity expense =
        transactions
            .findOwnedForUpdate(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    List<FinancialTransactionEntity> group = transactions.findGroupForUpdate(transactionId);
    Set<UUID> roster = households.currentMemberUserIds(householdId);
    if (!roster.containsAll(values.participants())) {
      throw new ValidationFailedException(
          Map.of(
              values.method() == AllocationMethod.EXACT
                  ? "participantShares"
                  : "participantUserIds",
              "Choose current household participants."));
    }
    if (allocations.findActiveForUpdate(transactionId, AllocationStatus.ACTIVE).isPresent())
      throw new AllocationConflictException();
    if (expense.getVersion() != values.expectedVersion())
      throw new TransactionVersionConflictException();
    if (expense.getVersion() == Integer.MAX_VALUE) throw new TransactionVersionExhaustedException();
    SupportedCurrency currency = expense.getCurrency();
    BigDecimal magnitude = expense.getAmount().abs();
    List<BigDecimal> shares =
        values.method() == AllocationMethod.EQUAL
            ? equalShares(magnitude, currency, values.participants().size())
            : validatedExactShares(values, currency, magnitude);
    AllocationRefundPolicy policy =
        values.method() == AllocationMethod.EQUAL
            ? AllocationRefundPolicy.EQUAL_V1
            : AllocationRefundPolicy.EXACT_JEFFERSON_V1;
    List<ParticipantResponse> frozen =
        participantResponses(values.participants(), shares, currency);
    BigDecimal refunded =
        group.stream()
            .filter(row -> row.getStatus() == TransactionStatus.POSTED)
            .map(FinancialTransactionEntity::getAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    return new FinancialAllocationPreviewResponse(
        transactionId,
        expense.getVersion(),
        values.method().name(),
        policy.name(),
        money(magnitude, currency),
        frozen,
        impact(magnitude, refunded, policy, frozen, expense.getOwnerUserId(), currency));
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
    categorizationReviews.getObject().ledgerChanged(expense, false);
    transactions.saveAndFlush(expense);
    allocations.save(allocation);
    allocations.flush();
    return toResponse(allocation, expense.getVersion(), householdId);
  }

  /** Raw zero-sum deltas; caller MUST hold the household finance lifecycle lock. */
  public Map<String, Map<UUID, BigDecimal>> allocationBalanceDeltasLocked(UUID householdId) {
    List<FinancialTransactionAllocationEntity> actives =
        allocations.findActiveByHouseholdId(householdId, AllocationStatus.ACTIVE);
    Map<String, Map<UUID, BigDecimal>> ledger = new TreeMap<>();
    if (actives.isEmpty()) return ledger;
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
      List<BigDecimal> reversed =
          refundShares(
              allocation.getRefundPolicy(),
              magnitude,
              ordered.stream()
                  .map(FinancialTransactionAllocationParticipantEntity::getShare)
                  .toList(),
              refunded,
              currency,
              ordered.stream()
                  .map(FinancialTransactionAllocationParticipantEntity::getUserId)
                  .toList());
      for (int index = 0; index < ordered.size(); index++) {
        // A participant owes their original share minus their cumulative refund share, so
        // the obligation enters the ledger as a negative "is owed" amount.
        BigDecimal obligation =
            ordered.get(index).getShare().subtract(reversed.get(index)).negate();
        addBalance(ledger, currency.name(), ordered.get(index).getUserId(), obligation);
      }
    }
    return ledger;
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

  private static final Pattern SHARE_AMOUNT = Pattern.compile("(0|[1-9][0-9]{0,11})(\\.[0-9]+)?");

  private CreateValues validateCreate(CreateFields raw) {
    Map<String, String> errors = new LinkedHashMap<>();
    if (!raw.expectedVersionPresent() || raw.expectedVersion() == null || raw.expectedVersion() < 0)
      errors.put("expectedVersion", "Provide the current transaction version.");
    boolean equal = raw.participantUserIdsPresent();
    boolean exact = raw.participantSharesPresent();
    if (equal == exact) {
      errors.put("participantShares", "Provide exactly one participant list.");
      errors.put("participantUserIds", "Provide exactly one participant list.");
    }
    String field = exact && !equal ? "participantShares" : "participantUserIds";
    List<UUID> ids = new ArrayList<>();
    Map<UUID, ExactValue> exactValues = new LinkedHashMap<>();
    Set<UUID> seen = new LinkedHashSet<>();
    List<String> rawIds = equal ? raw.rawParticipantUserIds() : null;
    List<ExactShareRequest> rawShares = exact ? raw.rawParticipantShares() : null;
    int count =
        equal ? (rawIds == null ? 0 : rawIds.size()) : (rawShares == null ? 0 : rawShares.size());
    if (count == 0) errors.put(field, "Choose the participants sharing this expense.");
    for (int i = 0; i < count; i++) {
      ExactShareRequest entry = equal ? null : rawShares.get(i);
      String text = equal ? rawIds.get(i) : entry == null ? null : entry.userId();
      UUID id;
      try {
        id = UUID.fromString(text);
        if ((!equal && !id.toString().equals(text)) || !seen.add(id))
          throw new IllegalArgumentException("Noncanonical or duplicate participant.");
      } catch (IllegalArgumentException | NullPointerException rejected) {
        errors.put(
            field,
            equal
                ? "Choose distinct household participants."
                : "Choose distinct canonical household participants.");
        continue;
      }
      ids.add(id);
      if (!equal) {
        var share = entry.share();
        SupportedCurrency currency = null;
        if (share != null && share.currency() != null) {
          try {
            currency = SupportedCurrency.valueOf(share.currency());
          } catch (IllegalArgumentException rejected) {
            // Safe field error below.
          }
        }
        String amount = share == null ? null : share.amount();
        if (currency == null
            || amount == null
            || amount.length() > 17
            || !SHARE_AMOUNT.matcher(amount).matches()) {
          errors.put(field, "Enter nonnegative shares in a supported currency.");
          continue;
        }
        BigDecimal parsed = new BigDecimal(amount);
        if (parsed.scale() > currency.scale()) {
          errors.put(field, "Enter shares at the currency's exact scale.");
          continue;
        }
        exactValues.put(id, new ExactValue(currency, parsed.setScale(currency.scale())));
      }
    }
    if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    ids.sort(CANONICAL_USER_ORDER);
    return new CreateValues(
        raw.expectedVersion(),
        ids,
        exact ? AllocationMethod.EXACT : AllocationMethod.EQUAL,
        exactValues);
  }

  private static List<BigDecimal> validatedExactShares(
      CreateValues values, SupportedCurrency currency, BigDecimal magnitude) {
    List<BigDecimal> shares = new ArrayList<>(values.participants().size());
    BigDecimal total = BigDecimal.ZERO;
    for (UUID id : values.participants()) {
      ExactValue value = values.exactValues().get(id);
      if (value.currency() != currency || value.amount().compareTo(magnitude) > 0)
        throw new ValidationFailedException(
            Map.of("participantShares", "Shares must match the expense."));
      shares.add(value.amount());
      total = total.add(value.amount());
    }
    if (total.compareTo(magnitude) != 0)
      throw new ValidationFailedException(
          Map.of("participantShares", "Shares must total the expense."));
    return shares;
  }

  private static String exactFingerprint(UUID transactionId, CreateValues values) {
    List<String> fields = new ArrayList<>();
    fields.add("EXACT_V1");
    fields.add(transactionId.toString());
    fields.add(values.expectedVersion().toString());
    for (UUID id : values.participants()) {
      ExactValue value = values.exactValues().get(id);
      fields.add(id.toString());
      fields.add(value.currency().name());
      fields.add(value.amount().toPlainString());
    }
    return sha256(String.join("\u0000", fields));
  }

  private static String sha256(String canonical) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(canonical.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is required by the Java platform", impossible);
    }
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
      FinancialTransactionAllocationEntity allocation, int transactionVersion, UUID householdId) {
    SupportedCurrency currency = allocation.getCurrency();
    List<ParticipantResponse> ordered =
        participants.findByAllocationIdIn(List.of(allocation.getId())).stream()
            .sorted(Comparator.comparing(row -> row.getUserId().toString()))
            .map(row -> new ParticipantResponse(row.getUserId(), money(row.getShare(), currency)))
            .toList();
    ImpactResponse current =
        allocation.getStatus() == AllocationStatus.REVOKED
            ? null
            : impact(
                allocation.getOriginalAmount(),
                refundSum(allocation.getTransactionId()),
                allocation.getRefundPolicy(),
                ordered,
                allocation.getPayerUserId(),
                currency);
    return new FinancialAllocationResponse(
        allocation.getId(),
        allocation.getTransactionId(),
        householdId,
        allocation.getPayerUserId(),
        currency.name(),
        money(allocation.getOriginalAmount(), currency),
        ordered,
        allocation.getStatus().name(),
        allocation.getCreatedAt(),
        allocation.getRevokedAt(),
        transactionVersion,
        allocation.getMethod().name(),
        allocation.getRefundPolicy().name(),
        current);
  }

  private BigDecimal refundSum(UUID transactionId) {
    return transactions.sumPostedRefunds(List.of(transactionId), TransactionStatus.POSTED).stream()
        .map(row -> (BigDecimal) row[1])
        .findFirst()
        .orElse(BigDecimal.ZERO);
  }

  private static List<ParticipantResponse> participantResponses(
      List<UUID> ids, List<BigDecimal> shares, SupportedCurrency currency) {
    List<ParticipantResponse> result = new ArrayList<>(ids.size());
    for (int i = 0; i < ids.size(); i++)
      result.add(new ParticipantResponse(ids.get(i), money(shares.get(i), currency)));
    return result;
  }

  private static MoneyResponse money(BigDecimal value, SupportedCurrency currency) {
    return new MoneyResponse(value.setScale(currency.scale()).toPlainString(), currency.name());
  }

  private static ImpactResponse impact(
      BigDecimal original,
      BigDecimal refunded,
      AllocationRefundPolicy policy,
      List<ParticipantResponse> frozen,
      UUID payer,
      SupportedCurrency currency) {
    List<UUID> ids = frozen.stream().map(ParticipantResponse::userId).toList();
    List<BigDecimal> shares =
        frozen.stream().map(row -> new BigDecimal(row.share().amount())).toList();
    List<BigDecimal> reversals = refundShares(policy, original, shares, refunded, currency, ids);
    List<ImpactParticipantResponse> entries = new ArrayList<>(ids.size());
    for (int i = 0; i < ids.size(); i++)
      entries.add(
          new ImpactParticipantResponse(
              ids.get(i),
              money(reversals.get(i), currency),
              money(shares.get(i).subtract(reversals.get(i)), currency)));
    return new ImpactResponse(
        money(refunded, currency),
        money(original.subtract(refunded), currency),
        List.copyOf(entries));
  }

  private record ExactValue(SupportedCurrency currency, BigDecimal amount) {}

  private record CreateValues(
      Integer expectedVersion,
      List<UUID> participants,
      AllocationMethod method,
      Map<UUID, ExactValue> exactValues) {}
}
