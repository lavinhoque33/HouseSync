package com.housesync.finance.transaction.application;

import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.normalize;
import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.violation;
import static com.housesync.finance.transaction.domain.TransactionMoneyPolicy.checkSign;
import static com.housesync.finance.transaction.domain.TransactionMoneyPolicy.parseAmount;
import static com.housesync.finance.transaction.domain.TransactionMoneyPolicy.toResponseString;

import com.housesync.finance.account.domain.FinancialAccountStatus;
import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.account.persistence.FinancialAccountEntity;
import com.housesync.finance.account.persistence.FinancialAccountRepository;
import com.housesync.finance.account.web.FinancialAccountExceptions.FinancialAccountNotFoundException;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.finance.transaction.persistence.TransactionIdempotencyEntity;
import com.housesync.finance.transaction.persistence.TransactionIdempotencyKey;
import com.housesync.finance.transaction.persistence.TransactionIdempotencyRepository;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AccountArchivedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.RefundConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionIdempotencyConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionExhaustedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVoidedException;
import com.housesync.finance.transaction.web.FinancialTransactionListResponse;
import com.housesync.finance.transaction.web.FinancialTransactionResponse;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Private manual transaction use cases: entries are owned by the actor, private, and
 * versioned. Every mutation serializes with household membership lifecycle through {@link
 * HouseholdService#lockForFinance}, and refund operations lock their source expense first and the
 * live refund rows in ascending UUID order. Source-expense version propagation for refund-group
 * operations is handled separately and is deliberately not applied here.
 */
@Service
public class FinancialTransactionService {

  private static final String CREATE_OPERATION = "TRANSACTION_CREATE";
  private static final String PRIVATE_VISIBILITY = "PRIVATE";
  private static final LocalDate MIN_OCCURRED_ON = LocalDate.of(1900, 1, 1);
  private static final LocalDate MAX_OCCURRED_ON = LocalDate.of(9999, 12, 30);

  private final FinancialTransactionRepository transactions;
  private final TransactionIdempotencyRepository idempotency;
  private final FinancialAccountRepository accounts;
  private final HouseholdService households;
  private final Clock clock;
  private final EntityManager entityManager;

  public FinancialTransactionService(
      FinancialTransactionRepository transactions,
      TransactionIdempotencyRepository idempotency,
      FinancialAccountRepository accounts,
      HouseholdService households,
      Clock clock,
      EntityManager entityManager) {
    this.transactions = transactions;
    this.idempotency = idempotency;
    this.accounts = accounts;
    this.households = households;
    this.clock = clock;
    this.entityManager = entityManager;
  }

  /** Normalized create input; null keeps the documented omitted-field default. */
  public record CreateFields(
      String accountId,
      String kind,
      String amount,
      String currency,
      String occurredOn,
      String description,
      String visibility,
      boolean visibilityPresent,
      String refundOfTransactionId,
      boolean refundOfTransactionIdPresent) {}

  public record CreateResult(FinancialTransactionResponse transaction, boolean replayed) {}

  @Transactional
  public CreateResult create(
      UUID householdId, UUID actorId, UUID idempotencyKey, CreateFields raw) {
    CreateValues values = validateCreate(raw);
    households.lockForFinance(householdId, actorId);

    TransactionIdempotencyKey key =
        new TransactionIdempotencyKey(actorId, householdId, CREATE_OPERATION, idempotencyKey);
    String fingerprint = fingerprint(values);
    var existing = idempotency.findById(key);
    if (existing.isPresent()) {
      if (!existing.get().getRequestFingerprint().equals(fingerprint)) {
        throw new TransactionIdempotencyConflictException();
      }
      // Replay reauthorizes membership and ownership, then returns the current
      // representation; current create preconditions are deliberately not reapplied.
      FinancialTransactionEntity transaction =
          transactions
              .findOwnedScoped(householdId, existing.get().getResourceId(), actorId)
              .orElseThrow(TransactionNotFoundException::new);
      return new CreateResult(toResponse(transaction), true);
    }

    FinancialAccountEntity account =
        accounts
            .findOwnedForUpdate(householdId, values.accountId(), actorId)
            .orElseThrow(FinancialAccountNotFoundException::new);
    if (account.getStatus() == FinancialAccountStatus.ARCHIVED) {
      throw new AccountArchivedException();
    }
    if (account.getCurrency() != values.currency()) {
      throw new ValidationFailedException(
          Map.of("money.currency", "Enter the account's currency."));
    }

    FinancialTransactionEntity source = null;
    if (values.kind() == TransactionKind.REFUND) {
      // Lock order: household, account, source expense, then live refund rows ascending.
      source = loadRefundSource(householdId, actorId, values);
      checkRefundCap(source, values.amount(), BigDecimal.ZERO);
    }

    Instant now = now();
    FinancialTransactionEntity transaction =
        new FinancialTransactionEntity(
            UUID.randomUUID(),
            householdId,
            actorId,
            account.getId(),
            values.kind(),
            values.amount(),
            values.currency(),
            values.occurredOn(),
            values.description(),
            source == null ? null : source.getId(),
            now);
    transactions.save(transaction);
    idempotency.save(new TransactionIdempotencyEntity(key, fingerprint, transaction.getId(), now));
    transactions.flush();
    idempotency.flush();
    return new CreateResult(toResponse(transaction), false);
  }

  @Transactional(readOnly = true)
  public FinancialTransactionListResponse list(
      UUID householdId,
      UUID actorId,
      String status,
      UUID accountId,
      String currency,
      LocalDate from,
      LocalDate to,
      int limit,
      int offset) {
    if (accountId != null) {
      // A filtered feed resolves membership first so a non-member gets the household 404
      // rather than a resource-shaped one, then requires private account ownership.
      households.requireFinanceMembership(householdId, actorId);
      accounts
          .findOwnedScoped(householdId, accountId, actorId)
          .orElseThrow(FinancialAccountNotFoundException::new);
    }
    List<FinancialTransactionEntity> page =
        findOwnedPage(
            householdId, actorId, status, accountId, currency, from, to, limit + 1, offset);
    if (page.isEmpty()) {
      // Preserve missing/non-member equivalence without a separate broad transaction read.
      households.requireFinanceMembership(householdId, actorId);
    }
    boolean hasMore = page.size() > limit;
    List<FinancialTransactionResponse> items =
        page.stream().limit(limit).map(FinancialTransactionService::toResponse).toList();
    return new FinancialTransactionListResponse(items, limit, offset, hasMore);
  }

  @Transactional(readOnly = true)
  public FinancialTransactionResponse get(UUID householdId, UUID transactionId, UUID actorId) {
    return transactions
        .findOwnedScoped(householdId, transactionId, actorId)
        .map(FinancialTransactionService::toResponse)
        .orElseGet(
            () -> {
              // A miss is either a foreign/hidden entry for a current member (generic resource
              // 404) or a non-member/removed actor (generic household 404); membership decides.
              households.requireFinanceMembership(householdId, actorId);
              throw new TransactionNotFoundException();
            });
  }

  /** Normalized patch input; presence flags distinguish explicit null from omission. */
  public record PatchFields(
      Integer expectedVersion,
      boolean expectedVersionPresent,
      String moneyAmount,
      String moneyCurrency,
      boolean moneyPresent,
      String occurredOn,
      boolean occurredOnPresent,
      String description,
      boolean descriptionPresent,
      String visibility,
      boolean visibilityPresent,
      String status,
      boolean statusPresent) {}

  @Transactional
  public FinancialTransactionResponse patch(
      UUID householdId, UUID transactionId, UUID actorId, PatchFields raw) {
    PatchValues values = validatePatch(raw);
    households.lockForFinance(householdId, actorId);
    // Pre-read under the household lifecycle lock (no concurrent finance mutation can
    // commit while it is held) to learn the row's kind, account, and refund source, then
    // take row locks in the documented deterministic order: household/account context,
    // source expense first, then all linked refund rows in ascending UUID order, with
    // the patched row selected from the locked set. expectedVersion is compared only
    // after the relevant rows are locked.
    FinancialTransactionEntity peek =
        transactions
            .findOwnedScoped(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    accounts
        .findOwnedForUpdate(householdId, peek.getAccountId(), actorId)
        .orElseThrow(FinancialAccountNotFoundException::new);
    FinancialTransactionEntity transaction;
    if (peek.getKind() == TransactionKind.REFUND) {
      // Refund-group operations lock the source expense before any refund UUID; the
      // ordered group lock covers posted and voided members, so a correction, a void,
      // and a retained no-op all observe the same acquisition sequence.
      transactions
          .findOwnedForUpdate(householdId, peek.getRefundOfTransactionId(), actorId)
          .orElseThrow(RefundConflictException::new);
      transaction =
          transactions.findGroupForUpdate(peek.getRefundOfTransactionId()).stream()
              .filter(refund -> refund.getId().equals(transactionId))
              .findFirst()
              .orElseThrow(TransactionNotFoundException::new);
    } else {
      transaction =
          transactions
              .findOwnedForUpdate(householdId, transactionId, actorId)
              .orElseThrow(TransactionNotFoundException::new);
    }
    if (transaction.getVersion() != values.expectedVersion()) {
      throw new TransactionVersionConflictException();
    }
    // Refund visibility is inherited through the whole linked group; a direct patch is
    // never accepted in any state because sharing owns that behavior.
    if (values.visibilityPresent() && transaction.getKind() == TransactionKind.REFUND) {
      throw new ValidationFailedException(
          Map.of("visibility", "Refund visibility follows its expense."));
    }

    if (values.statusPresent()) {
      if (transaction.getStatus() == TransactionStatus.VOIDED) {
        // An already voided record accepts a current-version void no-op.
        return toResponse(transaction);
      }
      if (transaction.getKind() == TransactionKind.EXPENSE) {
        List<FinancialTransactionEntity> liveRefunds =
            transactions.findLiveRefundsForUpdate(transaction.getId(), TransactionStatus.POSTED);
        if (!liveRefunds.isEmpty()) {
          throw new RefundConflictException();
        }
      }
      if (transaction.getVersion() == Integer.MAX_VALUE) {
        throw new TransactionVersionExhaustedException();
      }
      transaction.voided(now());
      transactions.saveAndFlush(transaction);
      return toResponse(transaction);
    }

    if (transaction.getStatus() == TransactionStatus.VOIDED) {
      boolean economicEdit =
          values.currency() != null || values.occurredOn() != null || values.description() != null;
      if (economicEdit) {
        // Voided economic fields cannot be edited or restored.
        throw new TransactionVoidedException();
      }
      // A same-value visibility touch on a retained voided entry stays a no-op here and
      // remains allowed by the sharing rules.
    }

    BigDecimal nextAmount = transaction.getAmount();
    LocalDate nextOccurredOn = transaction.getOccurredOn();
    String nextDescription = transaction.getDescription();
    if (values.currency() != null) {
      if (values.currency() != transaction.getCurrency()) {
        throw new ValidationFailedException(
            Map.of("money.currency", "Enter the account's currency."));
      }
      Map<String, String> signErrors = new LinkedHashMap<>();
      checkSign(transaction.getKind(), values.amount(), signErrors);
      if (!signErrors.isEmpty()) {
        throw new ValidationFailedException(signErrors);
      }
      nextAmount = values.amount();
    }
    if (values.occurredOn() != null) {
      nextOccurredOn = values.occurredOn();
    }
    if (values.description() != null) {
      nextDescription = values.description();
    }

    boolean amountChanged = nextAmount.compareTo(transaction.getAmount()) != 0;
    boolean dateChanged = !nextOccurredOn.equals(transaction.getOccurredOn());
    boolean descriptionChanged = !nextDescription.equals(transaction.getDescription());
    boolean visibilityChanged =
        values.visibility() != null && !values.visibility().equals(transaction.getVisibility());
    if (!amountChanged && !dateChanged && !descriptionChanged && !visibilityChanged) {
      // Authorized no-op returns the unchanged representation without a version bump.
      return toResponse(transaction);
    }

    if (amountChanged || dateChanged) {
      checkRefundGroupBounds(transaction, nextAmount, nextOccurredOn);
    }
    if (transaction.getVersion() == Integer.MAX_VALUE) {
      throw new TransactionVersionExhaustedException();
    }
    transaction.correct(nextAmount, nextOccurredOn, nextDescription, now());
    transactions.saveAndFlush(transaction);
    return toResponse(transaction);
  }

  /**
   * Builds the authorized OWN-view page query dynamically so every optional filter is either
   * omitted or bound with a concrete typed value; visibility scope and filters apply in SQL, never
   * to an unrestricted in-memory result.
   */
  private List<FinancialTransactionEntity> findOwnedPage(
      UUID householdId,
      UUID actorId,
      String status,
      UUID accountId,
      String currency,
      LocalDate from,
      LocalDate to,
      int limit,
      int offset) {
    StringBuilder sql =
        new StringBuilder(
            "SELECT t.* FROM financial_transactions t"
                + " JOIN household_members m ON m.household_id = t.household_id"
                + " AND m.user_id = :actorId"
                + " WHERE t.household_id = :householdId AND t.owner_user_id = :actorId"
                + " AND (:status = 'ALL' OR t.status = :status)");
    if (accountId != null) {
      sql.append(" AND t.account_id = :accountId");
    }
    if (currency != null) {
      sql.append(" AND t.currency = :currency");
    }
    if (from != null) {
      sql.append(" AND t.occurred_on >= :fromDate");
    }
    if (to != null) {
      sql.append(" AND t.occurred_on < :toDate");
    }
    sql.append(" ORDER BY t.occurred_on DESC, t.created_at DESC, t.id DESC");
    sql.append(" LIMIT :limit OFFSET :offset");

    Query query = entityManager.createNativeQuery(sql.toString(), FinancialTransactionEntity.class);
    query.setParameter("householdId", householdId);
    query.setParameter("actorId", actorId);
    query.setParameter("status", status);
    if (accountId != null) {
      query.setParameter("accountId", accountId);
    }
    if (currency != null) {
      query.setParameter("currency", currency);
    }
    if (from != null) {
      query.setParameter("fromDate", from);
    }
    if (to != null) {
      query.setParameter("toDate", to);
    }
    query.setParameter("limit", limit);
    query.setParameter("offset", offset);
    return (List<FinancialTransactionEntity>) query.getResultList();
  }

  /**
   * Loads the refund source under lock after reference access is resolved: missing and foreign
   * sources give the generic transaction 404, while a visible but invalid source surfaces the
   * semantic refund conflict before any state changes.
   */
  private FinancialTransactionEntity loadRefundSource(
      UUID householdId, UUID actorId, CreateValues values) {
    FinancialTransactionEntity source =
        transactions
            .findOwnedForUpdate(householdId, values.refundOfTransactionId(), actorId)
            .orElseThrow(TransactionNotFoundException::new);
    if (source.getKind() != TransactionKind.EXPENSE
        || source.getStatus() != TransactionStatus.POSTED
        || !source.getAccountId().equals(values.accountId())) {
      throw new RefundConflictException();
    }
    if (values.occurredOn().isBefore(source.getOccurredOn())) {
      throw new RefundConflictException();
    }
    if (values.rawVisibility() != null && !values.rawVisibility().equals(source.getVisibility())) {
      throw new ValidationFailedException(
          Map.of("visibility", "Refund visibility must match its expense."));
    }
    return source;
  }

  /**
   * Locks the source's live posted refunds in ascending UUID order and enforces the sum cap against
   * a proposed amount, where {@code replacedAmount} is an existing refund's amount being corrected
   * away (zero for a new refund).
   */
  private void checkRefundCap(
      FinancialTransactionEntity source, BigDecimal proposedAmount, BigDecimal replacedAmount) {
    BigDecimal liveSum =
        transactions.findLiveRefundsForUpdate(source.getId(), TransactionStatus.POSTED).stream()
            .map(FinancialTransactionEntity::getAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add)
            .subtract(replacedAmount);
    if (liveSum.add(proposedAmount).compareTo(source.getAmount().abs()) > 0) {
      throw new RefundConflictException();
    }
  }

  /** Expense corrections preserve the posted-refund bound and date ordering. */
  private void checkExpenseCorrectionBounds(
      FinancialTransactionEntity expense, BigDecimal nextAmount, LocalDate nextOccurredOn) {
    List<FinancialTransactionEntity> liveRefunds =
        transactions.findLiveRefundsForUpdate(expense.getId(), TransactionStatus.POSTED);
    BigDecimal liveSum =
        liveRefunds.stream()
            .map(FinancialTransactionEntity::getAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    if (nextAmount.abs().compareTo(liveSum) < 0) {
      throw new RefundConflictException();
    }
    for (FinancialTransactionEntity refund : liveRefunds) {
      if (nextOccurredOn.isAfter(refund.getOccurredOn())) {
        throw new RefundConflictException();
      }
    }
  }

  private void checkRefundGroupBounds(
      FinancialTransactionEntity transaction, BigDecimal nextAmount, LocalDate nextOccurredOn) {
    if (transaction.getKind() == TransactionKind.EXPENSE) {
      checkExpenseCorrectionBounds(transaction, nextAmount, nextOccurredOn);
    } else if (transaction.getKind() == TransactionKind.REFUND) {
      FinancialTransactionEntity source =
          transactions
              .findOwnedForUpdate(
                  transaction.getHouseholdId(),
                  transaction.getRefundOfTransactionId(),
                  transaction.getOwnerUserId())
              .orElseThrow(RefundConflictException::new);
      if (source.getStatus() != TransactionStatus.POSTED
          || nextOccurredOn.isBefore(source.getOccurredOn())) {
        throw new RefundConflictException();
      }
      checkRefundCap(source, nextAmount, transaction.getAmount());
    }
  }

  private CreateValues validateCreate(CreateFields raw) {
    Map<String, String> errors = new LinkedHashMap<>();
    UUID accountId = parseAccountId(raw.accountId(), errors);
    TransactionKind kind = parseKind(raw.kind(), errors);
    SupportedCurrency currency = parseCurrency(raw.currency(), errors);
    BigDecimal amount = null;
    if (currency != null) {
      amount = parseAmount(raw.amount(), currency, errors);
    }
    LocalDate occurredOn = parseOccurredOn(raw.occurredOn(), errors);
    String descriptionError = raw.description() == null ? "Enter a description." : null;
    if (descriptionError == null) {
      descriptionError = violation(raw.description()).orElse(null);
    }
    if (descriptionError != null) {
      errors.put("description", descriptionError);
    }
    if (raw.visibility() != null && !PRIVATE_VISIBILITY.equals(raw.visibility())) {
      errors.put("visibility", "Only private entries are accepted.");
    } else if (raw.visibilityPresent() && raw.visibility() == null) {
      // Explicit null is invalid for create fields; only omission carries the default.
      errors.put("visibility", "Choose an entry privacy.");
    }
    UUID refundOfTransactionId = null;
    if (kind == TransactionKind.REFUND) {
      if (raw.refundOfTransactionId() == null) {
        errors.put("refundOfTransactionId", "Choose the expense being refunded.");
      } else {
        try {
          refundOfTransactionId = UUID.fromString(raw.refundOfTransactionId());
        } catch (IllegalArgumentException rejected) {
          errors.put("refundOfTransactionId", "Choose the expense being refunded.");
        }
      }
    } else if (raw.refundOfTransactionIdPresent()) {
      // Supplying the refund-only field on any other kind, even as null, is invalid.
      errors.put("refundOfTransactionId", "Only refunds reference another entry.");
    }
    if (amount != null && kind != null) {
      checkSign(kind, amount, errors);
    }
    if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    return new CreateValues(
        accountId,
        kind,
        amount,
        currency,
        occurredOn,
        normalize(raw.description()),
        raw.visibility(),
        refundOfTransactionId);
  }

  private PatchValues validatePatch(PatchFields raw) {
    Map<String, String> errors = new LinkedHashMap<>();
    if (!raw.expectedVersionPresent()
        || raw.expectedVersion() == null
        || raw.expectedVersion() < 0) {
      errors.put("expectedVersion", "Provide the current transaction version.");
    }
    if (raw.moneyPresent() && (raw.moneyAmount() == null || raw.moneyCurrency() == null)) {
      // Partial money objects are invalid; only the missing nested fields are named.
      if (raw.moneyAmount() == null) {
        errors.put("money.amount", "Enter an amount.");
      }
      if (raw.moneyCurrency() == null) {
        errors.put("money.currency", "Choose a supported currency.");
      }
    }
    LocalDate occurredOn = null;
    if (raw.occurredOnPresent()) {
      occurredOn = parseOccurredOn(raw.occurredOn(), errors);
    }
    String description = null;
    if (raw.descriptionPresent()) {
      String descriptionError =
          raw.description() == null
              ? "Enter a description."
              : violation(raw.description()).orElse(null);
      if (descriptionError != null) {
        errors.put("description", descriptionError);
      } else {
        description = normalize(raw.description());
      }
    }
    if (raw.visibilityPresent()
        && (raw.visibility() == null || !PRIVATE_VISIBILITY.equals(raw.visibility()))) {
      errors.put("visibility", "Only private entries are accepted.");
    }
    if (raw.statusPresent()) {
      if (raw.status() == null || !"VOIDED".equals(raw.status())) {
        errors.put("status", "Only voided status is accepted.");
      }
      boolean otherMutableField =
          raw.moneyPresent()
              || raw.occurredOnPresent()
              || raw.descriptionPresent()
              || raw.visibilityPresent();
      if (otherMutableField) {
        errors.put("status", "Voiding accepts no other field.");
      }
    }
    if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    boolean anyFieldPresent =
        raw.moneyPresent()
            || raw.occurredOnPresent()
            || raw.descriptionPresent()
            || raw.visibilityPresent()
            || raw.statusPresent();
    if (!anyFieldPresent) {
      // Body-level rule with no real field to name; the shared shape omits empty fieldErrors.
      throw new ValidationFailedException(Map.of());
    }
    BigDecimal amount = null;
    SupportedCurrency currency = null;
    if (raw.moneyAmount() != null && raw.moneyCurrency() != null) {
      currency = parseCurrency(raw.moneyCurrency(), errors);
      if (currency != null) {
        amount = parseAmount(raw.moneyAmount(), currency, errors);
      }
      if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    }
    return new PatchValues(
        raw.expectedVersion(),
        amount,
        currency,
        occurredOn,
        description,
        raw.visibility(),
        raw.visibilityPresent(),
        raw.statusPresent());
  }

  private static UUID parseAccountId(String rawAccountId, Map<String, String> errors) {
    if (rawAccountId != null) {
      try {
        return UUID.fromString(rawAccountId);
      } catch (IllegalArgumentException rejected) {
        // Safe field error below.
      }
    }
    errors.put("accountId", "Choose an account.");
    return null;
  }

  private static TransactionKind parseKind(String value, Map<String, String> errors) {
    if (value != null) {
      try {
        return TransactionKind.valueOf(value);
      } catch (IllegalArgumentException rejected) {
        // Safe field error below.
      }
    }
    errors.put("kind", "Choose expense, income, refund, or transfer.");
    return null;
  }

  private static SupportedCurrency parseCurrency(String value, Map<String, String> errors) {
    if (value != null) {
      try {
        return SupportedCurrency.valueOf(value);
      } catch (IllegalArgumentException rejected) {
        // Safe field error below.
      }
    }
    errors.put("money.currency", "Choose a supported currency.");
    return null;
  }

  private static LocalDate parseOccurredOn(String rawOccurredOn, Map<String, String> errors) {
    if (rawOccurredOn == null) {
      errors.put("occurredOn", "Enter the transaction date.");
      return null;
    }
    try {
      LocalDate parsed = LocalDate.parse(rawOccurredOn);
      if (parsed.isBefore(MIN_OCCURRED_ON) || parsed.isAfter(MAX_OCCURRED_ON)) {
        throw new IllegalArgumentException();
      }
      return parsed;
    } catch (RuntimeException rejected) {
      errors.put("occurredOn", "Enter a supported date.");
      return null;
    }
  }

  /**
   * Canonical request fingerprint over normalized values only: equivalent money strings such as "1"
   * and "1.00" collapse after scale validation, omitted refund visibility stays an INHERIT
   * instruction rather than the source's mutable value, and omitted non-refund visibility
   * normalizes to PRIVATE.
   */
  private static String fingerprint(CreateValues values) {
    String visibility =
        values.kind() == TransactionKind.REFUND
            ? (values.rawVisibility() == null ? "INHERIT" : values.rawVisibility())
            : PRIVATE_VISIBILITY;
    String canonical =
        values.accountId()
            + "\u0000"
            + values.kind()
            + "\u0000"
            + toResponseString(values.amount(), values.currency())
            + "\u0000"
            + values.currency()
            + "\u0000"
            + values.occurredOn()
            + "\u0000"
            + values.description()
            + "\u0000"
            + visibility
            + "\u0000"
            + values.refundOfTransactionId();
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

  private static FinancialTransactionResponse toResponse(FinancialTransactionEntity transaction) {
    return new FinancialTransactionResponse(
        transaction.getId(),
        transaction.getHouseholdId(),
        transaction.getOwnerUserId(),
        transaction.getAccountId(),
        transaction.getKind().name(),
        new FinancialTransactionResponse.MoneyResponse(
            toResponseString(transaction.getAmount(), transaction.getCurrency()),
            transaction.getCurrency().name()),
        transaction.getOccurredOn().toString(),
        transaction.getDescription(),
        transaction.getVisibility(),
        transaction.getSource(),
        transaction.getStatus().name(),
        transaction.getRefundOfTransactionId(),
        transaction.getVersion(),
        transaction.getCreatedAt(),
        transaction.getUpdatedAt());
  }

  private record CreateValues(
      UUID accountId,
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String rawVisibility,
      UUID refundOfTransactionId) {}

  private record PatchValues(
      int expectedVersion,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String visibility,
      boolean visibilityPresent,
      boolean statusPresent) {}
}
