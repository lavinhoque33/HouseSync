package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * One private provider Item bound to a household and its stable owner. Raw provider Item identities
 * are never stored; {@code remoteItemDigest} is the hex SHA-256 over a stable
 * provider/environment/remote-identity string and carries the cross-connection uniqueness scope.
 * Access credentials stay encrypted until confirmed remote removal.
 */
@Entity
@Table(name = "financial_connections")
public class FinancialConnectionEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(nullable = false, length = 16)
  private String provider;

  @Column(nullable = false, length = 16)
  private String environment;

  @Column(name = "remote_item_digest", nullable = false, length = 64)
  private String remoteItemDigest;

  @Column(nullable = false, length = 16)
  private String state;

  @Column(nullable = false)
  private long generation;

  @Column(nullable = false)
  private int version;

  @Column(name = "encrypted_credential", columnDefinition = "TEXT")
  private String encryptedCredential;

  @Column(name = "credential_key_id", length = 64)
  private String credentialKeyId;

  @Column(columnDefinition = "TEXT")
  private String cursor;

  @Column(name = "last_successful_sync_at")
  private Instant lastSuccessfulSyncAt;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected FinancialConnectionEntity() {}

  public FinancialConnectionEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      String provider,
      String environment,
      String remoteItemDigest,
      String encryptedCredential,
      String credentialKeyId,
      Instant createdAt) {
    this.id = id;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.provider = provider;
    this.environment = environment;
    this.remoteItemDigest = remoteItemDigest;
    this.state = "ACTIVE";
    this.generation = 0;
    this.version = 0;
    this.encryptedCredential = encryptedCredential;
    this.credentialKeyId = credentialKeyId;
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

  public String getProvider() {
    return provider;
  }

  public String getEnvironment() {
    return environment;
  }

  public String getRemoteItemDigest() {
    return remoteItemDigest;
  }

  public String getState() {
    return state;
  }

  public long getGeneration() {
    return generation;
  }

  public int getVersion() {
    return version;
  }

  public String getEncryptedCredential() {
    return encryptedCredential;
  }

  public String getCredentialKeyId() {
    return credentialKeyId;
  }

  public String getCursor() {
    return cursor;
  }

  public Instant getLastSuccessfulSyncAt() {
    return lastSuccessfulSyncAt;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  /** State change with exactly one version bump; generation moves only through fencing events. */
  public void transition(String nextState, Instant now) {
    this.state = nextState;
    bumpVersion(now);
  }

  /** Fencing event: invalidates in-flight workers, then records the state change. */
  public void fence(String nextState, Instant now) {
    this.generation += 1;
    this.state = nextState;
    bumpVersion(now);
  }

  /** Reconnect start: bumps generation and version together, staying in the current state. */
  public void beginReconnect(Instant now) {
    this.generation += 1;
    bumpVersion(now);
  }

  public void refreshCredential(String encryptedCredential, String keyId, Instant now) {
    this.encryptedCredential = encryptedCredential;
    this.credentialKeyId = keyId;
    bumpVersion(now);
  }

  /** Confirmed remote removal: erases credentials and cursor while retaining local history. */
  public void confirmRemoteRemoval(Instant now) {
    this.encryptedCredential = null;
    this.credentialKeyId = null;
    this.cursor = null;
    this.state = "DISCONNECTED";
    bumpVersion(now);
  }

  private void bumpVersion(Instant now) {
    if (version == Integer.MAX_VALUE) {
      throw new IllegalStateException("connection version exhausted");
    }
    this.version += 1;
    this.updatedAt = now;
  }
}
