package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Durable remote-removal work for one connection. Queued in the same lifecycle transaction as the
 * local disconnect/suspension so the remote cleanup survives membership loss, restarts, and
 * ambiguous removal outcomes; the worker needs no membership to finish it.
 */
@Entity
@Table(name = "connection_revocation_work")
public class ConnectionRevocationWorkEntity {

  @Id private UUID id;

  @Column(name = "connection_id", nullable = false)
  private UUID connectionId;

  @Column(nullable = false, length = 16)
  private String state;

  @Column(name = "attempt_count", nullable = false)
  private int attemptCount;

  @Column(name = "lease_fence", nullable = false)
  private long leaseFence;

  @Column(name = "lease_owner", length = 64)
  private String leaseOwner;

  @Column(name = "lease_expires_at")
  private Instant leaseExpiresAt;

  @Column(name = "next_retry_at", nullable = false)
  private Instant nextRetryAt;

  @Column(name = "last_error", length = 64)
  private String lastError;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected ConnectionRevocationWorkEntity() {}

  public ConnectionRevocationWorkEntity(UUID id, UUID connectionId, Instant now) {
    this.id = id;
    this.connectionId = connectionId;
    this.state = "QUEUED";
    this.attemptCount = 0;
    this.nextRetryAt = now;
    this.createdAt = now;
    this.updatedAt = now;
  }

  public UUID getId() {
    return id;
  }

  public UUID getConnectionId() {
    return connectionId;
  }

  public String getState() {
    return state;
  }

  public int getAttemptCount() {
    return attemptCount;
  }

  public long getLeaseFence() {
    return leaseFence;
  }

  public String getLeaseOwner() {
    return leaseOwner;
  }

  public Instant getLeaseExpiresAt() {
    return leaseExpiresAt;
  }

  public Instant getNextRetryAt() {
    return nextRetryAt;
  }

  public String getLastError() {
    return lastError;
  }

  /**
   * Claims the row under a fencing lease: only the holder of the current fence and owner may commit
   * an outcome for this lease.
   */
  public void claim(String owner, Instant leaseExpiresAt, Instant now) {
    this.state = "IN_PROGRESS";
    this.attemptCount += 1;
    this.leaseFence += 1;
    this.leaseOwner = owner;
    this.leaseExpiresAt = leaseExpiresAt;
    this.updatedAt = now;
  }

  /** Owner retry after terminal failure receives a fresh attempt budget and a clear lease. */
  public void requeue(Instant now) {
    this.state = "QUEUED";
    this.attemptCount = 0;
    this.leaseOwner = null;
    this.leaseExpiresAt = null;
    this.lastError = null;
    this.nextRetryAt = now;
    this.updatedAt = now;
  }

  public void retryLater(String error, Instant nextRetryAt, Instant now) {
    this.state = "QUEUED";
    this.lastError = error;
    this.nextRetryAt = nextRetryAt;
    this.updatedAt = now;
  }

  public void fail(String error, Instant now) {
    this.state = "FAILED";
    this.lastError = error;
    this.updatedAt = now;
  }

  public void complete(Instant now) {
    this.state = "DONE";
    this.lastError = null;
    this.updatedAt = now;
  }
}
