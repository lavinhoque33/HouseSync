package com.housesync.finance.transaction.web;

import com.housesync.finance.categorization.application.CategorizationQueryService;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Owner-only categorization provenance resource: exactly one GET under the existing
 * transaction path. No body, no query parameters; only delivered method/path combinations enter the
 * security allowlist. Responses carry the six safe provenance fields and never rule, provider,
 * evidence, or review internals.
 */
@RestController
@RequestMapping("/api/households/{householdId}/transactions")
public class CategorizationController {

  private final CategorizationQueryService categorization;

  public CategorizationController(CategorizationQueryService categorization) {
    this.categorization = categorization;
  }

  @GetMapping("/{transactionId}/categorization")
  public ResponseEntity<CategorizationResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    if (!query.isEmpty()) {
      // Query parameters are never part of this contract; the 400 is top level only.
      throw new ValidationFailedException(Map.of());
    }
    return noCache(
        HttpStatus.OK, categorization.get(householdId, transactionId, actorId(authentication)));
  }

  private static UUID actorId(Authentication authentication) {
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal)) {
      throw new UnauthenticatedException();
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
