package com.housesync.finance.connection.web;

import com.housesync.finance.connection.application.ConnectionLifecycleService;
import com.housesync.finance.connection.application.ConnectionQueryService;
import com.housesync.finance.connection.application.ConnectionSelectionService;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.web.ConnectionRequests.AccountSelectionRequest;
import com.housesync.finance.connection.web.ConnectionRequests.ExpectedVersionRequest;
import com.housesync.finance.connection.web.ConnectionResponses.AccountSelectionResponse;
import com.housesync.finance.connection.web.ConnectionResponses.ConnectionAccountMappingListResponse;
import com.housesync.finance.connection.web.ConnectionResponses.ConnectionAccountMappingResponse;
import com.housesync.finance.connection.web.ConnectionResponses.ConnectionOperationResponse;
import com.housesync.finance.connection.web.ConnectionResponses.FinancialConnectionListResponse;
import com.housesync.finance.connection.web.ConnectionResponses.FinancialConnectionResponse;
import com.housesync.finance.connection.web.ConnectionResponses.LinkAttemptResponse;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Private owner-scoped connection endpoints. No transaction sync or webhook surface
 * exists on these routes.
 */
@RestController
@RequestMapping("/api/households/{householdId}/financial-connections")
public class FinancialConnectionController {

  private static final java.util.Set<String> LIST_PARAMETERS = java.util.Set.of("limit", "offset");

  private final ConnectionQueryService queries;
  private final ConnectionSelectionService selection;
  private final ConnectionLifecycleService lifecycle;
  private final com.housesync.finance.connection.application.ConnectionSyncService sync;

  public FinancialConnectionController(
      ConnectionQueryService queries,
      ConnectionSelectionService selection,
      ConnectionLifecycleService lifecycle,
      com.housesync.finance.connection.application.ConnectionSyncService sync) {
    this.queries = queries;
    this.selection = selection;
    this.lifecycle = lifecycle;
    this.sync = sync;
  }

  @GetMapping
  public ResponseEntity<FinancialConnectionListResponse> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    int limit = parseLimit(query);
    int offset = parseOffset(query);
    ConnectionQueryService.ConnectionPage page =
        queries.list(householdId, ConnectionLinkController.actorId(authentication), limit, offset);
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        new FinancialConnectionListResponse(
            page.items().stream().map(FinancialConnectionController::toResponse).toList(),
            limit,
            offset,
            page.hasMore()));
  }

  @GetMapping("/{connectionId}")
  public ResponseEntity<FinancialConnectionResponse> getConnection(
      @PathVariable UUID householdId,
      @PathVariable UUID connectionId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        toResponse(
            queries.get(
                householdId, connectionId, ConnectionLinkController.actorId(authentication))));
  }

  @GetMapping("/{connectionId}/accounts")
  public ResponseEntity<ConnectionAccountMappingListResponse> accounts(
      @PathVariable UUID householdId,
      @PathVariable UUID connectionId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    int limit = parseLimit(query);
    int offset = parseOffset(query);
    ConnectionQueryService.MappingPage page =
        queries.accounts(
            householdId,
            connectionId,
            ConnectionLinkController.actorId(authentication),
            limit,
            offset);
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        new ConnectionAccountMappingListResponse(
            page.items().stream().map(FinancialConnectionController::toMapping).toList(),
            limit,
            offset,
            page.hasMore()));
  }

  @PostMapping(
      path = "/{connectionId}/account-selection",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<AccountSelectionResponse> select(
      @PathVariable UUID householdId,
      @PathVariable UUID connectionId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) AccountSelectionRequest body,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    UUID key = ConnectionLinkController.parseIdempotencyKey(rawKey);
    if (body == null || !body.expectedVersionPresent() || !body.accountMappingIdsPresent()) {
      throw new ValidationFailedException(Map.of());
    }
    Integer version = body.expectedVersion();
    if (version == null || version < 0) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current connection version."));
    }
    if (body.accountMappingIds() == null) {
      throw new ValidationFailedException(Map.of("accountMappingIds", "Choose accounts to admit."));
    }
    ConnectionSelectionService.SelectionResult result =
        selection.select(
            householdId,
            connectionId,
            ConnectionLinkController.actorId(authentication),
            key,
            version,
            body.accountMappingIds());
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        new AccountSelectionResponse(
            result.connectionId(),
            result.version(),
            result.accounts().stream()
                .map(
                    account ->
                        new ConnectionResponses.AccountSelectionItem(
                            account.id(),
                            account.name(),
                            account.kind(),
                            account.currency(),
                            account.source(),
                            account.status(),
                            account.version()))
                .toList()));
  }

  @PostMapping(path = "/{connectionId}/reconnect", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<LinkAttemptResponse> reconnect(
      @PathVariable UUID householdId,
      @PathVariable UUID connectionId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) ExpectedVersionRequest body,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    UUID key = ConnectionLinkController.parseIdempotencyKey(rawKey);
    int version = requireVersion(body);
    UUID actor = ConnectionLinkController.actorId(authentication);
    ConnectionLifecycleService.ReconnectResult started =
        lifecycle.reconnect(householdId, connectionId, actor, key, version);
    // The encrypted replay copy is read back within the request; the plaintext token itself
    // is the ephemeral response value and is never logged or persisted raw.
    ConnectionLifecycleService.ReconnectView view =
        lifecycle.reconnectView(householdId, connectionId, started.attemptId(), actor);
    return ConnectionLinkController.noCache(
        started.replayed() ? HttpStatus.OK : HttpStatus.CREATED,
        new LinkAttemptResponse(
            started.attemptId(),
            "UPDATE",
            "PLAID",
            connectionId,
            view.linkToken(),
            view.expiresAt()));
  }

  /**
   * Manual sync: a coalesced 202 operation behind the per-connection 60-second interval. The UI
   * never promises immediate new bank data; the operation GET reports the durable outcome.
   */
  @PostMapping(path = "/{connectionId}/sync", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<ConnectionOperationResponse> sync(
      @PathVariable UUID householdId,
      @PathVariable UUID connectionId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) ExpectedVersionRequest body,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    UUID key = ConnectionLinkController.parseIdempotencyKey(rawKey);
    int version = requireVersion(body);
    UUID actor = ConnectionLinkController.actorId(authentication);
    com.housesync.finance.connection.application.ConnectionSyncService.ManualSyncResult result =
        sync.requestManual(householdId, connectionId, actor, key, version);
    return ConnectionLinkController.noCache(
        HttpStatus.ACCEPTED,
        ConnectionLinkController.toOperation(
            householdId, queries.operation(householdId, result.operationId(), actor)));
  }

  @PostMapping(path = "/{connectionId}/disconnect", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<ConnectionOperationResponse> disconnect(
      @PathVariable UUID householdId,
      @PathVariable UUID connectionId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) ExpectedVersionRequest body,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    UUID key = ConnectionLinkController.parseIdempotencyKey(rawKey);
    int version = requireVersion(body);
    UUID actor = ConnectionLinkController.actorId(authentication);
    UUID operationId = lifecycle.disconnect(householdId, connectionId, actor, key, version);
    return ConnectionLinkController.noCache(
        HttpStatus.ACCEPTED,
        ConnectionLinkController.toOperation(
            householdId, queries.operation(householdId, operationId, actor)));
  }

  static int requireVersion(ExpectedVersionRequest body) {
    if (body == null || !body.expectedVersionPresent()) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current connection version."));
    }
    Integer version = body.expectedVersion();
    if (version == null || version < 0) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current connection version."));
    }
    return version;
  }

  private static int parseLimit(MultiValueMap<String, String> query) {
    ConnectionLinkController.rejectQuery(query, LIST_PARAMETERS);
    String value = query.getFirst("limit");
    if (value == null) return 50;
    if (!value.matches("0|[1-9][0-9]*")) {
      throw new ValidationFailedException(Map.of("limit", "Enter a valid whole number."));
    }
    try {
      int parsed = Integer.parseInt(value);
      if (parsed < 1 || parsed > 100) throw new NumberFormatException();
      return parsed;
    } catch (NumberFormatException rejected) {
      throw new ValidationFailedException(Map.of("limit", "Enter a valid whole number."));
    }
  }

  private static int parseOffset(MultiValueMap<String, String> query) {
    String value = query.getFirst("offset");
    if (value == null) return 0;
    if (!value.matches("0|[1-9][0-9]*")) {
      throw new ValidationFailedException(Map.of("offset", "Enter a valid whole number."));
    }
    try {
      int parsed = Integer.parseInt(value);
      if (parsed < 0 || parsed > 10_000) throw new NumberFormatException();
      return parsed;
    } catch (NumberFormatException rejected) {
      throw new ValidationFailedException(Map.of("offset", "Enter a valid whole number."));
    }
  }

  static FinancialConnectionResponse toResponse(FinancialConnectionEntity connection) {
    return new FinancialConnectionResponse(
        connection.getId(),
        connection.getHouseholdId(),
        connection.getProvider(),
        connection.getEnvironment(),
        connection.getState(),
        connection.getGeneration(),
        connection.getVersion(),
        connection.getSyncState(),
        connection.isHistoryReady(),
        connection.getLastSuccessfulSyncAt(),
        connection.getCreatedAt(),
        connection.getUpdatedAt());
  }

  static ConnectionAccountMappingResponse toMapping(ConnectionAccountMappingEntity mapping) {
    return new ConnectionAccountMappingResponse(
        mapping.getId(),
        mapping.getLocalAccountId(),
        mapping.getDisplayName(),
        mapping.getKind(),
        mapping.getCurrency(),
        mapping.isSelected(),
        mapping.isEligible(),
        mapping.getExclusionReason());
  }
}
