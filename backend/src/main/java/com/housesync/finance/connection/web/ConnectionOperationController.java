package com.housesync.finance.connection.web;

import com.housesync.finance.connection.application.ConnectionQueryService;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Owner-only durable-operation status polling. */
@RestController
@RequestMapping("/api/households/{householdId}/connection-operations")
public class ConnectionOperationController {

  private final ConnectionQueryService queries;

  public ConnectionOperationController(ConnectionQueryService queries) {
    this.queries = queries;
  }

  @GetMapping("/{operationId}")
  public ResponseEntity<ConnectionResponses.ConnectionOperationResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID operationId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        ConnectionLinkController.toOperation(
            householdId,
            queries.operation(
                householdId, operationId, ConnectionLinkController.actorId(authentication))));
  }
}
