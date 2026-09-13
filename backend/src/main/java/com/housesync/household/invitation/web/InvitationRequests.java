package com.housesync.household.invitation.web;

/**
 * Capability request payload for preview and acceptance. Accepts exactly the invitation ID and the
 * one-time secret; unknown JSON fields are rejected by the global Jackson setting ({@code
 * fail-on-unknown-properties}) so household IDs, user IDs, emails, roles, owners, expiries, and
 * statuses never bind.
 */
public final class InvitationRequests {

  private InvitationRequests() {}

  public record CapabilityRequest(String invitationId, String secret) {}
}
