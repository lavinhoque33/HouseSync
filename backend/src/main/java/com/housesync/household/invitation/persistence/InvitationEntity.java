package com.housesync.household.invitation.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Capability invitation row. Persists only the SHA-256 digest of the 32 random secret bytes, never
 * the raw secret. State is derived from {@code acceptedAt}/{@code acceptedByUserId}, {@code
 * revokedAt}, and {@code expiresAt}; there is no status enum, role, email, or recipient data.
 */
@Entity
@Table(name = "household_invitations")
public class InvitationEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "created_by_user_id", nullable = false)
  private UUID createdByUserId;

  @Column(name = "secret_hash", nullable = false)
  private byte[] secretHash;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "expires_at", nullable = false)
  private Instant expiresAt;

  @Column(name = "accepted_at")
  private Instant acceptedAt;

  @Column(name = "accepted_by_user_id")
  private UUID acceptedByUserId;

  @Column(name = "revoked_at")
  private Instant revokedAt;

  protected InvitationEntity() {}

  public InvitationEntity(
      UUID id,
      UUID householdId,
      UUID createdByUserId,
      byte[] secretHash,
      Instant createdAt,
      Instant expiresAt) {
    this.id = id;
    this.householdId = householdId;
    this.createdByUserId = createdByUserId;
    this.secretHash = secretHash.clone();
    this.createdAt = createdAt;
    this.expiresAt = expiresAt;
  }

  public UUID getId() {
    return id;
  }

  public UUID getHouseholdId() {
    return householdId;
  }

  public UUID getCreatedByUserId() {
    return createdByUserId;
  }

  public byte[] getSecretHash() {
    return secretHash.clone();
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getExpiresAt() {
    return expiresAt;
  }

  public Instant getAcceptedAt() {
    return acceptedAt;
  }

  public UUID getAcceptedByUserId() {
    return acceptedByUserId;
  }

  public Instant getRevokedAt() {
    return revokedAt;
  }

  public void setAcceptedAt(Instant acceptedAt) {
    this.acceptedAt = acceptedAt;
  }

  public void setAcceptedByUserId(UUID acceptedByUserId) {
    this.acceptedByUserId = acceptedByUserId;
  }

  public void setRevokedAt(Instant revokedAt) {
    this.revokedAt = revokedAt;
  }
}
