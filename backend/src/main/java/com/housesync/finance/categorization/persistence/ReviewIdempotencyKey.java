package com.housesync.finance.categorization.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class ReviewIdempotencyKey implements Serializable {
  @Column(name = "actor_user_id", nullable = false)
  private UUID actorUserId;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "idempotency_key", nullable = false)
  private UUID idempotencyKey;

  protected ReviewIdempotencyKey() {}

  public ReviewIdempotencyKey(UUID actor, UUID household, UUID key) {
    this.actorUserId = actor;
    this.householdId = household;
    this.idempotencyKey = key;
  }

  @Override
  public boolean equals(Object other) {
    return this == other
        || other instanceof ReviewIdempotencyKey that
            && Objects.equals(actorUserId, that.actorUserId)
            && Objects.equals(householdId, that.householdId)
            && Objects.equals(idempotencyKey, that.idempotencyKey);
  }

  @Override
  public int hashCode() {
    return Objects.hash(actorUserId, householdId, idempotencyKey);
  }
}
