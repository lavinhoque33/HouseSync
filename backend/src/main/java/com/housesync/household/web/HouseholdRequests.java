package com.housesync.household.web;

/**
 * Household creation payload. Creation accepts only {@code name}; unknown JSON fields are rejected
 * by the global Jackson setting ({@code fail-on-unknown-properties}) so forged IDs, owners, roles,
 * memberships, or tenant context never bind.
 */
public final class HouseholdRequests {

  private HouseholdRequests() {}

  public record CreateHouseholdRequest(String name) {}
}
