package com.housesync.household.persistence;

import com.housesync.household.domain.MemberRole;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import java.util.UUID;

/**
 * Membership row linking a household to a user with a stable role. The composite primary key is
 * authoritative under concurrency: a second owner row for the same pair cannot be created.
 */
@Entity
@Table(name = "household_members")
@IdClass(HouseholdMemberId.class)
public class HouseholdMemberEntity {

  @Id
  @Column(name = "household_id")
  private UUID householdId;

  @Id
  @Column(name = "user_id")
  private UUID userId;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private MemberRole role;

  protected HouseholdMemberEntity() {}

  public HouseholdMemberEntity(UUID householdId, UUID userId, MemberRole role) {
    this.householdId = householdId;
    this.userId = userId;
    this.role = role;
  }

  public UUID getHouseholdId() {
    return householdId;
  }

  public UUID getUserId() {
    return userId;
  }

  public MemberRole getRole() {
    return role;
  }
}
