package com.housesync.household.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Household row. The name is a non-unique display value stored already outer-trimmed; identity and
 * authorization use the opaque UUID and the membership table, never the name. The reporting time
 * zone is an application-validated IANA region name (initially {@code Etc/UTC}), and {@code
 * version} is the optimistic concurrency token for owner-only settings updates, mirroring the
 * finance version convention.
 */
@Entity
@Table(name = "households")
public class HouseholdEntity {

  /** Documented initial reporting zone for existing (via migration default) and new households. */
  public static final String INITIAL_REPORTING_TIME_ZONE = "Etc/UTC";

  @Id private UUID id;

  @Column(nullable = false, length = 100)
  private String name;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "reporting_time_zone", nullable = false, length = 64)
  private String reportingTimeZone = INITIAL_REPORTING_TIME_ZONE;

  @Column(nullable = false)
  private int version;

  protected HouseholdEntity() {}

  public HouseholdEntity(UUID id, String name, Instant createdAt) {
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
    this.reportingTimeZone = INITIAL_REPORTING_TIME_ZONE;
    this.version = 0;
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

  public String getReportingTimeZone() {
    return reportingTimeZone;
  }

  public int getVersion() {
    return version;
  }

  /** One owner-authorized reporting-zone change: the zone moves and the version bumps once. */
  public void updateReportingTimeZone(String reportingTimeZone) {
    this.reportingTimeZone = reportingTimeZone;
    this.version += 1;
  }
}
