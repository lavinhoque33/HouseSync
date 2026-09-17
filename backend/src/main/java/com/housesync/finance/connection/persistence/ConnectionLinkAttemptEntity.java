package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Expiring NEW/UPDATE link attempt. Link tokens are ephemeral response values; the encrypted copy
 * exists only for replay while valid and is erased on terminal outcome or expiry, as is any queued
 * public token.
 */
@Entity
@Table(name = "connection_link_attempts")
public class ConnectionLinkAttemptEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(nullable = false, length = 8)
  private String flow;

  @Column(nullable = false, length = 16)
  private String environment;

  @Column(name = "connection_id")
  private UUID connectionId;

  @Column(nullable = false, length = 32)
  private String state;

  @Column(name = "encrypted_link_token", columnDefinition = "TEXT")
  private String encryptedLinkToken;

  @Column(name = "link_token_key_id", length = 64)
  private String linkTokenKeyId;

  @Column(name = "link_token_expires_at")
  private Instant linkTokenExpiresAt;

  @Column(name = "encrypted_public_token", columnDefinition = "TEXT")
  private String encryptedPublicToken;

  @Column(name = "public_token_key_id", length = 64)
  private String publicTokenKeyId;

  @Column(name = "operation_id")
  private UUID operationId;

  @Column(name = "expected_generation")
  private Long expectedGeneration;

  @Column(name = "error_code", length = 64)
  private String errorCode;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  @Column(name = "expires_at", nullable = false)
  private Instant expiresAt;

  protected ConnectionLinkAttemptEntity() {}

  public ConnectionLinkAttemptEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      String flow,
      String environment,
      UUID connectionId,
      Instant now,
      Instant expiresAt) {
    this.id = id;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.flow = flow;
    this.environment = environment;
    this.connectionId = connectionId;
    this.state = "LINK_TOKEN_ISSUED";
    this.createdAt = now;
    this.updatedAt = now;
    this.expiresAt = expiresAt;
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

  public String getFlow() {
    return flow;
  }

  public String getEnvironment() {
    return environment;
  }

  public UUID getConnectionId() {
    return connectionId;
  }

  public String getState() {
    return state;
  }

  public String getEncryptedLinkToken() {
    return encryptedLinkToken;
  }

  public String getLinkTokenKeyId() {
    return linkTokenKeyId;
  }

  public Instant getLinkTokenExpiresAt() {
    return linkTokenExpiresAt;
  }

  public String getEncryptedPublicToken() {
    return encryptedPublicToken;
  }

  public String getPublicTokenKeyId() {
    return publicTokenKeyId;
  }

  public UUID getOperationId() {
    return operationId;
  }

  public Long getExpectedGeneration() {
    return expectedGeneration;
  }

  public void setExpectedGeneration(Long expectedGeneration) {
    this.expectedGeneration = expectedGeneration;
  }

  public String getErrorCode() {
    return errorCode;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public Instant getExpiresAt() {
    return expiresAt;
  }

  public void storeLinkToken(String encrypted, String keyId, Instant tokenExpiresAt, Instant now) {
    this.encryptedLinkToken = encrypted;
    this.linkTokenKeyId = keyId;
    this.linkTokenExpiresAt = tokenExpiresAt;
    this.updatedAt = now;
  }

  public void beginExchange(
      UUID operationId, String encryptedPublicToken, String keyId, Instant now) {
    this.state = "EXCHANGING";
    this.operationId = operationId;
    this.encryptedPublicToken = encryptedPublicToken;
    this.publicTokenKeyId = keyId;
    this.updatedAt = now;
  }

  public void beginUpdateCompletion(UUID operationId, Instant now) {
    this.state = "EXCHANGING";
    this.operationId = operationId;
    this.updatedAt = now;
  }

  /** Terminal transition; always scrubs both transient tokens. */
  public void finish(String state, UUID connectionId, String errorCode, Instant now) {
    this.state = state;
    if (connectionId != null) {
      this.connectionId = connectionId;
    }
    this.errorCode = errorCode;
    this.encryptedLinkToken = null;
    this.linkTokenKeyId = null;
    this.encryptedPublicToken = null;
    this.publicTokenKeyId = null;
    this.updatedAt = now;
  }
}
