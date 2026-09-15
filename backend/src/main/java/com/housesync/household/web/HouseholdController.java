package com.housesync.household.web;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.web.HouseholdRequests.CreateHouseholdRequest;
import com.housesync.household.web.HouseholdRequests.UpdateMemberRoleRequest;
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
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Household create/access and membership lifecycle endpoints. Every request resolves the actor from
 * the authenticated principal; nothing client-supplied acts as authorization evidence. All
 * responses and errors are non-cacheable JSON using the shared identity error shape.
 */
@RestController
@RequestMapping("/api/households")
public class HouseholdController {

  private final HouseholdService households;

  public HouseholdController(HouseholdService households) {
    this.households = households;
  }

  /**
   * Creates a household plus the creator {@code OWNER} membership. Accepts only {@code name};
   * unknown fields are rejected before this handler runs.
   */
  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<HouseholdResponse> create(
      @RequestBody(required = false) CreateHouseholdRequest body, Authentication authentication) {
    if (body == null) {
      throw new ValidationFailedException(Map.of("name", "Enter a household name."));
    }
    UUID actorId = actorId(authentication);
    return noCache(HttpStatus.CREATED, households.create(body.name(), actorId));
  }

  /** Lists the actor's households ordered by creation instant then ID. */
  @GetMapping
  public ResponseEntity<HouseholdListResponse> list(Authentication authentication) {
    return noCache(
        HttpStatus.OK, new HouseholdListResponse(households.list(actorId(authentication))));
  }

  /** Returns the household when the actor is a current member, else the generic 404. */
  @GetMapping("/{householdId}")
  public ResponseEntity<HouseholdResponse> get(
      @PathVariable UUID householdId, Authentication authentication) {
    return noCache(HttpStatus.OK, households.get(householdId, actorId(authentication)));
  }

  /** Returns the minimal roster when the actor remains a current member. */
  @GetMapping("/{householdId}/members")
  public ResponseEntity<HouseholdMemberListResponse> listMembers(
      @PathVariable UUID householdId, Authentication authentication) {
    return noCache(
        HttpStatus.OK,
        new HouseholdMemberListResponse(
            households.listMembers(householdId, actorId(authentication))));
  }

  /** Changes another member's role when the actor is a current owner. */
  @PatchMapping(
      path = "/{householdId}/members/{userId}",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<HouseholdMemberResponse> updateMemberRole(
      @PathVariable UUID householdId,
      @PathVariable UUID userId,
      @RequestBody(required = false) UpdateMemberRoleRequest body,
      Authentication authentication) {
    if (body == null) {
      throw new ValidationFailedException(Map.of("role", "Choose owner or member."));
    }
    return noCache(
        HttpStatus.OK,
        households.updateMemberRole(householdId, userId, body.role(), actorId(authentication)));
  }

  /** Removes another member when the actor is a current owner. */
  @DeleteMapping("/{householdId}/members/{userId}")
  public ResponseEntity<Void> removeMember(
      @PathVariable UUID householdId, @PathVariable UUID userId, Authentication authentication) {
    households.removeMember(householdId, userId, actorId(authentication));
    return noContent();
  }

  /** Removes the actor's own membership unless they are the final owner. */
  @PostMapping("/{householdId}/leave")
  public ResponseEntity<Void> leave(@PathVariable UUID householdId, Authentication authentication) {
    households.leave(householdId, actorId(authentication));
    return noContent();
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

  private static ResponseEntity<Void> noContent() {
    return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
  }
}
