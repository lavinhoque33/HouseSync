package com.housesync.finance.categorization.persistence;

import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionExhaustedException;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "categorization_reviews")
public class CategorizationReviewEntity {
  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "transaction_id", nullable = false)
  private UUID transactionId;

  @Column(name = "suggested_category", nullable = false, length = 24)
  private String suggestedCategory;

  @Column(nullable = false, length = 16)
  private String source;

  @Column(nullable = false, length = 8)
  private String confidence;

  @Column(name = "reason_code", nullable = false, length = 32)
  private String reasonCode;

  @Column(name = "policy_version", nullable = false, length = 32)
  private String policyVersion;

  @Column(name = "evidence_fingerprint", nullable = false, length = 64)
  private String evidenceFingerprint;

  @Column(name = "evaluated_transaction_version", nullable = false)
  private int evaluatedTransactionVersion;

  @Column(nullable = false, length = 16)
  private String status;

  @Column(nullable = false)
  private int version;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected CategorizationReviewEntity() {}

  public CategorizationReviewEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID transactionId,
      String suggestedCategory,
      String source,
      String confidence,
      String reasonCode,
      String policyVersion,
      String evidenceFingerprint,
      int evaluatedTransactionVersion,
      Instant now) {
    this.id = id;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.transactionId = transactionId;
    this.suggestedCategory = suggestedCategory;
    this.source = source;
    this.confidence = confidence;
    this.reasonCode = reasonCode;
    this.policyVersion = policyVersion;
    this.evidenceFingerprint = evidenceFingerprint;
    this.evaluatedTransactionVersion = evaluatedTransactionVersion;
    this.status = "OPEN";
    this.createdAt = now;
    this.updatedAt = now;
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

  public UUID getTransactionId() {
    return transactionId;
  }

  public String getSuggestedCategory() {
    return suggestedCategory;
  }

  public String getSource() {
    return source;
  }

  public String getConfidence() {
    return confidence;
  }

  public String getReasonCode() {
    return reasonCode;
  }

  public String getPolicyVersion() {
    return policyVersion;
  }

  public String getEvidenceFingerprint() {
    return evidenceFingerprint;
  }

  public int getEvaluatedTransactionVersion() {
    return evaluatedTransactionVersion;
  }

  public String getStatus() {
    return status;
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

  public void close(String nextStatus, Instant now) {
    if (!"OPEN".equals(status)) throw new IllegalStateException("Review already closed");
    if (version == Integer.MAX_VALUE) throw new ResourceVersionExhaustedException();
    status = nextStatus;
    version++;
    updatedAt = now;
  }

  /** Retain the same evidence suggestion after a non-category ledger version change. */
  public void advanceEvaluation(int transactionVersion, Instant now) {
    if (!"OPEN".equals(status)) throw new IllegalStateException("Review already closed");
    if (evaluatedTransactionVersion == transactionVersion) return;
    if (version == Integer.MAX_VALUE) throw new ResourceVersionExhaustedException();
    evaluatedTransactionVersion = transactionVersion;
    version++;
    updatedAt = now;
  }

  /** The same transaction's ledger PATCH has already closed this item once. */
  public void resolvedAfterPatch(String resolvedStatus) {
    if (!"SUPERSEDED".equals(status)) throw new IllegalStateException("Review was not closed");
    status = resolvedStatus;
  }
}
