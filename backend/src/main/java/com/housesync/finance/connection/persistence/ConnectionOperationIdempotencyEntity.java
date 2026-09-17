package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "connection_operation_idempotency_keys")
public class ConnectionOperationIdempotencyEntity {

  @EmbeddedId private ConnectionOperationIdempotencyKey id;

  @Column(name = "request_fingerprint", nullable = false, length = 64)
  private String requestFingerprint;

  @Column(name = "resource_id", nullable = false)
  private UUID resourceId;

  /**
   * HMAC key id active when a token-bearing fingerprint was reserved; replays recompute with this
   * key so encryption-key rotation never turns a legitimate retry into a conflict.
   */
  @Column(name = "hmac_key_id", length = 64)
  private String hmacKeyId;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected ConnectionOperationIdempotencyEntity() {}

  public ConnectionOperationIdempotencyEntity(
      ConnectionOperationIdempotencyKey id,
      String requestFingerprint,
      UUID resourceId,
      Instant createdAt) {
    this(id, requestFingerprint, resourceId, null, createdAt);
  }

  public ConnectionOperationIdempotencyEntity(
      ConnectionOperationIdempotencyKey id,
      String requestFingerprint,
      UUID resourceId,
      String hmacKeyId,
      Instant createdAt) {
    this.id = id;
    this.requestFingerprint = requestFingerprint;
    this.resourceId = resourceId;
    this.hmacKeyId = hmacKeyId;
    this.createdAt = createdAt;
  }

  public String getRequestFingerprint() {
    return requestFingerprint;
  }

  public UUID getResourceId() {
    return resourceId;
  }

  public String getHmacKeyId() {
    return hmacKeyId;
  }
}
