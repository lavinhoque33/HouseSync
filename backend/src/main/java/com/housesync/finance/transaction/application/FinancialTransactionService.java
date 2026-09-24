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
import com.housesync.finance.categorization.application.CategorizationReviewService;
import com.housesync.finance.categorization.application.CategorizationRuleLookup;
import com.housesync.finance.categorization.application.CategorizationRuleLookup.OwnerRuleMatch;
import com.housesync.finance.categorization.domain.CategorizationClassifier;
import com.housesync.finance.categorization.domain.CategorizationMatchKeys;
import com.housesync.finance.categorization.domain.CategorizationOrigin;
import com.housesync.finance.transaction.domain.AllocationStatus;
import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import com.housesync.finance.transaction.persistence.FinancialTransactionAllocationRepository;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.finance.transaction.persistence.TransactionIdempotencyEntity;
import com.housesync.finance.transaction.persistence.TransactionIdempotencyKey;
import com.housesync.finance.transaction.persistence.TransactionIdempotencyRepository;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AccountArchivedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.RefundConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionForbiddenException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionIdempotencyConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionExhaustedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVoidedException;
import com.housesync.finance.transaction.web.FinancialTransactionListResponse;
import com.housesync.finance.transaction.web.FinancialTransactionResponse;
import com.housesync.finance.transaction.web.TransactionCategoryListResponse;
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
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Manual transaction use cases. Entries are versioned, category-aware, and either private
 * or disclosed to the whole household. Every mutation serializes with household membership
 * lifecycle through {@link HouseholdService#lockForFinance}, and refund-group operations lock their
 * source expense first and the linked refund rows in ascending UUID order.
 *
 * <p>Sharing rules: only the financial owner mutates an entry; another current member reads a
 * {@code HOUSEHOLD} entry with the account reference redacted, while a private entry stays a
 * generic 404 for them. Expense category/visibility patches propagate atomically to every linked
 * refund, including retained voided refunds, and any state-changing refund create/correct/void
 * bumps its source expense version and timestamp once so stale expense forms conflict.
 */
@Service
public class FinancialTransactionService {

  private static final String CREATE_OPERATION = "TRANSACTION_CREATE";
  private static final String PRIVATE_VISIBILITY = "PRIVATE";
  private static final String HOUSEHOLD_VISIBILITY = "HOUSEHOLD";
  private static final String HOUSEHOLD_VIEW = "HOUSEHOLD";
  private static final LocalDate MIN_OCCURRED_ON = LocalDate.of(1900, 1, 1);
  private static final LocalDate MAX_OCCURRED_ON = LocalDate.of(9999, 12, 30);

  private final FinancialTransactionRepository transactions;
  private final TransactionIdempotencyRepository idempotency;
  private final FinancialAccountRepository accounts;
  private final FinancialTransactionAllocationRepository allocations;
  private final HouseholdService households;
  private final CategorizationRuleLookup categorizationRules;
  private final Clock clock;
  private final EntityManager entityManager;
  private final ObjectProvider<CategorizationReviewService> reviews;

  public FinancialTransactionService(
      FinancialTransactionRepository transactions,
      TransactionIdempotencyRepository idempotency,
      FinancialAccountRepository accounts,
      FinancialTransactionAllocationRepository allocations,
      HouseholdService households,
      CategorizationRuleLookup categorizationRules,
      Clock clock,
      EntityManager entityManager,
      ObjectProvider<CategorizationReviewService> reviews) {
    this.transactions = transactions;
    this.idempotency = idempotency;
    this.accounts = accounts;
    this.allocations = allocations;
    this.households = households;
    this.categorizationRules = categorizationRules;
    this.clock = clock;
    this.entityManager = entityManager;
    this.reviews = reviews;
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
      String category,
      boolean categoryPresent,
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
    if (!"MANUAL".equals(account.getSource())) {
      // Manual transaction entry stays MANUAL-only: CONNECTED accounts are
      // admitted only through bank-activity confirmation.
      throw new ValidationFailedException(Map.of("accountId", "Choose a manual account."));
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
    String visibility =
        values.kind() == TransactionKind.REFUND
            ? source.getVisibility()
            : (values.rawVisibility() == null ? PRIVATE_VISIBILITY : values.rawVisibility());
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
            visibility,
            /* category placeholder; the initial assignment below decides */ null,
            source == null ? null : source.getId(),
            "MANUAL",
            CategorizationOrigin.NONE,
            now,
            now);
    if (values.kind() == TransactionKind.REFUND) {
      // Refunds never classify independently: they inherit the source expense's effective
      // category and carry the INHERITED origin with no rule or mapping reference.
      transaction.inheritedFrom(source.getCategory(), now);
    } else if (values.category() != null) {
      // An explicit supported token is a user decision; automation never runs.
      transaction.userAssigned(values.category().name(), now);
    } else {
      // Omitted and explicit-null are the same classifier-eligible instruction (the accepted
      // idempotency equivalence); an exact owner rule applies ahead of any provider mapping,
      // otherwise NONE. Manual entries carry no provider evidence, so only a description-keyed
      // owner rule can match.
      categorizeNewEntry(transaction, householdId, actorId, null, null, null, null, now);
    }
    transactions.save(transaction);
    if (transaction.getCategoryOrigin() == CategorizationOrigin.NONE) {
      reviews.getObject().suggestNew(transaction, null);
    }
    idempotency.save(new TransactionIdempotencyEntity(key, fingerprint, transaction.getId(), now));
    if (source != null) {
      // A state-changing refund create moves its source expense version once, so a stale
      // expense form cannot later share or re-disclose an unaware refund group.
      bumpRefundSource(source, now);
    }
    transactions.flush();
    idempotency.flush();
    return new CreateResult(toResponse(transaction), false);
  }

  /** Normalized admission input for one confirmed bank observation. */
  public record ConnectedAdmission(
      UUID accountId,
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String rawCategory,
      boolean categoryPresent,
      UUID refundOfTransactionId,
      boolean acknowledgeDisclosure,
      String observationMerchantIdentityDigest,
      String observationPfcPrimaryCode,
      String observationPfcDetailCode,
      String observationEvidenceFingerprint) {}

  /**
   * One-time CONNECTED ledger admission behind bank-activity confirmation. Runs inside the caller's
   * transaction after the household/connection locks are already held, then takes the account lock
   * followed by the refund source and its live refund rows in the documented order. A CONNECTED
   * refund must reference a posted CONNECTED expense in the exact same local account, household,
   * owner, and currency; sharing a HOUSEHOLD source requires an explicit disclosure
   * acknowledgement. The caller owns the association insert and observation state change in the
   * same transaction.
   */
  @Transactional
  public FinancialTransactionEntity admitConnected(
      UUID householdId, UUID actorId, ConnectedAdmission admission) {
    households.lockForFinance(householdId, actorId);
    FinancialAccountEntity account =
        accounts
            .findOwnedForUpdate(householdId, admission.accountId(), actorId)
            .orElseThrow(FinancialAccountNotFoundException::new);
    if (account.getStatus() == FinancialAccountStatus.ARCHIVED) {
      throw new AccountArchivedException();
    }
    if (!"CONNECTED".equals(account.getSource())) {
      throw new ValidationFailedException(Map.of("accountId", "Choose a connected account."));
    }
    if (account.getCurrency() != admission.currency()) {
      throw new ValidationFailedException(
          Map.of("money.currency", "The bank account currency no longer matches."));
    }
    FinancialTransactionEntity source = null;
    if (admission.kind() == TransactionKind.REFUND) {
      source = loadConnectedRefundSource(householdId, actorId, admission);
    }
    Instant now = now();
    String visibility =
        admission.kind() == TransactionKind.REFUND ? source.getVisibility() : PRIVATE_VISIBILITY;
    FinancialTransactionEntity transaction =
        FinancialTransactionEntity.connected(
            UUID.randomUUID(),
            householdId,
            actorId,
            account.getId(),
            admission.kind(),
            admission.amount(),
            admission.currency(),
            admission.occurredOn(),
            admission.description(),
            visibility,
            /* category placeholder; the initial assignment below decides */ null,
            source == null ? null : source.getId(),
            now);
    if (admission.kind() == TransactionKind.REFUND) {
      // Refunds inherit exactly like the manual path: no independent classification.
      transaction.inheritedFrom(source.getCategory(), now);
    } else if (admission.categoryPresent() && admission.rawCategory() != null) {
      // An explicit supported token at confirmation time is a user decision.
      transaction.userAssigned(admission.rawCategory(), now);
    } else {
      // Omitted or explicit-null at confirmation: deterministic classification from the
      // observation's stored provider evidence, with the exact owner rule matching first.
      categorizeNewEntry(
          transaction,
          householdId,
          actorId,
          admission.observationMerchantIdentityDigest(),
          admission.observationPfcPrimaryCode(),
          admission.observationPfcDetailCode(),
          admission.observationEvidenceFingerprint(),
          now);
    }
    transactions.save(transaction);
    if (transaction.getCategoryOrigin() == CategorizationOrigin.NONE) {
      reviews.getObject().suggestNew(transaction, admission.observationEvidenceFingerprint());
    }
    if (source != null) {
      // A state-changing refund admission moves its source expense version once, exactly like a
      // manual refund create.
      bumpRefundSource(source, now);
    }
    transactions.flush();
    return transaction;
  }

  /**
   * Deterministic assignment for one classifier-eligible new posted non-refund row, applying the
   * ADR precedence exactly (categorization contract §3): an exact active owner rule beats the
   * versioned provider mapping; no match leaves the row uncategorized with {@code NONE} — never a
   * default token. The rule key is derived server-side from the entry's own retained evidence, and
   * the lookup is scoped by household and financial owner in SQL. The assignment is part of the
   * entry's initial state: one transaction at version 0, no extra version bump.
   */
  private void categorizeNewEntry(
      FinancialTransactionEntity transaction,
      UUID householdId,
      UUID ownerId,
      String merchantIdentityDigest,
      String pfcPrimaryCode,
      String pfcDetailCode,
      String evidenceFingerprint,
      Instant assignedAt) {
    var ownerRule =
        CategorizationMatchKeys.derive(
                transaction.getKind(), transaction.getDescription(), merchantIdentityDigest)
            .flatMap(key -> categorizationRules.findActiveMatch(householdId, ownerId, key));
    if (ownerRule.isPresent()) {
      OwnerRuleMatch matched = ownerRule.get();
      transaction.initiallyCategorized(
          CategorizationOrigin.OWNER_RULE,
          matched.category(),
          matched.rulesetVersion(),
          matched.ruleId(),
          evidenceFingerprint,
          assignedAt);
      return;
    }
    var assignment =
        CategorizationClassifier.classify(pfcPrimaryCode, pfcDetailCode, transaction.getKind());
    if (assignment.isPresent()) {
      transaction.initiallyCategorized(
          CategorizationOrigin.PROVIDER,
          assignment.get().category().name(),
          assignment.get().rulesetVersion(),
          null,
          evidenceFingerprint,
          assignedAt);
    } else {
      transaction.initiallyCategorized(
          CategorizationOrigin.NONE, null, null, null, evidenceFingerprint, assignedAt);
    }
  }

  /**
   * Owner-locked source entry for a categorization rule (categorization contract §4). The
   * caller already holds the household lifecycle lock, so this only takes the owned row lock and
   * compares the caller's version token there; rule eligibility (posted non-refund USER with a
   * non-null category) stays in the categorization domain.
   */
  public FinancialTransactionEntity loadForCategorizationRule(
      UUID householdId, UUID transactionId, UUID actorId, int expectedTransactionVersion) {
    FinancialTransactionEntity transaction =
        transactions
            .findOwnedForUpdate(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    if (transaction.getVersion() != expectedTransactionVersion) {
      throw new TransactionVersionConflictException();
    }
    return transaction;
  }

  /** Canonical household/account/expense lock order for an owner-private review decision. */
  public FinancialTransactionEntity lockForCategorizationReview(
      UUID householdId, UUID transactionId, UUID actorId) {
    FinancialTransactionEntity peek =
        transactions
            .findOwnedScoped(householdId, transactionId, actorId)
            .orElseThrow(TransactionNotFoundException::new);
    accounts
        .findOwnedForUpdate(householdId, peek.getAccountId(), actorId)
        .orElseThrow(FinancialAccountNotFoundException::new);
    return transactions
        .findOwnedForUpdate(householdId, transactionId, actorId)
        .orElseThrow(TransactionNotFoundException::new);
  }

  private FinancialTransactionEntity loadConnectedRefundSource(
      UUID householdId, UUID actorId, ConnectedAdmission admission) {
    if (admission.refundOfTransactionId() == null) {
      throw new ValidationFailedException(
          Map.of("refundOfTransactionId", "Choose the connected expense being refunded."));
    }
    FinancialTransactionEntity source =
        transactions
            .findOwnedForUpdate(householdId, admission.refundOfTransactionId(), actorId)
            .orElseThrow(RefundConflictException::new);
    if (source.getKind() != TransactionKind.EXPENSE
        || source.getStatus() != TransactionStatus.POSTED
        || !"CONNECTED".equals(source.getSource())
        || !source.getAccountId().equals(admission.accountId())
        || source.getCurrency() != admission.currency()) {
      throw new RefundConflictException();
    }
    if (admission.occurredOn().isBefore(source.getOccurredOn())) {
      throw new RefundConflictException();
    }
    if ("HOUSEHOLD".equals(source.getVisibility()) && !admission.acknowledgeDisclosure()) {
      throw new ValidationFailedException(
          Map.of(
              "acknowledgeDisclosure", "Confirm that this refund is shared with the household."));
    }
    if (admission.categoryPresent()
        && !Objects.equals(admission.rawCategory(), source.getCategory())) {
      throw new ValidationFailedException(
          Map.of("category", "Refund category must match its expense."));
    }
    checkRefundCap(source, admission.amount(), BigDecimal.ZERO);
    return source;
  }

  @Transactional(readOnly = true)
  public TransactionCategoryListResponse listCategories(UUID householdId, UUID actorId) {
    // A bounded fixed list, not a paginated collection; only the closed enum feeds it.
    households.requireFinanceMembership(householdId, actorId);
    return new TransactionCategoryListResponse(
        Arrays.stream(TransactionCategory.values())
            .map(
                category ->
                    new TransactionCategoryListResponse.Item(category.name(), category.label()))
            .toList());
  }

  @Transactional(readOnly = true)
  public FinancialTransactionListResponse list(
      UUID householdId,
      UUID actorId,
      String view,
      String status,
      UUID accountId,
      String currency,
      LocalDate from,
      LocalDate to,
      int limit,
      int offset) {
    if (HOUSEHOLD_VIEW.equals(view)) {
      // Household feed: only HOUSEHOLD entries from any owner, including departed owners;
      // the membership join is the authorization, and every filter applies in SQL.
      List<FinancialTransactionEntity> page =
          findHouseholdPage(householdId, actorId, status, currency, from, to, limit + 1, offset);
      if (page.isEmpty()) {
        // Preserve missing/non-member equivalence without a separate broad transaction read.
        households.requireFinanceMembership(householdId, actorId);
      }
      boolean hasMore = page.size() > limit;
      List<FinancialTransactionResponse> items =
          page.stream()
              .limit(limit)
              .map(
                  transaction ->
                      toResponse(transaction, !transaction.getOwnerUserId().equals(actorId)))
              .toList();
      return new FinancialTransactionListResponse(items, limit, offset, hasMore);
    }

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
        .findVisibleScoped(householdId, transactionId, actorId)
        .map(transaction -> toResponse(transaction, !transaction.getOwnerUserId().equals(actorId)))
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
      String category,
      boolean categoryPresent,
      String status,
      boolean statusPresent) {}

  @Transactional
  public FinancialTransactionResponse patch(
      UUID householdId, UUID transactionId, UUID actorId, PatchFields raw) {
    PatchValues values = validatePatch(raw);
    households.lockForFinance(householdId, actorId);
    // Pre-read under the household lifecycle lock (no concurrent finance mutation can
    // commit while it is held) through the authorized scope: own entry at any visibility,
    // or a household-disclosed entry. A visible row owned by someone else answers the
    // 403 before any resource state or lock is taken; a miss falls back to membership
    // to separate the resource 404 from the household 404.
    FinancialTransactionEntity peek =
        transactions
            .findVisibleScoped(householdId, transactionId, actorId)
            .orElseGet(
                () -> {
                  households.requireFinanceMembership(householdId, actorId);
                  throw new TransactionNotFoundException();
                });
    if (!peek.getOwnerUserId().equals(actorId)) {
      // Sharing authorizes reading only; mutation stays financial-owner-only.
      throw new TransactionForbiddenException();
    }
    // Row locks in the documented deterministic order: household/account context, source
    // expense first, then all linked refund rows in ascending UUID order, with the patched
    // row selected from the locked set. expectedVersion is compared only after the relevant
    // rows are locked.
    accounts
        .findOwnedForUpdate(householdId, peek.getAccountId(), actorId)
        .orElseThrow(FinancialAccountNotFoundException::new);
    FinancialTransactionEntity source = null;
    FinancialTransactionEntity transaction;
    if (peek.getKind() == TransactionKind.REFUND) {
      // Refund-group operations lock the source expense before any refund UUID; the ordered
      // group lock covers posted and voided members, so a correction, a void, and a retained
      // no-op all observe the same acquisition sequence.
      source =
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
    // Refund disclosure is inherited through the whole linked group; a direct patch is never
    // accepted in any state.
    if (values.visibilityPresent() && transaction.getKind() == TransactionKind.REFUND) {
      throw new ValidationFailedException(
          Map.of("visibility", "Refund visibility follows its expense."));
    }
    if (values.categoryPresent() && transaction.getKind() == TransactionKind.REFUND) {
      throw new ValidationFailedException(
          Map.of("category", "Refund category follows its expense."));
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
      Instant now = now();
      if (transaction.getKind() == TransactionKind.EXPENSE) {
        // Voiding the expense deactivates its active allocation in this same transaction,
        // after the linked refund rows were locked in ascending UUID order. The voided
        // expense and its deactivated allocation contribute nothing to derived balances.
        allocations
            .findActiveForUpdate(transaction.getId(), AllocationStatus.ACTIVE)
            .ifPresent(allocation -> allocation.revoked(now));
      }
      transaction.voided(now);
      reviews.getObject().supersede(householdId, actorId, transaction.getId());
      if (source != null) {
        bumpRefundSource(source, now);
      }
      transactions.saveAndFlush(transaction);
      return toResponse(transaction);
    }

    if (transaction.getStatus() == TransactionStatus.VOIDED) {
      boolean categoryChanges =
          values.categoryPresent() && !Objects.equals(values.category(), transaction.getCategory());
      boolean economicEdit =
          values.currency() != null
              || values.occurredOn() != null
              || values.description() != null
              || categoryChanges;
      if (economicEdit) {
        // Voided economic fields cannot be edited or restored; a same-value category touch
        // is a no-op like a same-value visibility touch.
        throw new TransactionVoidedException();
      }
      // A visibility-only patch on a retained voided entry stays allowed in C. A repeated
      // category value may also record the user's authoritative provenance decision without
      // changing the retained economic category.
    }

    BigDecimal nextAmount = transaction.getAmount();
    LocalDate nextOccurredOn = transaction.getOccurredOn();
    String nextDescription = transaction.getDescription();
    String nextVisibility = transaction.getVisibility();
    String nextCategory = transaction.getCategory();
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
    if (values.visibility() != null) {
      nextVisibility = values.visibility();
    }
    if (values.categoryPresent()) {
      nextCategory = values.category();
    }

    boolean amountChanged = nextAmount.compareTo(transaction.getAmount()) != 0;
    boolean dateChanged = !nextOccurredOn.equals(transaction.getOccurredOn());
    boolean descriptionChanged = !nextDescription.equals(transaction.getDescription());
    boolean visibilityChanged = !nextVisibility.equals(transaction.getVisibility());
    boolean categoryChanged = !Objects.equals(nextCategory, transaction.getCategory());
    // A category field decision is authoritative even when it repeats the stored token: when the
    // prior origin was automated (OWNER_RULE/PROVIDER), NONE, or LEGACY, recording USER is a
    // real provenance change and bumps the version like any other value change. Repeating the
    // same category while origin is already USER stays the accepted no-op. A retained voided
    // entry may change provenance, but never its effective category.
    boolean originChangesToUser =
        values.categoryPresent() && transaction.getCategoryOrigin() != CategorizationOrigin.USER;
    if (!amountChanged
        && !dateChanged
        && !descriptionChanged
        && !visibilityChanged
        && !categoryChanged
        && !originChangesToUser) {
      // Authorized no-op returns the unchanged representation without a version bump.
      return toResponse(transaction);
    }

    if (transaction.getKind() == TransactionKind.EXPENSE
        && (amountChanged || (visibilityChanged && PRIVATE_VISIBILITY.equals(nextVisibility)))
        && allocations
            .findActiveByTransactionId(transaction.getId(), AllocationStatus.ACTIVE)
            .isPresent()) {
      // An active allocation freezes what participants owe: privacy revocation and money
      // correction would rewrite recorded shares, so both are blocked until the allocation
      // is revoked. Description, occurredOn, and category changes never affect shares.
      // This allocation read is deliberately unlocked and stays race-free only because every
      // allocation writer (allocation create, revoke, expense void) holds this same expense
      // row lock under the household lifecycle lock before writing allocation rows, so no
      // uncommitted allocation change can be in flight while the locked row is patched.
      throw new AllocationConflictException();
    }

    if (amountChanged || dateChanged) {
      checkRefundGroupBounds(transaction, nextAmount, nextOccurredOn);
    }
    // Disclosure changes on a non-refund entry propagate to every linked refund, including
    // retained voided refunds, in this same transaction. Refund rows are locked after the
    // source expense in ascending UUID order; each refund whose value changes is versioned
    // exactly like a direct patch would have been.
    List<FinancialTransactionEntity> group = List.of();
    boolean groupPropagation =
        (visibilityChanged || categoryChanged) && transaction.getKind() != TransactionKind.REFUND;
    if (groupPropagation) {
      group = transactions.findGroupForUpdate(transaction.getId());
      for (FinancialTransactionEntity refund : group) {
        boolean refundChanges =
            (visibilityChanged && !nextVisibility.equals(refund.getVisibility()))
                || (categoryChanged && !Objects.equals(nextCategory, refund.getCategory()));
        if (refundChanges && refund.getVersion() == Integer.MAX_VALUE) {
          throw new TransactionVersionExhaustedException();
        }
      }
    }
    if (transaction.getVersion() == Integer.MAX_VALUE) {
      throw new TransactionVersionExhaustedException();
    }
    Instant now = now();
    transaction.correct(
        nextAmount, nextOccurredOn, nextDescription, nextCategory, nextVisibility, now);
    if (values.categoryPresent()) {
      // The explicit category field decision records USER and clears automated references.
      // Refunds never reach here: a direct refund category patch is rejected earlier. A voided
      // entry may record provenance only when the effective category value is unchanged.
      transaction.userAssigned(nextCategory, now);
      reviews.getObject().supersede(householdId, actorId, transaction.getId());
    }
    if (source != null) {
      // A state-changing refund correction bumps its source expense version once.
      bumpRefundSource(source, now);
    }
    if (groupPropagation) {
      for (FinancialTransactionEntity refund : group) {
        boolean refundChanges =
            (visibilityChanged && !nextVisibility.equals(refund.getVisibility()))
                || (categoryChanged && !Objects.equals(nextCategory, refund.getCategory()));
        if (refundChanges) {
          refund.groupChanged(nextCategory, nextVisibility, now);
        }
      }
    }
    if (!values.categoryPresent() && transaction.getKind() != TransactionKind.REFUND) {
      reviews.getObject().ledgerChanged(transaction, descriptionChanged);
    }
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
    bindCommonFilters(query, currency, from, to, limit, offset);
    return (List<FinancialTransactionEntity>) query.getResultList();
  }

  /**
   * Household feed page: every owner's {@code HOUSEHOLD} entry in the household, including departed
   * owners, scoped and filtered in SQL. The actor's membership is the only membership join, so
   * owner departure never hides shared history.
   */
  private List<FinancialTransactionEntity> findHouseholdPage(
      UUID householdId,
      UUID actorId,
      String status,
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
                + " WHERE t.household_id = :householdId AND t.visibility = 'HOUSEHOLD'"
                + " AND (:status = 'ALL' OR t.status = :status)");
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
    bindCommonFilters(query, currency, from, to, limit, offset);
    return (List<FinancialTransactionEntity>) query.getResultList();
  }

  private void bindCommonFilters(
      Query query, String currency, LocalDate from, LocalDate to, int limit, int offset) {
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
  }

  /**
   * Loads the refund source under lock after reference access is resolved: missing and foreign
   * sources give the generic transaction 404, while a visible but invalid source surfaces the
   * semantic refund conflict before any state changes. Refund visibility and category inheritance
   * are validated against the source's current values.
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
    if (values.categoryPresent() && !Objects.equals(values.rawCategory(), source.getCategory())) {
      // Omission inherits; explicit null is a mismatch unless the source is uncategorized.
      throw new ValidationFailedException(
          Map.of("category", "Refund category must match its expense."));
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

  /** Source-expense version exhaustion fails safely before any refund-group change commits. */
  private void bumpRefundSource(FinancialTransactionEntity source, Instant now) {
    if (source.getVersion() == Integer.MAX_VALUE) {
      throw new TransactionVersionExhaustedException();
    }
    source.refunded(now);
    reviews.getObject().ledgerChanged(source, false);
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
    if (raw.visibility() != null
        && !PRIVATE_VISIBILITY.equals(raw.visibility())
        && !HOUSEHOLD_VISIBILITY.equals(raw.visibility())) {
      errors.put("visibility", "Choose a supported entry privacy.");
    } else if (raw.visibilityPresent() && raw.visibility() == null) {
      // Explicit null is invalid for create fields; only omission carries the default.
      errors.put("visibility", "Choose an entry privacy.");
    }
    TransactionCategory category = null;
    if (raw.categoryPresent() && raw.category() != null) {
      try {
        category = TransactionCategory.valueOf(raw.category());
      } catch (IllegalArgumentException rejected) {
        // Unknown, lowercase-mismatched, or empty tokens share one safe field error.
        errors.put("category", "Choose a supported category.");
      }
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
        raw.visibilityPresent(),
        raw.category(),
        raw.categoryPresent(),
        category,
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
        && (raw.visibility() == null
            || (!PRIVATE_VISIBILITY.equals(raw.visibility())
                && !HOUSEHOLD_VISIBILITY.equals(raw.visibility())))) {
      errors.put("visibility", "Choose a supported entry privacy.");
    }
    String category = null;
    if (raw.categoryPresent() && raw.category() != null) {
      try {
        category = TransactionCategory.valueOf(raw.category()).name();
      } catch (IllegalArgumentException rejected) {
        errors.put("category", "Choose a supported category.");
      }
    }
    if (raw.statusPresent()) {
      if (raw.status() == null || !"VOIDED".equals(raw.status())) {
        errors.put("status", "Only voided status is accepted.");
      }
      boolean otherMutableField =
          raw.moneyPresent()
              || raw.occurredOnPresent()
              || raw.descriptionPresent()
              || raw.visibilityPresent()
              || raw.categoryPresent();
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
            || raw.categoryPresent()
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
        category,
        raw.categoryPresent(),
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
   * and "1.00" collapse after scale validation. Visibility records an inheritance instruction for
   * omitted refund visibility and normalizes omission to PRIVATE for non-refunds. Category records
   * an inheritance instruction for omitted refund category, a null instruction for explicit null
   * (the one field where the contract permits explicit null), and normalizes omitted and
   * explicit-null non-refund category to uncategorized.
   */
  private static String fingerprint(CreateValues values) {
    String visibility =
        values.kind() == TransactionKind.REFUND
            ? (values.rawVisibility() == null ? "INHERIT" : values.rawVisibility())
            : (values.rawVisibility() == null ? PRIVATE_VISIBILITY : values.rawVisibility());
    String category;
    if (values.kind() == TransactionKind.REFUND) {
      category =
          values.categoryPresent()
              ? (values.rawCategory() == null ? "NULL" : values.rawCategory())
              : "INHERIT";
    } else {
      category = values.category() == null ? "UNCATEGORIZED" : values.category().name();
    }
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
            + category
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
    return toResponse(transaction, false);
  }

  /** Redacts the account reference for a non-owner reading a household-disclosed entry. */
  private static FinancialTransactionResponse toResponse(
      FinancialTransactionEntity transaction, boolean redactAccountId) {
    return new FinancialTransactionResponse(
        transaction.getId(),
        transaction.getHouseholdId(),
        transaction.getOwnerUserId(),
        redactAccountId ? null : transaction.getAccountId(),
        transaction.getKind().name(),
        new FinancialTransactionResponse.MoneyResponse(
            toResponseString(transaction.getAmount(), transaction.getCurrency()),
            transaction.getCurrency().name()),
        transaction.getOccurredOn().toString(),
        transaction.getDescription(),
        transaction.getCategory(),
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
      boolean visibilityPresent,
      String rawCategory,
      boolean categoryPresent,
      TransactionCategory category,
      UUID refundOfTransactionId) {}

  private record PatchValues(
      int expectedVersion,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String visibility,
      boolean visibilityPresent,
      String category,
      boolean categoryPresent,
      boolean statusPresent) {}
}
