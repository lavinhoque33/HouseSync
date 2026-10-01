package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Durable coalescing sync demand. {@code demandSequence} is monotonic: a webhook that arrives while
 * a round is running increments it, so the finishing worker schedules another round instead of
 * losing the wake-up. A round claims a fence and lease; only the current fence holder may commit an
 * outcome or advance the committed sequence.
 */
@Entity
@Table(name = "connection_sync_work")
public class ConnectionSyncWorkEntity {

  @Id private UUID id;

  @Column(name = "connection_id", nullable = false)
  private UUID connectionId;

  @Column(nullable = false, length = 16)
  private String state;

  @Column(name = "demand_sequence", nullable = false)
  private long demandSequence;

  @Column(name = "committed_sequence", nullable = false)
  private long committedSequence;

  @Column(name = "attempt_count", nullable = false)
  private int attemptCount;

  @Column(name = "next_retry_at")
  private Instant nextRetryAt;

  @Column(name = "lease_owner", length = 64)
  private String leaseOwner;

  @Column(name = "lease_expires_at")
  private Instant leaseExpiresAt;

  @Column(name = "lease_fence", nullable = false)
  private long leaseFence;

  @Column(name = "last_error", length = 64)
  private String lastError;

  @Column(name = "last_manual_sync_at")
  private Instant lastManualSyncAt;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected ConnectionSyncWorkEntity() {}

  public ConnectionSyncWorkEntity(UUID id, UUID connectionId, Instant now) {
    this.id = id;
    this.connectionId = connectionId;
    this.state = "IDLE";
    this.demandSequence = 0;
    this.committedSequence = 0;
    this.attemptCount = 0;
    this.leaseFence = 0;
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

  public long getDemandSequence() {
    return demandSequence;
  }

  public long getCommittedSequence() {
    return committedSequence;
  }

  public int getAttemptCount() {
    return attemptCount;
  }

  public Instant getNextRetryAt() {
    return nextRetryAt;
  }

  public String getLeaseOwner() {
    return leaseOwner;
  }

  public Instant getLeaseExpiresAt() {
    return leaseExpiresAt;
  }

  public long getLeaseFence() {
    return leaseFence;
  }

  public String getLastError() {
    return lastError;
  }

  public Instant getLastManualSyncAt() {
    return lastManualSyncAt;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  /** Registers one demand; a running round keeps its lease and closes the demand afterwards. */
  public void demand(Instant now) {
    this.demandSequence += 1;
    if (!"RUNNING".equals(state)) {
      this.state = "QUEUED";
      this.nextRetryAt = null;
      this.lastError = null;
    }
    this.updatedAt = now;
  }

  /**
   * Records an owner-visible manual sync attempt before queueing it. Rate limiting reads this
   * timestamp, so it is written inside the same lifecycle transaction as the demand.
   */
  public void markManualSync(Instant now) {
    this.lastManualSyncAt = now;
    this.updatedAt = now;
  }

  /** An explicit owner retry (manual sync) clears a visible failure and its retry backoff. */
  public void resetFailure(Instant now) {
    this.attemptCount = 0;
    this.lastError = null;
    this.nextRetryAt = null;
    this.updatedAt = now;
  }

  /** Claims the next round: a fresh fence, exclusive lease, and the claimed demand sequence. */
  public long claim(String owner, Instant leaseExpiresAt, Instant now) {
    this.leaseFence += 1;
    this.leaseOwner = owner;
    this.leaseExpiresAt = leaseExpiresAt;
    this.state = "RUNNING";
    this.updatedAt = now;
    return this.leaseFence;
  }

  /** Commits one finished round; pending demand immediately schedules the next one. */
  public void succeed(long claimedSequence, boolean demandPending, Instant now) {
    this.committedSequence = Math.max(this.committedSequence, claimedSequence);
    this.attemptCount = 0;
    this.lastError = null;
    this.nextRetryAt = null;
    this.leaseOwner = null;
    this.leaseExpiresAt = null;
    this.state = demandPending ? "QUEUED" : "IDLE";
    this.updatedAt = now;
  }

  /** Records a retryable round failure; the original cursor is retained by design. */
  public void retryLater(String error, Instant nextRetryAt, Instant now) {
    this.attemptCount += 1;
    this.lastError = error;
    this.nextRetryAt = nextRetryAt;
    this.leaseOwner = null;
    this.leaseExpiresAt = null;
    this.state = "RETRY_WAIT";
    this.updatedAt = now;
  }

  /** Terminal visible failure: the cursor is retained and an owner retry or schedule resumes. */
  public void fail(String error, Instant now) {
    this.attemptCount += 1;
    this.lastError = error;
    this.nextRetryAt = null;
    this.leaseOwner = null;
    this.leaseExpiresAt = null;
    this.state = "FAILED";
    this.updatedAt = now;
  }

  /** A superseded worker abandons its claim without touching the committed sequence. */
  public void releaseLease(Instant now) {
    this.leaseOwner = null;
    this.leaseExpiresAt = null;
    this.updatedAt = now;
  }

  /** Lease ownership check for every commit; a reclaim invalidates the previous holder. */
  public boolean leaseHeldBy(String owner, long fence, Instant now) {
    return "RUNNING".equals(state)
        && owner != null
        && owner.equals(leaseOwner)
        && leaseFence == fence
        && leaseExpiresAt != null
        && leaseExpiresAt.isAfter(now);
  }
}
