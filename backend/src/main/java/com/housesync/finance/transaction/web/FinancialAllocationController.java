package com.housesync.finance.transaction.web;

import com.housesync.finance.transaction.application.FinancialAllocationService;
import com.housesync.finance.transaction.application.FinancialAllocationService.CreateFields;
import com.housesync.finance.transaction.application.FinancialAllocationService.CreateResult;
import com.housesync.finance.transaction.application.FinancialAllocationService.RevokeFields;
import com.housesync.finance.transaction.web.FinancialAllocationRequests.CreateAllocationRequest;
import com.housesync.finance.transaction.web.FinancialAllocationRequests.RevokeAllocationRequest;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Locale;
import java.util.Map;
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

/**
 * Singular allocation routes on one expense (ADR 0007): the owner creates with a durable
 * Idempotency-Key, every current member of an authorized expense reads the active allocation, and
 * the owner revokes with the expense version as the only concurrency token. Responses are no-store,
 * request bodies are strict, and query parameters are always rejected.
 */
@RestController
@RequestMapping("/api/households/{householdId}/transactions/{transactionId}/allocation")
public class FinancialAllocationController {

  private final FinancialAllocationService allocations;

  public FinancialAllocationController(FinancialAllocationService allocations) {
    this.allocations = allocations;
  }

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinancialAllocationResponse> create(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) CreateAllocationRequest body,
      Authentication authentication) {
    rejectQuery(query);
    UUID key = parseIdempotencyKey(rawKey);
    if (body == null) {
      throw new ValidationFailedException(
          Map.of(
              "expectedVersion", "Provide the current transaction version.",
              "participantUserIds", "Provide exactly one participant list.",
              "participantShares", "Provide exactly one participant list."));
    }
    CreateResult result =
        allocations.create(
            householdId,
            transactionId,
            actorId(authentication),
            key,
            new CreateFields(
                body.expectedVersion(),
                body.expectedVersionPresent(),
                body.participantUserIds(),
                body.participantUserIdsPresent(),
                body.participantShares(),
                body.participantSharesPresent()));
    return noCache(result.replayed() ? HttpStatus.OK : HttpStatus.CREATED, result.allocation());
  }

  @PostMapping(path = "/preview", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinancialAllocationPreviewResponse> preview(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestBody(required = false) CreateAllocationRequest body,
      Authentication authentication) {
    rejectQuery(query);
    if (rawKey != null) {
      throw new ValidationFailedException(
          Map.of("idempotencyKey", "Preview does not accept a request key."));
    }
    if (body == null) {
      throw new ValidationFailedException(
          Map.of(
              "expectedVersion", "Provide the current transaction version.",
              "participantShares", "Provide exactly one participant list.",
              "participantUserIds", "Provide exactly one participant list."));
    }
    return noCache(
        HttpStatus.OK,
        allocations.preview(
            householdId,
            transactionId,
            actorId(authentication),
            new CreateFields(
                body.expectedVersion(),
                body.expectedVersionPresent(),
                body.participantUserIds(),
                body.participantUserIdsPresent(),
                body.participantShares(),
                body.participantSharesPresent())));
  }

  @GetMapping
  public ResponseEntity<FinancialAllocationResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query);
    return noCache(
        HttpStatus.OK, allocations.get(householdId, transactionId, actorId(authentication)));
  }

  @PatchMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinancialAllocationResponse> revoke(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) RevokeAllocationRequest body,
      Authentication authentication) {
    rejectQuery(query);
    if (body == null) {
      throw new ValidationFailedException(
          Map.of(
              "expectedVersion",
              "Provide the current transaction version.",
              "status",
              "Only revoked status is accepted."));
    }
    return noCache(
        HttpStatus.OK,
        allocations.revoke(
            householdId,
            transactionId,
            actorId(authentication),
            new RevokeFields(
                body.expectedVersion(),
                body.expectedVersionPresent(),
                body.status(),
                body.statusPresent())));
  }

  private static void rejectQuery(MultiValueMap<String, String> query) {
    if (!query.isEmpty()) {
      // These singular routes accept no query parameters at all; the 400 is top level only.
      throw new ValidationFailedException(Map.of());
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
