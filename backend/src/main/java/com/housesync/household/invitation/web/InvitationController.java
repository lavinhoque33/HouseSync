package com.housesync.household.invitation.web;

import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.web.InvitationRequests.CapabilityRequest;
import com.housesync.household.invitation.web.InvitationResponses.InvitationPreviewResponse;
import com.housesync.household.web.HouseholdResponse;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Authenticated recipient endpoints. Both take exactly the invitation ID and secret in a JSON body
 * with the session-backed CSRF header; the household always comes from the persisted invitation,
 * never from the request. Every response is non-cacheable JSON.
 */
@RestController
@RequestMapping("/api/invitations")
public class InvitationController {

  private final InvitationService invitations;

  public InvitationController(InvitationService invitations) {
    this.invitations = invitations;
  }

  /** Returns the minimal preview for an active invitation, else the generic invitation 404. */
  @PostMapping("/preview")
  public ResponseEntity<InvitationPreviewResponse> preview(
      @RequestBody(required = false) CapabilityRequest body, Authentication authentication) {
    requireBody(body);
    actorId(authentication);
    return noCache(HttpStatus.OK, invitations.preview(body.invitationId(), body.secret()));
  }

  /**
   * Accepts an invitation, granting {@code MEMBER} (or reporting the actor's current role when
   * already a member), and consumes the capability in the same transaction.
   */
  @PostMapping("/accept")
  public ResponseEntity<HouseholdResponse> accept(
      @RequestBody(required = false) CapabilityRequest body, Authentication authentication) {
    requireBody(body);
    UUID actorId = actorId(authentication);
    return noCache(HttpStatus.OK, invitations.accept(body.invitationId(), body.secret(), actorId));
  }

  private static void requireBody(CapabilityRequest body) {
    if (body == null) {
      throw new ValidationFailedException(
          Map.of(
              "invitationId", "Enter a valid invitation identifier.",
              "secret", "Enter the invitation secret."));
    }
  }

  private UUID actorId(Authentication authentication) {
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal)) {
      throw new IdentityExceptions.UnauthenticatedException();
    }
    return principal.getId();
  }

  private static <T> ResponseEntity<T> noCache(HttpStatus status, T body) {
    return ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }
}
