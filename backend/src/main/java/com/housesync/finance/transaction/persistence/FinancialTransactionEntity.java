package com.housesync.finance.transaction.persistence;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.categorization.domain.CategorizationOrigin;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * Private manual ledger entry. Amounts map to the migration's NUMERIC(15, 3); the exact currency
 * scale was validated before binding, and responses re-pad to the currency scale. Associations stay
 * plain UUID columns: the composite database references enforce household/owner/currency
 * consistency for both the source account and a refund's expense.
 */
@Entity
@Table(name = "financial_transactions")
public class FinancialTransactionEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "account_id", nullable = false)
  private UUID accountId;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private TransactionKind kind;

  @Column(nullable = false, precision = 15, scale = 3)
  private BigDecimal amount;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 3)
  private SupportedCurrency currency;

  @Column(name = "occurred_on", nullable = false)
  private LocalDate occurredOn;

  @Column(nullable = false, length = 200)
  private String description;

  /** Taxonomy token or null for uncategorized; the V8 check constraint bounds the stored values. */
  @Column(length = 24)
  private String category;

  @Column(nullable = false, length = 16)
  private String source;

  @Column(nullable = false, length = 16)
  private String visibility;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private TransactionStatus status;

  @Column(name = "refund_of_transaction_id")
  private UUID refundOfTransactionId;

  @Column(nullable = false)
  private int version;

  /**
   * How the effective category was assigned: NONE, LEGACY, USER, OWNER_RULE, PROVIDER,
   * or INHERITED. Provenance describes the current category, not what the latest classifier would
   * choose; the V15 database check bounds the coherent combinations.
   */
  @Enumerated(EnumType.STRING)
  @Column(name = "category_origin", nullable = false, length = 16)
  private CategorizationOrigin categoryOrigin;

  /** Server assignment instant; required for every state. */
  @Column(name = "category_assigned_at", nullable = false)
  private Instant categoryAssignedAt;

  /** Bounded ruleset version for OWNER_RULE/PROVIDER assignments; null otherwise. */
  @Column(name = "categorization_ruleset_version", length = 32)
  private String categorizationRulesetVersion;

  /**
   * Internal nullable reference to the owner rule that assigned the category; never
   * browser-projected.
   */
  @Column(name = "category_rule_id")
  private UUID categoryRuleId;

  /** Internal evidence digest for stale-work rejection; never browser-projected. */
  @Column(name = "categorization_evidence_fingerprint", length = 64)
  private String categorizationEvidenceFingerprint;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected FinancialTransactionEntity() {}

  public FinancialTransactionEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID accountId,
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String visibility,
      String category,
      UUID refundOfTransactionId,
      Instant createdAt) {
    this(
        id,
        householdId,
        ownerUserId,
        accountId,
        kind,
        amount,
        currency,
        occurredOn,
        description,
        visibility,
        category,
        refundOfTransactionId,
        "MANUAL",
        createdAt);
  }

  /**
   * One-time bank-activity admission: the ledger entry's provenance is CONNECTED and it may only be
   * created by the confirmation service, never by manual POST.
   */
  public static FinancialTransactionEntity connected(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID accountId,
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String visibility,
      String category,
      UUID refundOfTransactionId,
      Instant createdAt) {
    return new FinancialTransactionEntity(
        id,
        householdId,
        ownerUserId,
        accountId,
        kind,
        amount,
        currency,
        occurredOn,
        description,
        visibility,
        category,
        refundOfTransactionId,
        "CONNECTED",
        createdAt);
  }

  private FinancialTransactionEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID accountId,
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String visibility,
      String category,
      UUID refundOfTransactionId,
      String source,
      Instant createdAt) {
    this(
        id,
        householdId,
        ownerUserId,
        accountId,
        kind,
        amount,
        currency,
        occurredOn,
        description,
        visibility,
        category,
        refundOfTransactionId,
        source,
        // New rows start uncategorized: the service records the real assignment state before the
        // first flush. LEGACY is migration-only and never constructed here.
        CategorizationOrigin.NONE,
        createdAt,
        createdAt);
  }

  /** Full constructor used by the service when recording the initial assignment state. */
  public FinancialTransactionEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID accountId,
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      String visibility,
      String category,
      UUID refundOfTransactionId,
      String source,
      CategorizationOrigin categoryOrigin,
      Instant categoryAssignedAt,
      Instant createdAt) {
    this.id = id;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.accountId = accountId;
    this.kind = kind;
    this.amount = amount;
    this.currency = currency;
    this.occurredOn = occurredOn;
    this.description = description;
    this.category = category;
    this.source = source;
    this.visibility = visibility;
    this.status = TransactionStatus.POSTED;
    this.refundOfTransactionId = refundOfTransactionId;
    this.categoryOrigin = categoryOrigin;
    this.categoryAssignedAt = categoryAssignedAt;
    this.version = 0;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  public UUID getId() {
    return id;
  }

  public UUID getHouseholdId() {
    return householdId;
  }

  public UUID getOwnerUserId() {
    return ownerUserId;
  }

  public UUID getAccountId() {
    return accountId;
  }

  public TransactionKind getKind() {
    return kind;
  }

  public BigDecimal getAmount() {
    return amount;
  }

  public SupportedCurrency getCurrency() {
    return currency;
  }

  public LocalDate getOccurredOn() {
    return occurredOn;
  }

  public String getDescription() {
    return description;
  }

  public String getCategory() {
    return category;
  }

  public String getSource() {
    return source;
  }

  public String getVisibility() {
    return visibility;
  }

  public TransactionStatus getStatus() {
    return status;
  }

  public UUID getRefundOfTransactionId() {
    return refundOfTransactionId;
  }

  public int getVersion() {
    return version;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public CategorizationOrigin getCategoryOrigin() {
    return categoryOrigin;
  }

  public Instant getCategoryAssignedAt() {
    return categoryAssignedAt;
  }

  public String getCategorizationRulesetVersion() {
    return categorizationRulesetVersion;
  }

  public UUID getCategoryRuleId() {
    return categoryRuleId;
  }

  public String getCategorizationEvidenceFingerprint() {
    return categorizationEvidenceFingerprint;
  }

  /**
   * Records the initial assignment for a new row (already version 0, so no bump and no updated_at
   * change beyond creation): a {@code USER} token decision, a mapped {@code PROVIDER} assignment
   * with its ruleset version, or {@code NONE}. The {@code OWNER_RULE} seam stays unassigned until
   * owner rules exist. Evidence participates only as the internal digest.
   */
  public void initiallyCategorized(
      CategorizationOrigin origin,
      String category,
      String rulesetVersion,
      String evidenceFingerprint,
      Instant assignedAt) {
    this.category = category;
    this.categoryOrigin = origin;
    this.categoryAssignedAt = assignedAt;
    this.categorizationRulesetVersion = rulesetVersion;
    this.categoryRuleId = null;
    this.categorizationEvidenceFingerprint = evidenceFingerprint;
  }

  /**
   * A refund inherits its source expense's effective category; provenance is always INHERITED and
   * carries no independent rule or mapping reference.
   */
  public void inheritedFrom(String sourceCategory, Instant assignedAt) {
    this.category = sourceCategory;
    this.categoryOrigin = CategorizationOrigin.INHERITED;
    this.categoryAssignedAt = assignedAt;
    this.categorizationRulesetVersion = null;
    this.categoryRuleId = null;
    this.categorizationEvidenceFingerprint = null;
  }

  /**
   * One authorized user category decision (including explicit uncategorized): records {@code USER},
   * clears automated assignment references, and keeps the caller's single version bump. The prior
   * evidence digest is cleared too: the automated evidence no longer explains the category.
   */
  public void userAssigned(String category, Instant assignedAt) {
    this.category = category;
    this.categoryOrigin = CategorizationOrigin.USER;
    this.categoryAssignedAt = assignedAt;
    this.categorizationRulesetVersion = null;
    this.categoryRuleId = null;
    this.categorizationEvidenceFingerprint = null;
  }

  /** Retains all economic data while excluding the entry from totals; not restorable. */
  public void voided(Instant updatedAt) {
    this.status = TransactionStatus.VOIDED;
    this.version += 1;
    this.updatedAt = updatedAt;
  }

  /**
   * One authorized correction of a posted entry: economic fields plus the disclosure fields
   * (category, visibility) the patch resolved, applied as a single version bump. Provenance moves
   * separately: the service records {@code USER} after a category decision and leaves every other
   * field's provenance untouched.
   */
  public void correct(
      BigDecimal amount,
      LocalDate occurredOn,
      String description,
      String category,
      String visibility,
      Instant updatedAt) {
    this.amount = amount;
    this.occurredOn = occurredOn;
    this.description = description;
    this.category = category;
    this.visibility = visibility;
    this.version += 1;
    this.updatedAt = updatedAt;
  }

  /**
   * Group side effect on a linked refund: its own value changed, so it is versioned like a patch.
   * Refunds never classify independently: the propagated category keeps the {@code INHERITED}
   * origin with a fresh assignment instant and no independent rule or mapping reference.
   */
  public void groupChanged(String category, String visibility, Instant updatedAt) {
    this.category = category;
    this.visibility = visibility;
    this.categoryOrigin = CategorizationOrigin.INHERITED;
    this.categoryAssignedAt = updatedAt;
    this.categorizationRulesetVersion = null;
    this.categoryRuleId = null;
    this.categorizationEvidenceFingerprint = null;
    this.version += 1;
    this.updatedAt = updatedAt;
  }

  /** Source-expense version/timestamp bump caused by a state-changing refund group operation. */
  public void refunded(Instant updatedAt) {
    this.version += 1;
    this.updatedAt = updatedAt;
  }

  /**
   * Source-expense version/timestamp bump caused by a state-changing allocation create or revoke:
   * one bump per allocation state change so the expense version stays the single allocation
   * concurrency token.
   */
  public void allocationChanged(Instant updatedAt) {
    this.version += 1;
    this.updatedAt = updatedAt;
  }
}
