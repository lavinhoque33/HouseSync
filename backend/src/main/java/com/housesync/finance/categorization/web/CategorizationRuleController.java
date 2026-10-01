package com.housesync.finance.categorization.web;

import com.housesync.finance.categorization.application.CategorizationRuleService;
import com.housesync.finance.categorization.application.CategorizationRuleService.RuleMutation;
import com.housesync.finance.categorization.web.CategorizationRuleRequests.CreateCategorizationRuleRequest;
import com.housesync.finance.categorization.web.CategorizationRuleRequests.PatchCategorizationRuleRequest;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Owner-private categorization rule endpoints (categorization contract §4): exactly the three
 * delivered method/path combinations — the owner's private bounded list, the explicit learn action
 * on one owned transaction, and the category/deactivation patch. Only delivered method/path
 * combinations enter the security allowlist. Every response carries {@code Cache-Control:
 * no-store}, and match keys, provider digests, and evidence never appear in any response.
 */
@RestController
public class CategorizationRuleController {

  private static final Set<String> STATUS_VALUES = Set.of("ACTIVE", "INACTIVE");

  private final CategorizationRuleService rules;

  public CategorizationRuleController(CategorizationRuleService rules) {
    this.rules = rules;
  }

  @GetMapping("/api/households/{householdId}/categorization-rules")
  public ResponseEntity<CategorizationRuleListResponse> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query, Set.of("limit", "offset", "status"));
    int limit = parseInt(query, "limit", 50, 1, 100);
    int offset = parseInt(query, "offset", 0, 0, 10_000);
    String status = single(query, "status", null);
    if (status != null && !STATUS_VALUES.contains(status)) {
      throw new ValidationFailedException(Map.of("status", "Choose active or inactive."));
    }
    return noCache(
        HttpStatus.OK, rules.list(householdId, actorId(authentication), status, limit, offset));
  }

  @PostMapping(
      path = "/api/households/{householdId}/transactions/{transactionId}/categorization-rule",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<CategorizationRuleResponse> create(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) CreateCategorizationRuleRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    if (body == null) {
      throw new ValidationFailedException(
          Map.of("expectedTransactionVersion", "Provide the current transaction version."));
    }
    UUID key = parseIdempotencyKey(rawKey);
    RuleMutation mutation =
        rules.createRule(
            householdId,
            transactionId,
            actorId(authentication),
            body.expectedTransactionVersion(),
            key);
    return noCache(mutation.replayed() ? HttpStatus.OK : HttpStatus.CREATED, mutation.rule());
  }

  @PatchMapping(
      path = "/api/households/{householdId}/categorization-rules/{ruleId}",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<CategorizationRuleResponse> patch(
      @PathVariable UUID householdId,
      @PathVariable UUID ruleId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) PatchCategorizationRuleRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    if (body == null) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current rule version."));
    }
    return noCache(
        HttpStatus.OK,
        rules.patchRule(
            householdId,
            ruleId,
            actorId(authentication),
            body.expectedVersion(),
            body.expectedVersionPresent(),
            body.category(),
            body.categoryPresent(),
            body.status(),
            body.statusPresent()));
  }

  private static void rejectQuery(
      MultiValueMap<String, String> query, Set<String> allowedParameters) {
    for (Map.Entry<String, List<String>> entry : query.entrySet()) {
      if (!allowedParameters.contains(entry.getKey()) || entry.getValue().size() != 1) {
        // Query parameters are not body fields and are never echoed; the 400 is top level only.
        throw new ValidationFailedException(Map.of());
      }
    }
  }

  private static String single(
      MultiValueMap<String, String> query, String name, String defaultValue) {
    String value = query.getFirst(name);
    return value == null ? defaultValue : value;
  }

  private static int parseInt(
      MultiValueMap<String, String> query,
      String name,
      int defaultValue,
      int minimum,
      int maximum) {
    String value = query.getFirst(name);
    if (value == null) return defaultValue;
    if (!value.matches("0|[1-9][0-9]*")) {
      throw new ValidationFailedException(Map.of(name, "Enter a valid whole number."));
    }
    try {
      int parsed = Integer.parseInt(value);
      if (parsed < minimum || parsed > maximum) throw new NumberFormatException();
      return parsed;
    } catch (NumberFormatException rejected) {
      throw new ValidationFailedException(Map.of(name, "Enter a valid whole number."));
    }
  }

  private static UUID parseIdempotencyKey(String rawKey) {
    if (rawKey != null) {
      try {
        UUID parsed = UUID.fromString(rawKey);
        if (parsed.toString().equals(rawKey.toLowerCase(Locale.ROOT))) return parsed;
      } catch (IllegalArgumentException rejected) {
        // Safe validation error below.
      }
    }
    throw new ValidationFailedException(Map.of("idempotencyKey", "Provide a valid request key."));
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
