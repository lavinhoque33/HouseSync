package com.housesync.household.web;

/**
 * Household write payloads. Unknown JSON fields are rejected by the global Jackson setting ({@code
 * fail-on-unknown-properties}) so forged IDs, owners, memberships, or tenant context never bind.
 */
public final class HouseholdRequests {

  private HouseholdRequests() {}

  public record CreateHouseholdRequest(String name) {}

  public record UpdateMemberRoleRequest(String role) {}
}
