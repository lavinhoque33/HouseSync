package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Discovered provider account behind a local mapping ID. The browser selects local mapping IDs
 * only; raw provider account identities persist solely as {@code remoteAccountDigest}.
 */
@Entity
@Table(name = "financial_connection_account_mappings")
public class ConnectionAccountMappingEntity {

  @Id private UUID id;

  @Column(name = "connection_id", nullable = false)
  private UUID connectionId;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "remote_account_digest", nullable = false, length = 64)
  private String remoteAccountDigest;

  @Column(name = "display_name", nullable = false, length = 100)
  private String displayName;

  /**
   * Provider classification for eligible mappings; null for ineligible accounts whose raw kind or
   * currency cannot be admitted, with the reason in {@code exclusionReason}.
   */
  @Column(length = 32)
  private String kind;

  @Column(length = 3)
  private String currency;

  @Column(name = "local_account_id")
  private UUID localAccountId;

  @Column(nullable = false)
  private boolean selected;

  @Column(nullable = false)
  private boolean eligible;

  @Column(name = "exclusion_reason", length = 64)
  private String exclusionReason;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  /** True once a committed import round covered this mapping while it was selected. */
  @Column(name = "history_imported", nullable = false)
  private boolean historyImported;

  protected ConnectionAccountMappingEntity() {}

  public ConnectionAccountMappingEntity(
      UUID id,
      UUID connectionId,
      UUID householdId,
      UUID ownerUserId,
      String remoteAccountDigest,
      String displayName,
      String kind,
      String currency,
      boolean eligible,
      String exclusionReason,
      Instant createdAt) {
    this.id = id;
    this.connectionId = connectionId;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.remoteAccountDigest = remoteAccountDigest;
    this.displayName = displayName;
    this.kind = kind;
    this.currency = currency;
    this.selected = false;
    this.eligible = eligible;
    this.exclusionReason = exclusionReason;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
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

  public String getRemoteAccountDigest() {
    return remoteAccountDigest;
  }

  public String getDisplayName() {
    return displayName;
  }

  public String getKind() {
    return kind;
  }

  public String getCurrency() {
    return currency;
  }

  public UUID getLocalAccountId() {
    return localAccountId;
  }

  public boolean isSelected() {
    return selected;
  }

  public boolean isEligible() {
    return eligible;
  }

  public String getExclusionReason() {
    return exclusionReason;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public void refreshMetadata(
      String displayName,
      String kind,
      String currency,
      boolean eligible,
      String exclusionReason,
      Instant now) {
    this.displayName = displayName;
    this.kind = kind;
    this.currency = currency;
    this.eligible = eligible;
    this.exclusionReason = exclusionReason;
    if (!eligible) {
      this.selected = false;
    }
    this.updatedAt = now;
  }

  public void admit(UUID localAccountId, Instant now) {
    this.localAccountId = localAccountId;
    this.selected = true;
    this.updatedAt = now;
  }

  public void setSelected(boolean selected, Instant now) {
    this.selected = selected;
    this.updatedAt = now;
  }

  public boolean isHistoryImported() {
    return historyImported;
  }

  /** A committed round covered this mapping; later selection changes preserve deduplication. */
  public void markHistoryImported(Instant now) {
    this.historyImported = true;
    this.updatedAt = now;
  }

  /**
   * Provider metadata that contradicts an already-admitted account identity never rewrites the
   * admitted kind or currency. The mapping is deselected and marked ineligible so conflicting
   * observations are blocked from admission until the owner resolves the conflict.
   */
  public void blockIdentityConflict(String exclusionReason, Instant now) {
    this.selected = false;
    this.eligible = false;
    this.exclusionReason = exclusionReason;
    this.updatedAt = now;
  }
}
