package com.housesync.finance.activity.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * Private normalized provider transaction observation. Pending, posted, removed, and
 * quarantined-invalid rows are owner-only evidence: none of them contributes to the confirmed
 * ledger or household reporting until an explicit confirmation creates a ledger entry and
 * association.
 *
 * <p>{@code providerRevision} hashes the material facts (state, money, currency, posted date) so
 * cosmetic provider metadata changes never reopen a dismissed item or mark an admitted entry as
 * modified. {@code admittedRevision} records the exact revision a confirmation accepted.
 */
@Entity
@Table(name = "connection_observations")
public class ConnectionObservationEntity {

  @Id private UUID id;

  @Column(name = "connection_id", nullable = false)
  private UUID connectionId;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "account_mapping_id")
  private UUID accountMappingId;

  @Column(name = "remote_transaction_digest", nullable = false, length = 64)
  private String remoteTransactionDigest;

  @Column(nullable = false, length = 16)
  private String state;

  @Column(name = "review_state", nullable = false, length = 16)
  private String reviewState;

  @Column(name = "change_state", length = 16)
  private String changeState;

  @Column(name = "provider_revision", length = 64)
  private String providerRevision;

  @Column(name = "admitted_revision", length = 64)
  private String admittedRevision;

  @Column(precision = 15, scale = 3)
  private BigDecimal amount;

  @Column(length = 3)
  private String currency;

  @Column(name = "occurred_on")
  private LocalDate occurredOn;

  @Column(name = "authorized_on")
  private LocalDate authorizedOn;

  @Column(name = "provider_description", length = 500)
  private String providerDescription;

  @Column(name = "description_valid", nullable = false)
  private boolean descriptionValid;

  @Column(name = "pending_predecessor_digest", length = 64)
  private String pendingPredecessorDigest;

  @Column(name = "invalid_reason", length = 64)
  private String invalidReason;

  /** Scope-bound digest of the provider-stable merchant identity; never a raw provider ID. */
  @Column(name = "provider_merchant_identity_digest", length = 64)
  private String providerMerchantIdentityDigest;

  /** Bounded untrusted private display text distinct from the statement description. */
  @Column(name = "merchant_display_name", length = 200)
  private String merchantDisplayName;

  @Column(name = "pfc_primary_code", length = 100)
  private String pfcPrimaryCode;

  @Column(name = "pfc_detail_code", length = 200)
  private String pfcDetailCode;

  /**
   * Separate deterministic digest over merchant/category evidence. A category- or
   * name-only provider update changes this value without touching {@code providerRevision}, so it
   * never reopens reconciliation or marks an admitted entry modified.
   */
  @Column(name = "categorization_evidence_fingerprint", length = 64)
  private String categorizationEvidenceFingerprint;

  @Column(name = "dismissed_reason", length = 32)
  private String dismissedReason;

  @Column(name = "dismissed_at")
  private Instant dismissedAt;

  @Column(nullable = false)
  private int version;

  @Column(nullable = false)
  private boolean tombstone;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected ConnectionObservationEntity() {}

  public ConnectionObservationEntity(
      UUID id,
      UUID connectionId,
      UUID householdId,
      UUID ownerUserId,
      UUID accountMappingId,
      String remoteTransactionDigest,
      String state,
      String providerRevision,
      BigDecimal amount,
      String currency,
      LocalDate occurredOn,
      LocalDate authorizedOn,
      String providerDescription,
      boolean descriptionValid,
      String pendingPredecessorDigest,
      String providerMerchantIdentityDigest,
      String merchantDisplayName,
      String pfcPrimaryCode,
      String pfcDetailCode,
      String categorizationEvidenceFingerprint,
      Instant now) {
    this.id = id;
    this.connectionId = connectionId;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.accountMappingId = accountMappingId;
    this.remoteTransactionDigest = remoteTransactionDigest;
    this.state = state;
    this.reviewState = "UNREVIEWED";
    this.providerRevision = providerRevision;
    this.amount = amount;
    this.currency = currency;
    this.occurredOn = occurredOn;
    this.authorizedOn = authorizedOn;
    this.providerDescription = providerDescription;
    this.descriptionValid = descriptionValid;
    this.pendingPredecessorDigest = pendingPredecessorDigest;
    this.providerMerchantIdentityDigest = providerMerchantIdentityDigest;
    this.merchantDisplayName = merchantDisplayName;
    this.pfcPrimaryCode = pfcPrimaryCode;
    this.pfcDetailCode = pfcDetailCode;
    this.categorizationEvidenceFingerprint = categorizationEvidenceFingerprint;
    this.version = 0;
    this.createdAt = now;
    this.updatedAt = now;
  }

  /** Creates the tombstone an unknown removal leaves behind so replay cannot resurrect old data. */
  public static ConnectionObservationEntity tombstone(
      UUID id,
      UUID connectionId,
      UUID householdId,
      UUID ownerUserId,
      String remoteTransactionDigest,
      Instant now) {
    ConnectionObservationEntity observation =
        new ConnectionObservationEntity(
            id,
            connectionId,
            householdId,
            ownerUserId,
            null,
            remoteTransactionDigest,
            "REMOVED",
            null,
            null,
            null,
            null,
            null,
            null,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            now);
    observation.tombstone = true;
    return observation;
  }

  public UUID getId() {
    return id;
  }

  public UUID getConnectionId() {
    return connectionId;
  }

  public UUID getHouseholdId() {
    return householdId;
  }

  public UUID getOwnerUserId() {
    return ownerUserId;
  }

  public UUID getAccountMappingId() {
    return accountMappingId;
  }

  public String getRemoteTransactionDigest() {
    return remoteTransactionDigest;
  }

  public String getState() {
    return state;
  }

  public String getReviewState() {
    return reviewState;
  }

  public String getChangeState() {
    return changeState;
  }

  public String getProviderRevision() {
    return providerRevision;
  }

  public String getAdmittedRevision() {
    return admittedRevision;
  }

  public BigDecimal getAmount() {
    return amount;
  }

  public String getCurrency() {
    return currency;
  }

  public LocalDate getOccurredOn() {
    return occurredOn;
  }

  public LocalDate getAuthorizedOn() {
    return authorizedOn;
  }

  public String getProviderDescription() {
    return providerDescription;
  }

  public boolean isDescriptionValid() {
    return descriptionValid;
  }

  public String getPendingPredecessorDigest() {
    return pendingPredecessorDigest;
  }

  public String getInvalidReason() {
    return invalidReason;
  }

  public String getProviderMerchantIdentityDigest() {
    return providerMerchantIdentityDigest;
  }

  public String getMerchantDisplayName() {
    return merchantDisplayName;
  }

  public String getPfcPrimaryCode() {
    return pfcPrimaryCode;
  }

  public String getPfcDetailCode() {
    return pfcDetailCode;
  }

  public String getCategorizationEvidenceFingerprint() {
    return categorizationEvidenceFingerprint;
  }

  public String getDismissedReason() {
    return dismissedReason;
  }

  public Instant getDismissedAt() {
    return dismissedAt;
  }

  public int getVersion() {
    return version;
  }

  public boolean isTombstone() {
    return tombstone;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  /**
   * Applies a provider revision. A material change (state, money, currency, posted date) bumps the
   * version and either reopens a dismissed candidate or marks an admitted entry as modified;
   * cosmetic metadata updates stored evidence without a version bump. Categorization evidence
   * always refreshes: it is stored for later deterministic work, but only a {@code
   * providerRevision} change is material, so a category/name-only provider update never reopens a
   * dismissed item or marks an admitted entry modified.
   */
  public void revise(
      UUID accountMappingId,
      String state,
      String providerRevision,
      BigDecimal amount,
      String currency,
      LocalDate occurredOn,
      LocalDate authorizedOn,
      String providerDescription,
      boolean descriptionValid,
      String pendingPredecessorDigest,
      String providerMerchantIdentityDigest,
      String merchantDisplayName,
      String pfcPrimaryCode,
      String pfcDetailCode,
      String categorizationEvidenceFingerprint,
      boolean materialChange,
      Instant now) {
    this.accountMappingId = accountMappingId;
    this.state = state;
    this.providerRevision = providerRevision;
    this.amount = amount;
    this.currency = currency;
    this.occurredOn = occurredOn;
    this.authorizedOn = authorizedOn;
    this.providerDescription = providerDescription;
    this.descriptionValid = descriptionValid;
    this.pendingPredecessorDigest = pendingPredecessorDigest;
    this.invalidReason = null;
    this.tombstone = false;
    this.providerMerchantIdentityDigest = providerMerchantIdentityDigest;
    this.merchantDisplayName = merchantDisplayName;
    this.pfcPrimaryCode = pfcPrimaryCode;
    this.pfcDetailCode = pfcDetailCode;
    this.categorizationEvidenceFingerprint = categorizationEvidenceFingerprint;
    if (materialChange) {
      this.version += 1;
      if ("DISMISSED".equals(reviewState)) {
        this.reviewState = "UNREVIEWED";
        this.dismissedReason = null;
        this.dismissedAt = null;
      } else if ("CONFIRMED".equals(reviewState) && !providerRevision.equals(admittedRevision)) {
        this.changeState = "MODIFIED";
      }
    }
    this.updatedAt = now;
  }

  /**
   * Quarantines an identifiable invalid observation with a safe reason; it stays private. The
   * tombstone marker is cleared so an invalid revision of a previously removed identity is a valid
   * INVALID row rather than an illegal removed tombstone.
   */
  public void quarantine(String reason, Instant now) {
    this.state = "INVALID";
    this.invalidReason = reason;
    this.tombstone = false;
    this.version += 1;
    this.updatedAt = now;
  }

  /**
   * Flags one coalesced review item when the newest provider revision cannot be applied because the
   * observation is already admitted; confirmed ledger facts are never overwritten by sync.
   */
  public void flagModified(Instant now) {
    if ("CONFIRMED".equals(reviewState)) {
      this.changeState = "MODIFIED";
    }
    this.updatedAt = now;
  }

  /** Provider removal: retained tombstone for unadmitted items, review marker for admitted ones. */
  public void removed(Instant now) {
    this.state = "REMOVED";
    this.tombstone = true;
    this.version += 1;
    if ("CONFIRMED".equals(reviewState)) {
      this.changeState = "REMOVED";
    }
    this.updatedAt = now;
  }

  /**
   * Confirmation records the accepted revision; a second confirmation is blocked by association.
   */
  public void admitted(String admittedRevision, Instant now) {
    this.reviewState = "CONFIRMED";
    this.admittedRevision = admittedRevision;
    this.changeState = null;
    this.version += 1;
    this.updatedAt = now;
  }

  /** Dismissal is available for any unadmitted observation; it is not a ledger decision. */
  public void dismissed(String reason, Instant now) {
    this.reviewState = "DISMISSED";
    this.dismissedReason = reason;
    this.dismissedAt = now;
    this.version += 1;
    this.updatedAt = now;
  }

  public boolean isConfirmable() {
    return "POSTED".equals(state) && "UNREVIEWED".equals(reviewState);
  }
}
