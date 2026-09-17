package com.housesync.finance.connection.web;

import com.housesync.finance.connection.application.ConnectionLinkService;
import com.housesync.finance.connection.application.ConnectionQueryService;
import com.housesync.finance.connection.persistence.ConnectionOperationEntity;
import com.housesync.finance.connection.web.ConnectionRequests.CompleteLinkRequest;
import com.housesync.finance.connection.web.ConnectionRequests.StartLinkRequest;
import com.housesync.finance.connection.web.ConnectionResponses.ConnectionOperationResponse;
import com.housesync.finance.connection.web.ConnectionResponses.LinkAttemptResponse;
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
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Link-attempt and durable-completion endpoints. Link tokens are ephemeral response
 * values; only the encrypted replay copy rests server-side until expiry. Completion never assumes
 * browser metadata proves success: the durable operation carries the outcome.
 */
@RestController
@RequestMapping("/api/households/{householdId}/connection-link-attempts")
public class ConnectionLinkController {

  private final ConnectionLinkService links;
  private final ConnectionQueryService queries;

  public ConnectionLinkController(ConnectionLinkService links, ConnectionQueryService queries) {
    this.links = links;
    this.queries = queries;
  }

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<LinkAttemptResponse> start(
      @PathVariable UUID householdId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) StartLinkRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    UUID key = parseIdempotencyKey(rawKey);
    ConnectionLinkService.StartResult started =
        links.start(householdId, actorId(authentication), key);
    return noCache(
        started.replayed() ? HttpStatus.OK : HttpStatus.CREATED,
        new LinkAttemptResponse(
            started.attemptId(),
            started.flow(),
            "PLAID",
            null,
            started.linkToken(),
            started.expiresAt()));
  }

  @PostMapping(path = "/{attemptId}/complete", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<ConnectionOperationResponse> complete(
      @PathVariable UUID householdId,
      @PathVariable UUID attemptId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) CompleteLinkRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    UUID key = parseIdempotencyKey(rawKey);
    UUID actor = actorId(authentication);
    UUID operationId =
        links.complete(
            householdId,
            attemptId,
            actor,
            key,
            body == null ? null : body.publicTokenPresent() ? body.publicToken() : null);
    ConnectionOperationEntity operation = queries.operation(householdId, operationId, actor);
    return noCache(HttpStatus.ACCEPTED, toOperation(householdId, operation));
  }

  static ConnectionOperationResponse toOperation(
      UUID householdId, ConnectionOperationEntity operation) {
    return new ConnectionOperationResponse(
        operation.getId(),
        operation.getOperationType(),
        operation.getState(),
        operation.getConnectionId(),
        operation.getErrorCode(),
        "/api/households/" + householdId + "/connection-operations/" + operation.getId(),
        operation.getCreatedAt(),
        operation.getUpdatedAt());
  }

  static void rejectQuery(MultiValueMap<String, String> query) {
    rejectQuery(query, Set.of());
  }

  static void rejectQuery(MultiValueMap<String, String> query, Set<String> allowedParameters) {
    for (Map.Entry<String, List<String>> entry : query.entrySet()) {
      if (!allowedParameters.contains(entry.getKey()) || entry.getValue().size() != 1) {
        throw new ValidationFailedException(Map.of());
      }
    }
  }

  static UUID parseIdempotencyKey(String rawKey) {
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

  static UUID actorId(Authentication authentication) {
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal)) {
      throw new UnauthenticatedException();
    }
    return principal.getId();
  }

  static <T> ResponseEntity<T> noCache(HttpStatus status, T body) {
    return ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }
}
