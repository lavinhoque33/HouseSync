package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * One fenced sync round. The round records the original committed cursor, the working
 * page cursor, its connection generation and lease fence, and staged delta counts. Only the final
 * page may apply staged deltas and advance the Item-wide cursor; an abandoned round keeps the
 * original cursor and its staged rows are scrubbed after 24 hours.
 */
@Entity
@Table(name = "connection_sync_rounds")
public class ConnectionSyncRoundEntity {

  @Id private UUID id;

  @Column(name = "connection_id", nullable = false)
  private UUID connectionId;

  @Column(nullable = false)
  private long generation;

  @Column(name = "lease_fence", nullable = false)
  private long leaseFence;

  @Column(name = "original_cursor", columnDefinition = "TEXT")
  private String originalCursor;

  @Column(name = "next_cursor", columnDefinition = "TEXT")
  private String nextCursor;

  @Column(name = "has_more", nullable = false)
  private boolean hasMore;

  @Column(name = "delta_count", nullable = false)
  private int deltaCount;

  @Column(name = "byte_count", nullable = false)
  private long byteCount;

  @Column(name = "history_ready", nullable = false)
  private boolean historyReady;

  @Column(nullable = false, length = 16)
  private String state;

  @Column(name = "failure_code", length = 64)
  private String failureCode;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected ConnectionSyncRoundEntity() {}

  public ConnectionSyncRoundEntity(
      UUID id,
      UUID connectionId,
      long generation,
      long leaseFence,
      String originalCursor,
      Instant now) {
    this.id = id;
    this.connectionId = connectionId;
    this.generation = generation;
    this.leaseFence = leaseFence;
    this.originalCursor = originalCursor;
    this.nextCursor = originalCursor;
    this.hasMore = true;
    this.deltaCount = 0;
    this.byteCount = 0;
    this.historyReady = false;
    this.state = "STAGING";
    this.createdAt = now;
    this.updatedAt = now;
  }

  public UUID getId() {
    return id;
  }

  public UUID getConnectionId() {
    return connectionId;
  }

  public long getGeneration() {
    return generation;
  }

  public long getLeaseFence() {
    return leaseFence;
  }

  public String getOriginalCursor() {
    return originalCursor;
  }

  public String getNextCursor() {
    return nextCursor;
  }

  public boolean isHasMore() {
    return hasMore;
  }

  public int getDeltaCount() {
    return deltaCount;
  }

  public long getByteCount() {
    return byteCount;
  }

  public boolean isHistoryReady() {
    return historyReady;
  }

  public String getState() {
    return state;
  }

  public String getFailureCode() {
    return failureCode;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  /** Stages one fetched page; staged pages are never visible activity on their own. */
  public void stagePage(
      String nextCursor,
      boolean hasMore,
      int pageDeltaCount,
      long pageByteCount,
      boolean ready,
      Instant now) {
    this.nextCursor = nextCursor;
    this.hasMore = hasMore;
    this.deltaCount += pageDeltaCount;
    this.byteCount += pageByteCount;
    this.historyReady = this.historyReady || ready;
    this.updatedAt = now;
  }

  public void apply(Instant now) {
    this.state = "APPLIED";
    this.updatedAt = now;
  }

  public void abandon(String failureCode, Instant now) {
    this.state = "ABANDONED";
    this.failureCode = failureCode;
    this.updatedAt = now;
  }
}
