package com.housesync.finance.categorization.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "categorization_review_idempotency_keys")
public class CategorizationReviewIdempotency {
  @EmbeddedId private ReviewIdempotencyKey id;

  @Column(name = "request_fingerprint", nullable = false, length = 64)
  private String requestFingerprint;

  @Column(name = "review_id", nullable = false)
  private UUID reviewId;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected CategorizationReviewIdempotency() {}

  public CategorizationReviewIdempotency(
      ReviewIdempotencyKey id, String fingerprint, UUID reviewId, Instant now) {
    this.id = id;
    this.requestFingerprint = fingerprint;
    this.reviewId = reviewId;
    this.createdAt = now;
  }

  public String getRequestFingerprint() {
    return requestFingerprint;
  }

  public UUID getReviewId() {
    return reviewId;
  }
}
