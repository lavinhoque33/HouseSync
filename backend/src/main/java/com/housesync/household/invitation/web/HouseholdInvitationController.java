package com.housesync.household.invitation.web;

import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.web.InvitationResponses.InvitationCreatedResponse;
import com.housesync.household.invitation.web.InvitationResponses.InvitationListResponse;
import com.housesync.household.invitation.web.InvitationResponses.InvitationSummary;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions;
import java.util.List;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Owner invitation endpoints. Every request resolves the actor from the authenticated principal and
 * the household from the path; nothing client-supplied acts as authorization evidence. Creation
 * takes no body. All responses and errors are non-cacheable JSON, including a successful 204
 * revocation.
 */
@RestController
@RequestMapping("/api/households/{householdId}/invitations")
public class HouseholdInvitationController {

  private final InvitationService invitations;

  public HouseholdInvitationController(InvitationService invitations) {
    this.invitations = invitations;
  }

  /**
   * Creates one independent invitation for the current owner. Duplicate creates are independent
   * invitations; if the response is lost, refresh the active list, revoke the unshareable row if
   * present, and create another explicitly.
   */
  @PostMapping
  public ResponseEntity<InvitationCreatedResponse> create(
      @PathVariable UUID householdId, Authentication authentication) {
    return noCache(HttpStatus.CREATED, invitations.create(householdId, actorId(authentication)));
  }

  /** Lists the active invitations of the current owner, ordered by creation instant then ID. */
  @GetMapping
  public ResponseEntity<InvitationListResponse> list(
      @PathVariable UUID householdId, Authentication authentication) {
    List<InvitationSummary> active = invitations.listActive(householdId, actorId(authentication));
    return noCache(HttpStatus.OK, new InvitationListResponse(active));
  }

  /**
   * Revokes an active invitation, or succeeds idempotently when the same invitation was already
   * revoked. Accepted, expired, missing, and wrong-household IDs are the generic invitation 404
   * after path household authorization.
   */
  @DeleteMapping("/{invitationId}")
  public ResponseEntity<Void> revoke(
      @PathVariable UUID householdId,
      @PathVariable UUID invitationId,
      Authentication authentication) {
    invitations.revoke(householdId, invitationId, actorId(authentication));
    return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
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
