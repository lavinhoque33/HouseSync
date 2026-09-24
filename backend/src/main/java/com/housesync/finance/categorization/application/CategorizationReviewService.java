package com.housesync.finance.categorization.application;

import com.housesync.finance.categorization.domain.CategorizationClassifier;
import com.housesync.finance.categorization.domain.CategorizationHeuristic;
import com.housesync.finance.categorization.domain.CategorizationMatchKeys;
import com.housesync.finance.categorization.domain.CategorizationOrigin;
import com.housesync.finance.categorization.persistence.CategorizationReviewEntity;
import com.housesync.finance.categorization.persistence.CategorizationReviewIdempotency;
import com.housesync.finance.categorization.persistence.CategorizationReviewIdempotencyRepository;
import com.housesync.finance.categorization.persistence.CategorizationReviewRepository;
import com.housesync.finance.categorization.persistence.ReviewIdempotencyKey;
import com.housesync.finance.categorization.web.CategorizationReviewListResponse;
import com.housesync.finance.categorization.web.CategorizationReviewNotFoundException;
import com.housesync.finance.categorization.web.CategorizationReviewResolveRequest;
import com.housesync.finance.categorization.web.CategorizationReviewResponse;
import com.housesync.finance.categorization.web.CategorizationReviewVersionConflictException;
import com.housesync.finance.transaction.application.FinancialTransactionService;
import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionIdempotencyConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionResponse;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import jakarta.persistence.EntityManager;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owner-only suggestions; all writes participate in the ledger transaction and never assign a
 * category.
 */
@Service
public class CategorizationReviewService {
  private final CategorizationReviewRepository reviews;
  private final CategorizationReviewIdempotencyRepository idempotency;
  private final FinancialTransactionRepository transactions;
  private final FinancialTransactionService ledger;
  private final HouseholdService households;
  private final CategorizationRuleLookup rules;
  private final EntityManager entityManager;
  private final Clock clock;

  public CategorizationReviewService(
      CategorizationReviewRepository reviews,
      CategorizationReviewIdempotencyRepository idempotency,
      FinancialTransactionRepository transactions,
      FinancialTransactionService ledger,
      HouseholdService households,
      EntityManager entityManager,
      Clock clock,
      CategorizationRuleLookup rules) {
    this.reviews = reviews;
    this.idempotency = idempotency;
    this.transactions = transactions;
    this.ledger = ledger;
    this.households = households;
    this.entityManager = entityManager;
    this.clock = clock;
    this.rules = rules;
  }

  /** Called after the new transaction is inserted, inside the create/confirm transaction. */
  @Transactional(propagation = Propagation.MANDATORY)
  public void suggestNew(FinancialTransactionEntity entry, String providerEvidence) {
    propose(entry, providerEvidence, false);
  }

  /**
   * Sync evidence changes never rewrite a ledger category, transaction version or bank revision.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public void changedEvidence(
      UUID household,
      UUID owner,
      UUID transactionId,
      String providerEvidence,
      String merchantIdentityDigest,
      String primaryCode,
      String detailCode) {
    FinancialTransactionEntity entry =
        transactions.findOwnedForUpdate(household, transactionId, owner).orElse(null);
    if (entry == null) return;
    boolean hasExactAssignment =
        CategorizationMatchKeys.derive(
                    entry.getKind(), entry.getDescription(), merchantIdentityDigest)
                .flatMap(key -> rules.findActiveMatch(household, owner, key))
                .isPresent()
            || CategorizationClassifier.classify(primaryCode, detailCode, entry.getKind())
                .isPresent();
    propose(entry, providerEvidence, hasExactAssignment);
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void changedObservationEvidence(
      UUID household,
      UUID owner,
      UUID observationId,
      String providerEvidence,
      String merchantIdentityDigest,
      String primaryCode,
      String detailCode) {
    UUID transactionId = associatedTransaction(household, owner, observationId);
    if (transactionId != null)
      changedEvidence(
          household,
          owner,
          transactionId,
          providerEvidence,
          merchantIdentityDigest,
          primaryCode,
          detailCode);
  }

  /**
   * Non-posted admitted observation evidence invalidates OPEN work, never confirmed ledger data.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public void observationBecameIneligible(UUID household, UUID owner, UUID observationId) {
    UUID transactionId = associatedTransaction(household, owner, observationId);
    if (transactionId == null) return;
    FinancialTransactionEntity entry =
        transactions.findOwnedForUpdate(household, transactionId, owner).orElse(null);
    if (entry != null) supersede(household, owner, entry.getId());
  }

  private UUID associatedTransaction(UUID household, UUID owner, UUID observationId) {
    @SuppressWarnings("unchecked")
    List<UUID> transactionIds =
        entityManager
            .createNativeQuery(
                "SELECT a.transaction_id FROM connection_ledger_associations a"
                    + " JOIN household_members m ON m.household_id = a.household_id"
                    + " AND m.user_id = :owner WHERE a.observation_id = :observation"
                    + " AND a.household_id = :household AND a.owner_user_id = :owner"
                    + " AND a.state = 'CURRENT'")
            .setParameter("household", household)
            .setParameter("owner", owner)
            .setParameter("observation", observationId)
            .getResultList();
    return transactionIds.isEmpty() ? null : transactionIds.getFirst();
  }

  /**
   * Called only after an authorized ledger version bump while its canonical account/expense locks
   * are held. An unchanged evidence revision remains actionable with a fresh pair of versions;
   * changed evidence closes the old item and creates at most one eligible successor.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public void ledgerChanged(FinancialTransactionEntity entry, boolean descriptionChanged) {
    var open = reviews.findOwnedOpen(entry.getHouseholdId(), entry.getOwnerUserId(), entry.getId());
    if (open.isEmpty() && !descriptionChanged) return;
    if (entry.getStatus() != TransactionStatus.POSTED
        || entry.getKind() == TransactionKind.REFUND
        || entry.getCategoryOrigin() == CategorizationOrigin.USER
        || entry.getCategoryOrigin() == CategorizationOrigin.LEGACY) {
      open.ifPresent(item -> item.close("SUPERSEDED", now()));
      return;
    }
    CurrentEvidence evidence = currentEvidence(entry);
    if (evidence == null) {
      open.ifPresent(item -> item.close("SUPERSEDED", now()));
      return;
    }
    if (open.isPresent()) {
      CategorizationReviewEntity item = open.get();
      String actual =
          hash(
              entry.getKind()
                  + "\0"
                  + entry.getDescription()
                  + "\0"
                  + evidence.fingerprint()
                  + "\0"
                  + item.getPolicyVersion());
      if (actual.equals(item.getEvidenceFingerprint())) {
        item.advanceEvaluation(entry.getVersion(), now());
        return;
      }
    }
    boolean exact =
        CategorizationMatchKeys.derive(
                    entry.getKind(), entry.getDescription(), evidence.merchantIdentity())
                .flatMap(
                    key ->
                        rules.findActiveMatch(entry.getHouseholdId(), entry.getOwnerUserId(), key))
                .isPresent()
            || CategorizationClassifier.classify(
                    evidence.primaryCode(), evidence.detailCode(), entry.getKind())
                .isPresent();
    propose(entry, evidence.fingerprint(), exact);
  }

  private record CurrentEvidence(
      String fingerprint, String merchantIdentity, String primaryCode, String detailCode) {}

  /** Non-locking observation read: sync holds observation before ledger, never the reverse. */
  private CurrentEvidence currentEvidence(FinancialTransactionEntity entry) {
    if (!"CONNECTED".equals(entry.getSource())) return new CurrentEvidence(null, null, null, null);
    @SuppressWarnings("unchecked")
    List<Object[]> rows =
        entityManager
            .createNativeQuery(
                "SELECT o.categorization_evidence_fingerprint, o.provider_merchant_identity_digest,"
                    + " o.pfc_primary_code, o.pfc_detail_code FROM connection_ledger_associations a"
                    + " JOIN connection_observations o ON o.id = a.observation_id"
                    + " AND o.household_id = a.household_id AND o.owner_user_id = a.owner_user_id"
                    + " JOIN household_members m ON m.household_id = a.household_id"
                    + " AND m.user_id = :owner WHERE a.transaction_id = :transaction"
                    + " AND a.household_id = :household AND a.owner_user_id = :owner"
                    + " AND a.state = 'CURRENT' AND o.state = 'POSTED'")
            .setParameter("transaction", entry.getId())
            .setParameter("household", entry.getHouseholdId())
            .setParameter("owner", entry.getOwnerUserId())
            .getResultList();
    if (rows.size() != 1) return null;
    Object[] row = rows.getFirst();
    return new CurrentEvidence((String) row[0], (String) row[1], (String) row[2], (String) row[3]);
  }

  private void propose(
      FinancialTransactionEntity entry, String providerEvidence, boolean autoApplicable) {
    if (entry.getStatus() != TransactionStatus.POSTED
        || entry.getKind() == TransactionKind.REFUND
        || entry.getCategoryOrigin() == CategorizationOrigin.USER
        || entry.getCategoryOrigin() == CategorizationOrigin.LEGACY
        || !(entry.getCategoryOrigin() == CategorizationOrigin.NONE
            || entry.getCategoryOrigin() == CategorizationOrigin.OWNER_RULE
            || entry.getCategoryOrigin() == CategorizationOrigin.PROVIDER)) return;
    var candidate =
        autoApplicable
            ? java.util.Optional.<TransactionCategory>empty()
            : CategorizationHeuristic.suggest(entry.getKind(), entry.getDescription());
    String evidence =
        hash(
            entry.getKind()
                + "\0"
                + entry.getDescription()
                + "\0"
                + providerEvidence
                + "\0"
                + CategorizationHeuristic.POLICY_VERSION);
    var open = reviews.findOwnedOpen(entry.getHouseholdId(), entry.getOwnerUserId(), entry.getId());
    if (open.isEmpty() && entry.getCategoryOrigin() != CategorizationOrigin.NONE) return;
    if (open.isPresent() && open.get().getEvidenceFingerprint().equals(evidence)) return;
    // A previously resolved evidence revision cannot reopen even if a provider replays an old
    // delta.
    boolean seen =
        reviews
            .findOwnedEvidence(
                entry.getHouseholdId(),
                entry.getOwnerUserId(),
                entry.getId(),
                "HEURISTIC",
                CategorizationHeuristic.POLICY_VERSION,
                evidence)
            .isPresent();
    if (open.isPresent()) open.get().close("SUPERSEDED", now());
    if (candidate.isEmpty() || seen) return;
    reviews.flush(); // release the partial OPEN index before the successor insert
    reviews.save(
        new CategorizationReviewEntity(
            UUID.randomUUID(),
            entry.getHouseholdId(),
            entry.getOwnerUserId(),
            entry.getId(),
            candidate.get().name(),
            "HEURISTIC",
            "HIGH",
            "EXACT_MERCHANT",
            CategorizationHeuristic.POLICY_VERSION,
            evidence,
            entry.getVersion(),
            now()));
  }

  /**
   * Direct category patch and void close pending suggestions, without changing ledger version
   * again.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public void supersede(UUID household, UUID owner, UUID transactionId) {
    reviews
        .findOwnedOpen(household, owner, transactionId)
        .ifPresent(item -> item.close("SUPERSEDED", now()));
  }

  @Transactional(readOnly = true)
  public boolean hasOpen(UUID household, UUID owner, UUID transactionId) {
    return reviews.findOwnedOpen(household, owner, transactionId).isPresent();
  }

  @Transactional(readOnly = true)
  public CategorizationReviewListResponse list(
      UUID household, UUID owner, String view, int limit, int offset) {
    households.requireFinanceMembership(household, owner);
    String sql =
        "SELECT r.* FROM categorization_reviews r JOIN household_members m"
            + " ON m.household_id = r.household_id AND m.user_id = :owner"
            + " WHERE r.household_id = :household AND r.owner_user_id = :owner"
            + ("OPEN".equals(view) ? " AND r.status = 'OPEN'" : " AND r.status <> 'OPEN'")
            + " ORDER BY r.created_at DESC, r.id DESC LIMIT :limit OFFSET :offset";
    @SuppressWarnings("unchecked")
    List<CategorizationReviewEntity> rows =
        entityManager
            .createNativeQuery(sql, CategorizationReviewEntity.class)
            .setParameter("household", household)
            .setParameter("owner", owner)
            .setParameter("limit", limit + 1)
            .setParameter("offset", offset)
            .getResultList();
    return new CategorizationReviewListResponse(
        rows.stream()
            .limit(limit)
            .map(item -> toResponse(item, ledger.get(household, item.getTransactionId(), owner)))
            .toList(),
        limit,
        offset,
        rows.size() > limit,
        reviews.countOpen(household, owner));
  }

  @Transactional(readOnly = true)
  public CategorizationReviewResponse get(UUID household, UUID owner, UUID reviewId) {
    CategorizationReviewEntity item =
        reviews
            .findOwned(household, reviewId, owner)
            .orElseGet(
                () -> {
                  households.requireFinanceMembership(household, owner);
                  throw new CategorizationReviewNotFoundException();
                });
    return toResponse(item, ledger.get(household, item.getTransactionId(), owner));
  }

  @Transactional
  public CategorizationReviewResponse resolve(
      UUID household,
      UUID owner,
      UUID reviewId,
      UUID requestKey,
      CategorizationReviewResolveRequest request) {
    validate(request);
    households.lockForFinance(household, owner);
    ReviewIdempotencyKey key = new ReviewIdempotencyKey(owner, household, requestKey);
    String fingerprint =
        hash(
            reviewId
                + "\0"
                + request.expectedVersion()
                + "\0"
                + request.expectedTransactionVersion()
                + "\0"
                + request.action()
                + "\0"
                + request.category());
    var previous = idempotency.findById(key);
    if (previous.isPresent()) {
      if (!previous.get().getRequestFingerprint().equals(fingerprint))
        throw new TransactionIdempotencyConflictException();
      // Reauthorization uses the current owner-scoped query, not the saved actor or historical
      // membership.
      return get(household, owner, previous.get().getReviewId());
    }
    CategorizationReviewEntity item =
        reviews
            .findOwned(household, reviewId, owner)
            .orElseThrow(CategorizationReviewNotFoundException::new);
    FinancialTransactionEntity entry =
        ledger.lockForCategorizationReview(household, item.getTransactionId(), owner);
    entityManager.refresh(entry);
    entityManager.refresh(item);
    if (item.getVersion() != request.expectedVersion() || !"OPEN".equals(item.getStatus()))
      throw new CategorizationReviewVersionConflictException();
    if (entry.getVersion() != request.expectedTransactionVersion()
        || entry.getVersion() != item.getEvaluatedTransactionVersion())
      throw new CategorizationReviewVersionConflictException();
    if (entry.getStatus() != TransactionStatus.POSTED
        || entry.getKind() == TransactionKind.REFUND
        || entry.getCategoryOrigin() == CategorizationOrigin.USER
        || entry.getCategoryOrigin() == CategorizationOrigin.LEGACY)
      throw new CategorizationReviewVersionConflictException();
    // This is a plain observation SELECT after the account/ledger locks. Sync takes observation
    // then ledger; it either commits its supersession before our lock, or this USER decision wins.
    CurrentEvidence evidence = currentEvidence(entry);
    if (evidence == null
        || !hash(entry.getKind()
                + "\0"
                + entry.getDescription()
                + "\0"
                + evidence.fingerprint()
                + "\0"
                + item.getPolicyVersion())
            .equals(item.getEvidenceFingerprint()))
      throw new CategorizationReviewVersionConflictException();
    String category =
        switch (request.action()) {
          case "ACCEPT_SUGGESTION" -> item.getSuggestedCategory();
          case "CHOOSE_CATEGORY" -> request.category();
          case "KEEP_CURRENT" -> {
            if (entry.getCategory() == null)
              throw new ValidationFailedException(
                  Map.of("action", "Choose a valid decision for this category."));
            yield entry.getCategory();
          }
          case "KEEP_UNCATEGORIZED" -> {
            if (entry.getCategory() != null)
              throw new ValidationFailedException(
                  Map.of("action", "Choose a valid decision for this category."));
            yield null;
          }
          default -> throw new IllegalStateException("Validated action missing");
        };
    FinancialTransactionResponse changed =
        ledger.patch(
            household,
            entry.getId(),
            owner,
            new FinancialTransactionService.PatchFields(
                request.expectedTransactionVersion(),
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
                category,
                true,
                null,
                false));
    // Ledger.patch supersedes this OPEN item while holding the canonical account/expense/refund
    // locks.
    item.resolvedAfterPatch(
        "ACCEPT_SUGGESTION".equals(request.action())
            ? "ACCEPTED"
            : "CHOOSE_CATEGORY".equals(request.action()) ? "CHOSEN" : "KEPT");
    idempotency.save(new CategorizationReviewIdempotency(key, fingerprint, reviewId, now()));
    idempotency.flush();
    return toResponse(item, changed);
  }

  private static void validate(CategorizationReviewResolveRequest request) {
    if (request == null) throw new ValidationFailedException(Map.of());
    if (request.expectedVersion() == null || request.expectedVersion() < 0)
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current review version."));
    if (request.expectedTransactionVersion() == null || request.expectedTransactionVersion() < 0)
      throw new ValidationFailedException(
          Map.of("expectedTransactionVersion", "Provide the current transaction version."));
    if (request.action() == null
        || !List.of("ACCEPT_SUGGESTION", "CHOOSE_CATEGORY", "KEEP_CURRENT", "KEEP_UNCATEGORIZED")
            .contains(request.action()))
      throw new ValidationFailedException(Map.of("action", "Choose a supported resolution."));
    if ("CHOOSE_CATEGORY".equals(request.action())) {
      try {
        TransactionCategory.valueOf(Objects.requireNonNull(request.category()));
      } catch (IllegalArgumentException | NullPointerException rejected) {
        throw new ValidationFailedException(Map.of("category", "Choose a supported category."));
      }
    } else if (request.categoryPresent())
      throw new ValidationFailedException(
          Map.of("category", "Only category choice accepts a category."));
  }

  private static CategorizationReviewResponse toResponse(
      CategorizationReviewEntity item, FinancialTransactionResponse entry) {
    return new CategorizationReviewResponse(
        item.getId(),
        entry,
        item.getEvaluatedTransactionVersion(),
        item.getSuggestedCategory(),
        item.getSource(),
        item.getConfidence(),
        "EXACT_MERCHANT".equals(item.getReasonCode())
            ? "Merchant pattern matched"
            : "Category suggestion",
        item.getStatus(),
        item.getVersion(),
        item.getCreatedAt(),
        item.getUpdatedAt());
  }

  private Instant now() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  private static String hash(String input) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
