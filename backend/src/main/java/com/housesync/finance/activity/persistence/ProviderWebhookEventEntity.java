package com.housesync.finance.activity.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Verified webhook replay fingerprint. The triplet (provider, environment, signed-JWT hash, body
 * hash) is unique; a replay commits nothing new but still returns 200 after durable admission.
 * Fingerprints carry no payload and no provider identifier, and are retained at least 24 hours.
 */
@Entity
@Table(name = "provider_webhook_events")
public class ProviderWebhookEventEntity {

  @Id private UUID id;

  @Column(nullable = false, length = 16)
  private String provider;

  @Column(nullable = false, length = 16)
  private String environment;

  @Column(name = "signed_jwt_hash", nullable = false, length = 64)
  private String signedJwtHash;

  @Column(name = "body_hash", nullable = false, length = 64)
  private String bodyHash;

  @Column(name = "received_at", nullable = false)
  private Instant receivedAt;

  protected ProviderWebhookEventEntity() {}

  public ProviderWebhookEventEntity(
      UUID id,
      String provider,
      String environment,
      String signedJwtHash,
      String bodyHash,
      Instant receivedAt) {
    this.id = id;
    this.provider = provider;
    this.environment = environment;
    this.signedJwtHash = signedJwtHash;
    this.bodyHash = bodyHash;
    this.receivedAt = receivedAt;
  }

  public UUID getId() {
    return id;
  }

  public String getProvider() {
    return provider;
  }

  public String getEnvironment() {
    return environment;
  }

  public String getSignedJwtHash() {
    return signedJwtHash;
  }

  public String getBodyHash() {
    return bodyHash;
  }

  public Instant getReceivedAt() {
    return receivedAt;
  }
}
