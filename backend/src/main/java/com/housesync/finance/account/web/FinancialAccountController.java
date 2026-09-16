package com.housesync.finance.account.web;

import com.housesync.finance.account.application.FinancialAccountService;
import com.housesync.finance.account.application.FinancialAccountService.CreateResult;
import com.housesync.finance.account.web.FinancialAccountRequests.CreateFinancialAccountRequest;
import com.housesync.finance.account.web.FinancialAccountRequests.UpdateFinancialAccountRequest;
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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/households/{householdId}/financial-accounts")
public class FinancialAccountController {

  private static final Set<String> LIST_PARAMETERS = Set.of("limit", "offset", "status");

  private final FinancialAccountService accounts;

  public FinancialAccountController(FinancialAccountService accounts) {
    this.accounts = accounts;
  }

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinancialAccountResponse> create(
      @PathVariable UUID householdId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) CreateFinancialAccountRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    UUID key = parseIdempotencyKey(rawKey);
    if (body == null) {
      throw new ValidationFailedException(
          Map.of(
              "name", "Enter an account name.",
              "kind", "Choose cash, checking, savings, or credit card.",
              "currency", "Choose a supported currency."));
    }
    CreateResult created =
        accounts.create(
            householdId, actorId(authentication), key, body.name(), body.kind(), body.currency());
    return noCache(created.replayed() ? HttpStatus.OK : HttpStatus.CREATED, created.account());
  }

  @GetMapping
  public ResponseEntity<FinancialAccountListResponse> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query, LIST_PARAMETERS);
    int limit = parseInt(query, "limit", 50, 1, 100);
    int offset = parseInt(query, "offset", 0, 0, 10_000);
    String status = single(query, "status", "ACTIVE");
    if (!Set.of("ACTIVE", "ARCHIVED", "ALL").contains(status)) {
      throw new ValidationFailedException(Map.of("status", "Choose active, archived, or all."));
    }
    return noCache(
        HttpStatus.OK, accounts.list(householdId, actorId(authentication), status, limit, offset));
  }

  @GetMapping("/{accountId}")
  public ResponseEntity<FinancialAccountResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID accountId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    return noCache(HttpStatus.OK, accounts.get(householdId, accountId, actorId(authentication)));
  }

  @PatchMapping(path = "/{accountId}", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinancialAccountResponse> update(
      @PathVariable UUID householdId,
      @PathVariable UUID accountId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) UpdateFinancialAccountRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    if (body == null) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current account version."));
    }
    return noCache(
        HttpStatus.OK,
        accounts.update(
            householdId,
            accountId,
            actorId(authentication),
            body.expectedVersion(),
            body.expectedVersionPresent(),
            body.name(),
            body.namePresent(),
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
