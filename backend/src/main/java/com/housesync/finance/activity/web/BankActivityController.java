package com.housesync.finance.activity.web;

import com.housesync.finance.activity.application.BankActivityService;
import com.housesync.finance.activity.application.BankActivityService.Filters;
import com.housesync.finance.activity.web.BankActivityRequests.ConfirmBankActivityRequest;
import com.housesync.finance.activity.web.BankActivityRequests.DismissBankActivityRequest;
import com.housesync.finance.activity.web.BankActivityResponses.BankActivityDecisionResponse;
import com.housesync.finance.activity.web.BankActivityResponses.BankActivityListResponse;
import com.housesync.finance.activity.web.BankActivityResponses.BankActivityResponse;
import com.housesync.finance.activity.web.BankActivityResponses.MoneyResponse;
import com.housesync.finance.connection.web.ConnectionLinkController;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
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
 * Owner-private bank-activity inbox. Reads and decisions are owner-scoped; foreign,
 * former-member, other-owner, and missing resources share one indistinguishable 404. Confirm and
 * dismiss require a valid Idempotency-Key and current observation version; a replay reauthorizes
 * and returns the persisted outcome.
 */
@RestController
@RequestMapping("/api/households/{householdId}/bank-activity")
public class BankActivityController {

  private static final Set<String> LIST_PARAMETERS =
      Set.of("limit", "offset", "connectionId", "accountId", "state", "review");

  private final BankActivityService activity;

  public BankActivityController(BankActivityService activity) {
    this.activity = activity;
  }

  @GetMapping
  public ResponseEntity<BankActivityListResponse> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query, LIST_PARAMETERS);
    int limit = parseLimit(query);
    int offset = parseOffset(query);
    Filters filters =
        new Filters(
            parseOptionalUuid(query.getFirst("connectionId"), "connectionId"),
            parseOptionalUuid(query.getFirst("accountId"), "accountId"),
            query.getFirst("state"),
            query.getFirst("review"));
    BankActivityService.Page page =
        activity.list(
            householdId, ConnectionLinkController.actorId(authentication), filters, limit, offset);
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        new BankActivityListResponse(
            page.items().stream().map(BankActivityController::toResponse).toList(),
            limit,
            offset,
            page.hasMore(),
            page.unreviewedCount(),
            page.changedCount()));
  }

  @GetMapping("/{activityId}")
  public ResponseEntity<BankActivityResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID activityId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        toResponse(
            activity.get(
                householdId, activityId, ConnectionLinkController.actorId(authentication))));
  }

  @PostMapping(path = "/{activityId}/confirm", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<BankActivityDecisionResponse> confirm(
      @PathVariable UUID householdId,
      @PathVariable UUID activityId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) ConfirmBankActivityRequest body,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    UUID key = ConnectionLinkController.parseIdempotencyKey(rawKey);
    BankActivityService.ConfirmRequest request = parseConfirm(body);
    BankActivityService.Decision decision =
        activity.confirm(
            householdId,
            activityId,
            ConnectionLinkController.actorId(authentication),
            key,
            request);
    // The persisted decision replays identically; a fresh admission returns 201.
    return ConnectionLinkController.noCache(
        decision.replayed() ? HttpStatus.OK : HttpStatus.CREATED,
        new BankActivityDecisionResponse(
            toResponse(decision.activity()),
            decision.transactionId(),
            decision.transactionVersion()));
  }

  @PostMapping(path = "/{activityId}/dismiss", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<BankActivityDecisionResponse> dismiss(
      @PathVariable UUID householdId,
      @PathVariable UUID activityId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) DismissBankActivityRequest body,
      Authentication authentication) {
    ConnectionLinkController.rejectQuery(query);
    UUID key = ConnectionLinkController.parseIdempotencyKey(rawKey);
    if (body == null
        || !body.expectedVersionPresent()
        || body.expectedVersion() == null
        || body.expectedVersion() < 0) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current bank activity version."));
    }
    if (!body.reasonPresent() || body.reason() == null) {
      throw new ValidationFailedException(Map.of("reason", "Choose a dismissal reason."));
    }
    BankActivityService.Decision decision =
        activity.dismiss(
            householdId,
            activityId,
            ConnectionLinkController.actorId(authentication),
            key,
            body.expectedVersion(),
            body.reason());
    return ConnectionLinkController.noCache(
        HttpStatus.OK,
        new BankActivityDecisionResponse(
            toResponse(decision.activity()),
            decision.transactionId(),
            decision.transactionVersion()));
  }

  private static BankActivityService.ConfirmRequest parseConfirm(ConfirmBankActivityRequest body) {
    if (body == null) {
      throw new ValidationFailedException(Map.of());
    }
    Map<String, String> errors = new LinkedHashMap<>();
    if (!body.expectedVersionPresent()
        || body.expectedVersion() == null
        || body.expectedVersion() < 0) {
      errors.put("expectedVersion", "Provide the current bank activity version.");
    }
    TransactionKind kind = null;
    if (body.kind() != null) {
      try {
        kind = TransactionKind.valueOf(body.kind());
      } catch (IllegalArgumentException rejected) {
        errors.put("kind", "Choose expense, income, refund, or transfer.");
      }
    } else {
      errors.put("kind", "Choose expense, income, refund, or transfer.");
    }
    String description = body.description();
    if (body.descriptionPresent() && description == null) {
      errors.put("description", "Enter a description.");
    }
    UUID refundId = null;
    if (body.refundOfTransactionIdPresent()) {
      if (body.refundOfTransactionId() == null) {
        errors.put("refundOfTransactionId", "Choose the expense being refunded.");
      } else {
        try {
          refundId = UUID.fromString(body.refundOfTransactionId());
        } catch (IllegalArgumentException rejected) {
          errors.put("refundOfTransactionId", "Choose the expense being refunded.");
        }
      }
    } else if (kind == TransactionKind.REFUND) {
      errors.put("refundOfTransactionId", "Choose the expense being refunded.");
    }
    if (!errors.isEmpty()) {
      throw new ValidationFailedException(errors);
    }
    boolean acknowledge = Boolean.TRUE.equals(body.acknowledgeDisclosure());
    return new BankActivityService.ConfirmRequest(
        body.expectedVersion(),
        kind,
        description,
        body.category(),
        body.categoryPresent(),
        refundId,
        acknowledge);
  }

  static BankActivityResponse toResponse(BankActivityService.View view) {
    MoneyResponse money =
        view.amount() == null || view.currency() == null
            ? null
            : new MoneyResponse(view.amount(), view.currency());
    return new BankActivityResponse(
        view.id(),
        view.connectionId(),
        view.accountMappingId(),
        view.localAccountId(),
        view.state(),
        view.reviewState(),
        view.changeState(),
        money,
        view.occurredOn() == null ? null : view.occurredOn().toString(),
        view.authorizedOn() == null ? null : view.authorizedOn().toString(),
        view.providerDescription(),
        view.descriptionValid(),
        view.pendingPredecessorObservationId(),
        view.invalidReason(),
        view.dismissedReason(),
        view.version(),
        view.ledgerTransactionId(),
        view.createdAt(),
        view.updatedAt());
  }

  /**
   * Bounded paging parse identical in behavior to the manual-finance controllers: syntactically
   * invalid, out-of-range, and over-long numeric strings are all a safe 400, never a raw 500.
   */
  private static int parseLimit(MultiValueMap<String, String> query) {
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

  private static UUID parseOptionalUuid(String value, String field) {
    if (value == null) {
      return null;
    }
    try {
      return UUID.fromString(value);
    } catch (IllegalArgumentException rejected) {
      throw new ValidationFailedException(Map.of(field, "Choose a valid local resource."));
    }
  }
}
