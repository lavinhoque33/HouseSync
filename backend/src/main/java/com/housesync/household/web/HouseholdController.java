package com.housesync.household.web;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.web.HouseholdRequests.CreateHouseholdRequest;
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
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Household create/access endpoints. Every request resolves the actor from the authenticated
 * principal; nothing client-supplied acts as authorization evidence. All responses and errors are
 * non-cacheable JSON using the shared identity error shape.
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
