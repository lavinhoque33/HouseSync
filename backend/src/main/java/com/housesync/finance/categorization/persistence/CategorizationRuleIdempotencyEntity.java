package com.housesync.finance.categorization.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** Persisted rule-creation key association for a categorization rule; retained indefinitely. */
@Entity
@Table(name = "categorization_rule_idempotency_keys")
public class CategorizationRuleIdempotencyEntity {

  @EmbeddedId private CategorizationRuleIdempotencyKey id;

  @Column(name = "request_fingerprint", nullable = false, length = 64)
  private String requestFingerprint;

  @Column(name = "resource_id", nullable = false)
  private UUID resourceId;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected CategorizationRuleIdempotencyEntity() {}

  public CategorizationRuleIdempotencyEntity(
      CategorizationRuleIdempotencyKey id,
      String requestFingerprint,
      UUID resourceId,
      Instant createdAt) {
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
