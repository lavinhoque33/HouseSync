package com.housesync.finance.categorization.web;

import com.housesync.finance.categorization.application.CategorizationReviewService;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CategorizationReviewController {
  private final CategorizationReviewService reviews;

  public CategorizationReviewController(CategorizationReviewService reviews) {
    this.reviews = reviews;
  }

  @GetMapping("/api/households/{householdId}/categorization-reviews")
  public ResponseEntity<CategorizationReviewListResponse> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication auth) {
    checkQuery(query, Set.of("limit", "offset", "view"));
    int limit = bounded(query, "limit", 50, 1, 100);
    int offset = bounded(query, "offset", 0, 0, 10_000);
    String view = query.getFirst("view") == null ? "OPEN" : query.getFirst("view");
    if (!Set.of("OPEN", "HISTORY").contains(view))
      throw new ValidationFailedException(Map.of("view", "Choose open or history."));
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(reviews.list(householdId, actor(auth), view, limit, offset));
  }

  @GetMapping("/api/households/{householdId}/categorization-reviews/{reviewId}")
  public ResponseEntity<CategorizationReviewResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID reviewId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication auth) {
    checkQuery(query, Set.of());
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(reviews.get(householdId, actor(auth), reviewId));
  }

  @PostMapping(
      path = "/api/households/{householdId}/categorization-reviews/{reviewId}/resolve",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<CategorizationReviewResponse> resolve(
      @PathVariable UUID householdId,
      @PathVariable UUID reviewId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) CategorizationReviewResolveRequest body,
      Authentication auth) {
    checkQuery(query, Set.of());
    UUID key;
    try {
      key = UUID.fromString(rawKey);
      if (!key.toString().equals(rawKey.toLowerCase(Locale.ROOT)))
        throw new IllegalArgumentException();
    } catch (IllegalArgumentException | NullPointerException invalid) {
      throw new ValidationFailedException(Map.of("idempotencyKey", "Provide a valid request key."));
    }
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(reviews.resolve(householdId, actor(auth), reviewId, key, body));
  }

  private static void checkQuery(MultiValueMap<String, String> query, Set<String> allowed) {
    if (query.entrySet().stream()
        .anyMatch(entry -> !allowed.contains(entry.getKey()) || entry.getValue().size() != 1))
      throw new ValidationFailedException(Map.of());
  }

  private static int bounded(
      MultiValueMap<String, String> query, String field, int defaultValue, int min, int max) {
    String raw = query.getFirst(field);
    if (raw == null) return defaultValue;
    try {
      if (!raw.matches("0|[1-9][0-9]*")) throw new NumberFormatException();
      int parsed = Integer.parseInt(raw);
      if (parsed < min || parsed > max) throw new NumberFormatException();
      return parsed;
    } catch (NumberFormatException invalid) {
      throw new ValidationFailedException(Map.of(field, "Enter a valid whole number."));
    }
  }

  private static UUID actor(Authentication authentication) {
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal))
      throw new UnauthenticatedException();
    return principal.getId();
  }
}
