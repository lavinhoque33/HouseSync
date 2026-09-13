package com.housesync.household.invitation.web;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Invitation DTOs. Creation returns the one-time secret exactly once; no other response contains
 * secret material, digests, creators, accepting users, household IDs, or terminal history.
 */
public final class InvitationResponses {

  private InvitationResponses() {}

  /** One-time capability response. The secret cannot be recovered after this response is lost. */
  public record InvitationCreatedResponse(
      UUID id, String secret, Instant createdAt, Instant expiresAt) {}

  /** Active invitation summary for the owner list. Ordered by creation instant then ID. */
  public record InvitationSummary(UUID id, Instant createdAt, Instant expiresAt) {}

  /** Active invitation collection. An empty list is valid; the list is unpaginated. */
  public record InvitationListResponse(List<InvitationSummary> invitations) {}

  /** Minimal recipient preview: household name, resulting role, and expiry only. */
  public record InvitationPreviewResponse(String householdName, String role, Instant expiresAt) {}
}
