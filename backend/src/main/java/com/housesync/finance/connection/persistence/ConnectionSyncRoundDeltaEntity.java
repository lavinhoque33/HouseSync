package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import java.io.Serializable;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Objects;
import java.util.UUID;

/**
 * One staged provider delta inside a fenced round. Facts are normalized to exact application values
 * during staging; an identifiable invalid observation keeps its {@code invalidReason} and is
 * quarantined on commit. Account and transaction identities persist as digests only.
 */
@Entity
@Table(name = "connection_sync_round_deltas")
@IdClass(ConnectionSyncRoundDeltaEntity.Key.class)
public class ConnectionSyncRoundDeltaEntity {

  @Id
  @Column(name = "round_id", nullable = false)
  private UUID roundId;

  @Id
  @Column(nullable = false)
  private int sequence;

  @Column(name = "remote_transaction_digest", nullable = false, length = 64)
  private String remoteTransactionDigest;

  @Column(name = "remote_account_digest", length = 64)
  private String remoteAccountDigest;

  @Column(nullable = false)
  private boolean removed;

  @Column(nullable = false)
  private boolean pending;

  @Column(name = "provider_revision", length = 64)
  private String providerRevision;

  @Column(precision = 15, scale = 3)
  private BigDecimal amount;

  @Column(length = 3)
  private String currency;

  @Column(name = "occurred_on")
  private LocalDate occurredOn;

  @Column(name = "authorized_on")
  private LocalDate authorizedOn;

  @Column(length = 500)
  private String description;

  @Column(name = "description_valid", nullable = false)
  private boolean descriptionValid;

  @Column(name = "pending_predecessor_digest", length = 64)
  private String pendingPredecessorDigest;

  @Column(name = "invalid_reason", length = 64)
  private String invalidReason;

  protected ConnectionSyncRoundDeltaEntity() {}

  public ConnectionSyncRoundDeltaEntity(
      UUID roundId,
      int sequence,
      String remoteTransactionDigest,
      String remoteAccountDigest,
      boolean removed,
      boolean pending,
      String providerRevision,
      BigDecimal amount,
      String currency,
      LocalDate occurredOn,
      LocalDate authorizedOn,
      String description,
      boolean descriptionValid,
      String pendingPredecessorDigest,
      String invalidReason) {
    this.roundId = roundId;
    this.sequence = sequence;
    this.remoteTransactionDigest = remoteTransactionDigest;
    this.remoteAccountDigest = remoteAccountDigest;
    this.removed = removed;
    this.pending = pending;
    this.providerRevision = providerRevision;
    this.amount = amount;
    this.currency = currency;
    this.occurredOn = occurredOn;
    this.authorizedOn = authorizedOn;
    this.description = description;
    this.descriptionValid = descriptionValid;
    this.pendingPredecessorDigest = pendingPredecessorDigest;
    this.invalidReason = invalidReason;
  }

  public UUID getRoundId() {
    return roundId;
  }

  public int getSequence() {
    return sequence;
  }

  public String getRemoteTransactionDigest() {
    return remoteTransactionDigest;
  }

  public String getRemoteAccountDigest() {
    return remoteAccountDigest;
  }

  public boolean isRemoved() {
    return removed;
  }

  public boolean isPending() {
    return pending;
  }

  /** Normalized observation state this staged delta applies: PENDING, POSTED, or REMOVED. */
  public String getState() {
    if (removed) {
      return "REMOVED";
    }
    return pending ? "PENDING" : "POSTED";
  }

  public String getProviderRevision() {
    return providerRevision;
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

  public String getDescription() {
    return description;
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

  /** Composite key (round, sequence); deltas are always read in ascending sequence order. */
  public static final class Key implements Serializable {
    private UUID roundId;
    private int sequence;

    public Key() {}

    public Key(UUID roundId, int sequence) {
      this.roundId = roundId;
      this.sequence = sequence;
    }

    @Override
    public boolean equals(Object other) {
      if (this == other) return true;
      if (!(other instanceof Key key)) return false;
      return sequence == key.sequence && Objects.equals(roundId, key.roundId);
    }

    @Override
    public int hashCode() {
      return Objects.hash(roundId, sequence);
    }
  }
}
