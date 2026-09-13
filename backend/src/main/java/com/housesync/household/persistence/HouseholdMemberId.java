package com.housesync.household.persistence;

import java.io.Serial;
import java.io.Serializable;
import java.util.UUID;

/** Composite membership key: a membership is identified by {@code (household_id, user_id)}. */
public class HouseholdMemberId implements Serializable {

  @Serial private static final long serialVersionUID = 1L;

  private UUID householdId;
  private UUID userId;

  protected HouseholdMemberId() {}

  public HouseholdMemberId(UUID householdId, UUID userId) {
    this.householdId = householdId;
    this.userId = userId;
  }

  public UUID getHouseholdId() {
    return householdId;
  }

  public UUID getUserId() {
    return userId;
  }

  @Override
  public boolean equals(Object other) {
    if (this == other) {
      return true;
    }
    if (!(other instanceof HouseholdMemberId that)) {
      return false;
    }
    return householdId.equals(that.householdId) && userId.equals(that.userId);
  }

  @Override
  public int hashCode() {
    return 31 * householdId.hashCode() + userId.hashCode();
  }
}
