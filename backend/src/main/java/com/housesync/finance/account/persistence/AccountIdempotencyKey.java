package com.housesync.finance.account.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class AccountIdempotencyKey implements Serializable {

  @Column(name = "actor_user_id", nullable = false)
  private UUID actorUserId;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(nullable = false, length = 32)
  private String operation;

  @Column(name = "idempotency_key", nullable = false)
  private UUID idempotencyKey;

  protected AccountIdempotencyKey() {}

  public AccountIdempotencyKey(
      UUID actorUserId, UUID householdId, String operation, UUID idempotencyKey) {
    this.actorUserId = actorUserId;
    this.householdId = householdId;
    this.operation = operation;
    this.idempotencyKey = idempotencyKey;
  }

  @Override
  public boolean equals(Object other) {
    if (this == other) return true;
    if (!(other instanceof AccountIdempotencyKey that)) return false;
    return Objects.equals(actorUserId, that.actorUserId)
        && Objects.equals(householdId, that.householdId)
        && Objects.equals(operation, that.operation)
        && Objects.equals(idempotencyKey, that.idempotencyKey);
  }

  @Override
  public int hashCode() {
    return Objects.hash(actorUserId, householdId, operation, idempotencyKey);
  }
}
