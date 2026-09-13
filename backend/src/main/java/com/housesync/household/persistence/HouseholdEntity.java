package com.housesync.household.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Household row. The name is a non-unique display value stored already outer-trimmed; identity and
 * authorization use the opaque UUID and the membership table, never the name.
 */
@Entity
@Table(name = "households")
public class HouseholdEntity {

  @Id private UUID id;

  @Column(nullable = false, length = 100)
  private String name;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected HouseholdEntity() {}

  public HouseholdEntity(UUID id, String name, Instant createdAt) {
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
  }

  public UUID getId() {
    return id;
  }

  public String getName() {
    return name;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }
}
