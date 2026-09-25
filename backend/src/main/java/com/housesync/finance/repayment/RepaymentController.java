package com.housesync.finance.repayment;

import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.LocalDate;
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
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/households/{householdId}/repayments")
public class RepaymentController {
  public record MoneyInput(String amount, String currency) {}

  public record CreateInput(String recipientUserId, MoneyInput money, String occurredOn) {}

  public record DecisionInput(Integer expectedVersion, String decision) {}

  public record AmendmentInput(
      Integer expectedVersion, String action, MoneyInput money, String occurredOn) {}

  private final RepaymentService service;

  public RepaymentController(RepaymentService service) {
    this.service = service;
  }

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<RepaymentResponse> create(
      @PathVariable UUID householdId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) CreateInput body,
      Authentication authentication) {
    empty(query);
    if (body == null) throw invalid();
    UUID key = RepaymentService.parseUuid(rawKey, "idempotencyKey");
    var result =
        service.create(
            householdId,
            actor(authentication),
            key,
            body.recipientUserId(),
            body.money() == null ? null : body.money().amount(),
            body.money() == null ? null : body.money().currency(),
            body.occurredOn());
    return response(result.replayed() ? HttpStatus.OK : HttpStatus.CREATED, result.repayment());
  }

  @GetMapping
  public ResponseEntity<RepaymentService.Page<RepaymentResponse>> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    allowed(query, Set.of("limit", "offset", "currency", "status", "from", "to"));
    String currency = one(query, "currency");
    if (currency != null) RepaymentService.validate("1", currency, "2000-01-01");
    String status = one(query, "status");
    if (status != null
        && !Set.of("ALL", "PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "VOIDED")
            .contains(status)) throw invalid();
    String from = one(query, "from"), to = one(query, "to");
    if ((from == null) != (to == null)) throw invalid();
    LocalDate lower = parseDate(from), upper = parseDate(to);
    if (lower != null && !lower.isBefore(upper)) throw invalid();
    return response(
        HttpStatus.OK,
        service.list(
            householdId,
            actor(authentication),
            number(query, "limit", 50, 1, 100),
            number(query, "offset", 0, 0, 10000),
            currency,
            "ALL".equals(status) ? null : status,
            lower,
            upper));
  }

  @GetMapping("/{id}")
  public ResponseEntity<RepaymentResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    empty(query);
    return response(HttpStatus.OK, service.get(householdId, id, actor(authentication)));
  }

  @GetMapping("/{id}/events")
  public ResponseEntity<RepaymentService.Page<RepaymentResponse.Event>> events(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    allowed(query, Set.of("limit", "offset"));
    return response(
        HttpStatus.OK,
        service.events(
            householdId,
            id,
            actor(authentication),
            number(query, "limit", 50, 1, 100),
            number(query, "offset", 0, 0, 10000)));
  }

  @PostMapping(path = "/{id}/decision", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<RepaymentResponse> decide(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) DecisionInput body,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      Authentication authentication) {
    empty(query);
    noTransitionKey(rawKey);
    if (body == null
        || body.expectedVersion() == null
        || body.expectedVersion() < 0
        || body.decision() == null
        || !Set.of("CONFIRM", "REJECT", "CANCEL").contains(body.decision())) throw invalid();
    return response(
        HttpStatus.OK,
        service.decide(
            householdId,
            id,
            actor(authentication),
            body.expectedVersion(),
            "initial",
            body.decision(),
            null,
            null,
            null));
  }

  @PostMapping(path = "/{id}/amendment", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<RepaymentResponse> amend(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) AmendmentInput body,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      Authentication authentication) {
    empty(query);
    noTransitionKey(rawKey);
    if (body == null
        || body.expectedVersion() == null
        || body.expectedVersion() < 0
        || body.action() == null
        || !Set.of("VOID", "REPLACE").contains(body.action())) throw invalid();
    if (body.action().equals("VOID") && (body.money() != null || body.occurredOn() != null))
      throw invalid();
    if (body.action().equals("REPLACE") && (body.money() == null || body.occurredOn() == null))
      throw invalid();
    return response(
        HttpStatus.OK,
        service.decide(
            householdId,
            id,
            actor(authentication),
            body.expectedVersion(),
            "propose",
            body.action(),
            body.money() == null ? null : body.money().amount(),
            body.money() == null ? null : body.money().currency(),
            body.occurredOn()));
  }

  @PostMapping(path = "/{id}/amendment/decision", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<RepaymentResponse> decideAmendment(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) DecisionInput body,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      Authentication authentication) {
    empty(query);
    noTransitionKey(rawKey);
    if (body == null
        || body.expectedVersion() == null
        || body.expectedVersion() < 0
        || body.decision() == null
        || !Set.of("CONFIRM", "REJECT", "CANCEL").contains(body.decision())) throw invalid();
    return response(
        HttpStatus.OK,
        service.decide(
            householdId,
            id,
            actor(authentication),
            body.expectedVersion(),
            "amendment",
            body.decision(),
            null,
            null,
            null));
  }

  private static UUID actor(Authentication auth) {
    if (auth == null
        || !auth.isAuthenticated()
        || !(auth.getPrincipal() instanceof HouseSyncUserDetails user))
      throw new UnauthenticatedException();
    return user.getId();
  }

  private static String one(MultiValueMap<String, String> query, String key) {
    var values = query.get(key);
    if (values == null) return null;
    if (values.size() != 1 || values.getFirst() == null || values.getFirst().isBlank())
      throw invalid();
    return values.getFirst();
  }

  private static int number(
      MultiValueMap<String, String> query, String key, int defaultValue, int min, int max) {
    String raw = one(query, key);
    if (raw == null) return defaultValue;
    if (!raw.matches("0|[1-9][0-9]*") || raw.length() > 5) throw invalid();
    int result = Integer.parseInt(raw);
    if (result < min || result > max) throw invalid();
    return result;
  }

  private static LocalDate parseDate(String raw) {
    if (raw == null) return null;
    try {
      LocalDate date = LocalDate.parse(raw);
      if (date.toString().equals(raw)
          && !date.isBefore(LocalDate.of(1900, 1, 1))
          && !date.isAfter(LocalDate.of(9999, 12, 30))) return date;
    } catch (RuntimeException ignored) {
    }
    throw invalid();
  }

  private static void allowed(MultiValueMap<String, String> query, Set<String> keys) {
    if (!keys.containsAll(query.keySet())) throw invalid();
  }

  private static void empty(MultiValueMap<String, String> query) {
    if (!query.isEmpty()) throw invalid();
  }

  private static void noTransitionKey(String rawKey) {
    if (rawKey != null) throw invalid();
  }

  private static ValidationFailedException invalid() {
    return new ValidationFailedException(Map.of());
  }

  private static <T> ResponseEntity<T> response(HttpStatus status, T body) {
    return ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }
}
