package com.housesync.finance.transaction.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** Persisted create-key association for a transaction; retained for the resource's lifetime. */
@Entity
@Table(name = "financial_transaction_idempotency_keys")
public class TransactionIdempotencyEntity {

  @EmbeddedId private TransactionIdempotencyKey id;

  @Column(name = "request_fingerprint", nullable = false, length = 64)
  private String requestFingerprint;

  @Column(name = "resource_id", nullable = false)
  private UUID resourceId;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected TransactionIdempotencyEntity() {}

  public TransactionIdempotencyEntity(
      TransactionIdempotencyKey id, String requestFingerprint, UUID resourceId, Instant createdAt) {
    this.id = id;
    this.requestFingerprint = requestFingerprint;
    this.resourceId = resourceId;
    this.createdAt = createdAt;
  }

  public String getRequestFingerprint() {
    return requestFingerprint;
  }

  public UUID getResourceId() {
    return resourceId;
  }
}
