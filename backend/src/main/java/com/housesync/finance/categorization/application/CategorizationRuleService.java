package com.housesync.finance.categorization.application;

import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.normalize;
import static com.housesync.finance.transaction.domain.TransactionDescriptionPolicy.violation;

import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionExhaustedException;
import com.housesync.finance.activity.application.BankActivityService;
import com.housesync.finance.categorization.domain.CategorizationMatchKeys;
import com.housesync.finance.categorization.domain.CategorizationOrigin;
import com.housesync.finance.categorization.persistence.CategorizationRuleEntity;
import com.housesync.finance.categorization.persistence.CategorizationRuleIdempotencyEntity;
import com.housesync.finance.categorization.persistence.CategorizationRuleIdempotencyKey;
import com.housesync.finance.categorization.persistence.CategorizationRuleIdempotencyRepository;
import com.housesync.finance.categorization.persistence.CategorizationRuleRepository;
import com.housesync.finance.categorization.web.CategorizationRuleExceptions.CategoryRuleConflictException;
import com.housesync.finance.categorization.web.CategorizationRuleExceptions.RuleIdempotencyConflictException;
import com.housesync.finance.categorization.web.CategorizationRuleExceptions.RuleNotFoundException;
import com.housesync.finance.categorization.web.CategorizationRuleListResponse;
import com.housesync.finance.categorization.web.CategorizationRuleResponse;
import com.housesync.finance.transaction.application.FinancialTransactionService;
import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVoidedException;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owner-private categorization rule use cases (categorization contract §4). Rules are learned
 * explicitly from one owned posted non-refund entry the actor already categorized as USER: the
 * server derives the strongest match key from authorized stored evidence, and clients never submit
 * household, owner, or match fields. Rules affect only future classification — a create,
 * correction, or deactivation never rewrites an existing category, amount, or assignment
 * provenance.
 *
 * <p>Every mutation runs under the household lifecycle lock (membership removal serializes through
 * it), then the owned row lock; creation additionally locks the source entry through the
 * transaction domain's public use case and compares the caller's version token there. Creation is
 * durably idempotent: a retained key returns the current rule representation without reapplying
 * create preconditions, and a changed payload is a conflict. A conflicting active key answers 409
 * without exposing any other user's rule; deactivation is the one-way retained transition.
 */
@Service
public class CategorizationRuleService {

  private static final String CREATE_RULE_OPERATION = "CATEGORIZATION_RULE_CREATE";

  private final CategorizationRuleRepository rules;
  private final CategorizationRuleIdempotencyRepository ruleIdempotency;
  private final FinancialTransactionService transactions;
  private final BankActivityService bankActivity;
  private final HouseholdService households;
  private final Clock clock;
  private final EntityManager entityManager;

  public CategorizationRuleService(
      CategorizationRuleRepository rules,
      CategorizationRuleIdempotencyRepository ruleIdempotency,
      FinancialTransactionService transactions,
      BankActivityService bankActivity,
      HouseholdService households,
      Clock clock,
      EntityManager entityManager) {
    this.rules = rules;
    this.ruleIdempotency = ruleIdempotency;
    this.transactions = transactions;
    this.bankActivity = bankActivity;
    this.households = households;
    this.clock = clock;
    this.entityManager = entityManager;
  }

  /** Owner-private rule page: current actor's rules only, ordered updatedAt DESC, id DESC. */
  @Transactional(readOnly = true)
  public CategorizationRuleListResponse list(
      UUID householdId, UUID actorId, String status, int limit, int offset) {
    List<CategorizationRuleEntity> page =
        findOwnedPage(householdId, actorId, status, limit + 1, offset);
    if (page.isEmpty()) {
      // Preserve missing/non-member equivalence without widening any other read.
      households.requireFinanceMembership(householdId, actorId);
    }
    boolean hasMore = page.size() > limit;
    List<CategorizationRuleResponse> items =
        page.stream().limit(limit).map(CategorizationRuleService::toItem).toList();
    return new CategorizationRuleListResponse(items, limit, offset, hasMore);
  }

  /**
   * Builds the authorized owner-private page query dynamically so the optional status filter is
   * either omitted or bound with a concrete typed value; scope and ordering apply in SQL, never to
   * an unrestricted in-memory result.
   */
  private List<CategorizationRuleEntity> findOwnedPage(
      UUID householdId, UUID actorId, String status, int limit, int offset) {
    StringBuilder sql =
        new StringBuilder(
            "SELECT r.* FROM categorization_rules r"
                + " JOIN household_members m ON m.household_id = r.household_id"
                + " AND m.user_id = :actorId"
                + " WHERE r.household_id = :householdId AND r.owner_user_id = :actorId");
    if (status != null) {
      sql.append(" AND r.status = :status");
    }
    sql.append(" ORDER BY r.updated_at DESC, r.id DESC LIMIT :limit OFFSET :offset");
    Query query = entityManager.createNativeQuery(sql.toString(), CategorizationRuleEntity.class);
    query.setParameter("householdId", householdId);
    query.setParameter("actorId", actorId);
    if (status != null) {
      query.setParameter("status", status);
    }
    query.setParameter("limit", limit);
    query.setParameter("offset", offset);
    return (List<CategorizationRuleEntity>) query.getResultList();
  }

  /** Result of one rule mutation: the safe item plus whether the durable key replayed. */
  public record RuleMutation(CategorizationRuleResponse rule, boolean replayed) {}

  /**
   * Explicitly learns one exact owner rule from the actor's own posted non-refund USER entry. Lock
   * order: household lifecycle first, then the source entry; the durable key is checked before and
   * re-checked after the source row lock, so a concurrent same-key create that serialized behind
   * this one replays instead of surfacing a conflict. The category is always the source entry's
   * current effective one.
   */
  @Transactional
  public RuleMutation createRule(
      UUID householdId,
      UUID transactionId,
      UUID actorId,
      Integer expectedTransactionVersion,
      UUID idempotencyKey) {
    if (expectedTransactionVersion == null || expectedTransactionVersion < 0) {
      throw new ValidationFailedException(
          Map.of("expectedTransactionVersion", "Provide the current transaction version."));
    }
    households.lockForFinance(householdId, actorId);

    var key =
        new CategorizationRuleIdempotencyKey(
            actorId, householdId, CREATE_RULE_OPERATION, idempotencyKey);
    String fingerprint = fingerprint(transactionId, expectedTransactionVersion);
    Optional<RuleMutation> replayed = replay(key, fingerprint, householdId, actorId);
    if (replayed.isPresent()) {
      return replayed.get();
    }

    FinancialTransactionEntity source =
        transactions.loadForCategorizationRule(
            householdId, transactionId, actorId, expectedTransactionVersion);
    // The source row lock serializes same-key retries: re-check once a concurrent winner's
    // durable row is visible before deriving anything new.
    replayed = replay(key, fingerprint, householdId, actorId);
    if (replayed.isPresent()) {
      return replayed.get();
    }
    requireEligibleSource(source);

    // Retained evidence: connected entries prefer the provider-stable merchant identity stored
    // with their admitted observation; manual entries — and connected entries without one — use
    // the conservative description key. Neither form ever reaches a browser response.
    BankActivityService.RetainedEvidence evidence =
        "CONNECTED".equals(source.getSource())
            ? bankActivity
                .retainedCategorizationEvidence(householdId, transactionId, actorId)
                .orElse(null)
            : null;
    CategorizationMatchKeys.DerivedKey derived =
        CategorizationMatchKeys.derive(
                source.getKind(), source.getDescription(), retainedDigest(evidence))
            .orElseThrow(CategorizationRuleService::unsafeKeyRejection);
    if (rules
        .findActiveMatch(householdId, actorId, derived.matchType(), derived.key())
        .isPresent()) {
      throw new CategoryRuleConflictException();
    }

    Instant now = now();
    CategorizationRuleEntity rule =
        CategorizationRuleEntity.create(
            UUID.randomUUID(),
            householdId,
            actorId,
            source.getId(),
            derived.matchType(),
            derived.key(),
            matchLabel(source, retainedLabel(evidence)),
            TransactionCategory.valueOf(source.getCategory()),
            now);
    rules.save(rule);
    try {
      rules.flush();
    } catch (DataIntegrityViolationException race) {
      // The partial active-key index is the last line of defense for a concurrent same-key
      // create from a different key scope: the loser surfaces the safe conflict contract with no
      // partial state; referential defects stay 500s.
      throw uniqueViolation(race);
    }
    try {
      ruleIdempotency.save(
          new CategorizationRuleIdempotencyEntity(key, fingerprint, rule.getId(), now));
      ruleIdempotency.flush();
    } catch (DataIntegrityViolationException race) {
      throw uniqueViolation(race);
    }
    return new RuleMutation(toItem(rule), false);
  }

  /**
   * Same-key replay: reauthorize membership and ownership through the scoped lookup, then return
   * the current representation; current create preconditions are deliberately not reapplied.
   */
  private Optional<RuleMutation> replay(
      CategorizationRuleIdempotencyKey key, String fingerprint, UUID householdId, UUID actorId) {
    return ruleIdempotency
        .findById(key)
        .map(
            stored -> {
              if (!stored.getRequestFingerprint().equals(fingerprint)) {
                throw new RuleIdempotencyConflictException();
              }
              CategorizationRuleEntity rule =
                  rules
                      .findOwnedScoped(householdId, stored.getResourceId(), actorId)
                      .orElseThrow(RuleNotFoundException::new);
              return new RuleMutation(toItem(rule), true);
            });
  }

  private static String retainedDigest(BankActivityService.RetainedEvidence evidence) {
    return evidence == null ? null : evidence.merchantIdentityDigest();
  }

  private static String retainedLabel(BankActivityService.RetainedEvidence evidence) {
    return evidence == null ? null : evidence.merchantDisplayName();
  }

  /**
   * Maps a concurrent-insert integrity violation to the documented outcome: any unique-index
   * violation after the serialized checks is the safe active-key conflict, and real referential
   * defects stay 500s.
   */
  private static RuntimeException uniqueViolation(DataIntegrityViolationException race) {
    Throwable cause = race.getMostSpecificCause();
    if (cause instanceof java.sql.SQLException sql && "23505".equals(sql.getSQLState())) {
      return new CategoryRuleConflictException();
    }
    return race;
  }

  private static ValidationFailedException unsafeKeyRejection() {
    // No safe server-derived key exists for this entry; the safe top-level error never echoes
    // merchant text or evidence.
    return new ValidationFailedException(Map.of());
  }

  /**
   * One authorized rule mutation: a category correction on an ACTIVE rule, or the one-way
   * deactivation. The version token is compared only after the owned row is locked. A repeated
   * INACTIVE on a retained inactive rule, like a repeated category on an active rule, stays the
   * accepted no-op.
   */
  @Transactional
  public CategorizationRuleResponse patchRule(
      UUID householdId,
      UUID ruleId,
      UUID actorId,
      Integer expectedVersion,
      boolean expectedVersionPresent,
      String category,
      boolean categoryPresent,
      String status,
      boolean statusPresent) {
    PatchValues values =
        validatePatch(
            expectedVersion,
            expectedVersionPresent,
            category,
            categoryPresent,
            status,
            statusPresent);
    households.lockForFinance(householdId, actorId);
    CategorizationRuleEntity rule =
        rules
            .findOwnedForUpdate(householdId, ruleId, actorId)
            .orElseThrow(RuleNotFoundException::new);
    if (rule.getVersion() != values.expectedVersion()) {
      throw new ResourceVersionConflictException();
    }
    if (values.categoryPresent()) {
      TransactionCategory parsed = parseCategory(values.category());
      if (!rule.isActive()) {
        throw new ValidationFailedException(
            Map.of("category", "Only an active rule can change its category."));
      }
      if (parsed.name().equals(rule.getCategory().name())) {
        return toItem(rule);
      }
      requireVersionCapacity(rule);
      rule.categoryChanged(parsed, now());
      rules.saveAndFlush(rule);
      return toItem(rule);
    }
    if (!rule.isActive()) {
      // Retained one-way state: a repeated INACTIVE is the accepted no-op.
      return toItem(rule);
    }
    requireVersionCapacity(rule);
    rule.deactivated(now());
    rules.saveAndFlush(rule);
    return toItem(rule);
  }

  /**
   * Owner-private rule-creation capability for one owned entry, evaluated live for the owner-only
   * categorization detail (categorization contract §5). True only for the current posted non-refund
   * USER entry with a non-null category, a safe server-derived match key, and no active rule for
   * that key. The key itself never leaves the server.
   */
  @Transactional(propagation = Propagation.MANDATORY, readOnly = true)
  public boolean ruleEligible(
      UUID householdId,
      UUID actorId,
      FinancialTransactionEntity transaction,
      String merchantIdentityDigest) {
    if (!eligibleSource(transaction)) {
      return false;
    }
    var derived =
        CategorizationMatchKeys.derive(
            transaction.getKind(), transaction.getDescription(), merchantIdentityDigest);
    if (derived.isEmpty()) {
      return false;
    }
    return rules
        .findActiveMatch(householdId, actorId, derived.get().matchType(), derived.get().key())
        .isEmpty();
  }

  /** Posted non-refund USER entries with a category are the only rule sources. */
  private static boolean eligibleSource(FinancialTransactionEntity transaction) {
    return transaction.getStatus() == TransactionStatus.POSTED
        && transaction.getKind() != TransactionKind.REFUND
        && transaction.getCategoryOrigin() == CategorizationOrigin.USER
        && transaction.getCategory() != null;
  }

  private static void requireEligibleSource(FinancialTransactionEntity source) {
    if (source.getKind() == TransactionKind.REFUND) {
      // Refunds classify by inheritance and never learn rules.
      throw new ValidationFailedException(Map.of());
    }
    if (source.getStatus() != TransactionStatus.POSTED) {
      throw new TransactionVoidedException();
    }
    if (!eligibleSource(source)) {
      // A retained, inherited, or automated assignment is not an explicit user decision.
      throw new ValidationFailedException(Map.of());
    }
  }

  /**
   * The private display label: the retained merchant display name when present and safe, else the
   * source description. Both inputs are bounded ledger/observation evidence; the violation check is
   * defense in depth, and an unusable label rejects the create like any other unsafe evidence.
   */
  private static String matchLabel(FinancialTransactionEntity source, String merchantDisplayName) {
    if (merchantDisplayName != null && violation(merchantDisplayName).isEmpty()) {
      return normalize(merchantDisplayName);
    }
    if (violation(source.getDescription()).isPresent()) {
      throw new ValidationFailedException(Map.of());
    }
    return normalize(source.getDescription());
  }

  private static void requireVersionCapacity(CategorizationRuleEntity rule) {
    if (rule.getVersion() == Integer.MAX_VALUE) {
      throw new ResourceVersionExhaustedException();
    }
  }

  private static TransactionCategory parseCategory(String category) {
    try {
      return TransactionCategory.valueOf(category);
    } catch (IllegalArgumentException | NullPointerException rejected) {
      throw new ValidationFailedException(Map.of("category", "Choose a supported category."));
    }
  }

  private PatchValues validatePatch(
      Integer expectedVersion,
      boolean expectedVersionPresent,
      String category,
      boolean categoryPresent,
      String status,
      boolean statusPresent) {
    if (!expectedVersionPresent || expectedVersion == null || expectedVersion < 0) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current rule version."));
    }
    if (categoryPresent && statusPresent) {
      throw new ValidationFailedException(Map.of());
    }
    if (statusPresent && (status == null || !"INACTIVE".equals(status))) {
      throw new ValidationFailedException(Map.of("status", "Only deactivation is supported."));
    }
    if (categoryPresent && category == null) {
      throw new ValidationFailedException(Map.of("category", "Choose a supported category."));
    }
    if (!categoryPresent && !statusPresent) {
      throw new ValidationFailedException(Map.of());
    }
    return new PatchValues(expectedVersion, category, categoryPresent, status, statusPresent);
  }

  private record PatchValues(
      int expectedVersion,
      String category,
      boolean categoryPresent,
      String status,
      boolean statusPresent) {}

  /** Safe projection: exactly the nine documented fields, never the match key. */
  static CategorizationRuleResponse toItem(CategorizationRuleEntity rule) {
    return new CategorizationRuleResponse(
        rule.getId(),
        rule.getSourceTransactionId(),
        rule.getMatchType().name(),
        rule.getMatchLabel(),
        rule.getCategory().name(),
        rule.getStatus().name(),
        rule.getVersion(),
        rule.getCreatedAt(),
        rule.getUpdatedAt());
  }

  /** Canonical create fingerprint over the operation, source entry, and version token. */
  private static String fingerprint(UUID transactionId, int expectedTransactionVersion) {
    String canonical =
        CREATE_RULE_OPERATION + "\0" + transactionId + "\0" + expectedTransactionVersion;
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
}
