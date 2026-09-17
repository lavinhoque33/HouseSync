package com.housesync.finance.connection.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Durable completion/disconnect operation behind the polling GET. Terminal rows and their domain
 * changes commit atomically; retries with the same idempotency key return the persisted row instead
 * of repeating external calls.
 */
@Entity
@Table(name = "connection_operations")
public class ConnectionOperationEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "connection_id")
  private UUID connectionId;

  @Column(name = "attempt_id")
  private UUID attemptId;

  @Column(name = "operation_type", nullable = false, length = 32)
  private String operationType;

  @Column(nullable = false, length = 16)
  private String state;

  @Column(name = "error_code", length = 64)
  private String errorCode;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected ConnectionOperationEntity() {}

  public ConnectionOperationEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID connectionId,
      UUID attemptId,
      String operationType,
      Instant now) {
    this.id = id;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.connectionId = connectionId;
    this.attemptId = attemptId;
    this.operationType = operationType;
    this.state = "PENDING";
    this.createdAt = now;
    this.updatedAt = now;
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

  public UUID getConnectionId() {
    return connectionId;
  }

  public String getAttemptId() {
    return attemptId == null ? null : attemptId.toString();
  }

  public UUID getAttemptUuid() {
    return attemptId;
  }

  public String getOperationType() {
    return operationType;
  }

  public String getState() {
    return state;
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

  public void bindConnection(UUID connectionId, Instant now) {
    this.connectionId = connectionId;
    this.updatedAt = now;
  }

  public void finish(String state, String errorCode, Instant now) {
    this.state = state;
    this.errorCode = errorCode;
    this.updatedAt = now;
  }
}
