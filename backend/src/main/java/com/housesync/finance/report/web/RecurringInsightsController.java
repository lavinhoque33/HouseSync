package com.housesync.finance.report.web;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.application.RecurrencePolicy;
import com.housesync.finance.report.application.RecurringInsightsService;
import com.housesync.finance.report.application.RecurringInsightsService.Input;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
public class RecurringInsightsController {
  private final RecurringInsightsService service;

  public RecurringInsightsController(RecurringInsightsService service) {
    this.service = service;
  }

  private static ValidationFailedException invalid() {
    return RecurrencePolicy.invalid();
  }

  private static UUID actor(Authentication auth) {
    if (auth == null
        || !auth.isAuthenticated()
        || !(auth.getPrincipal() instanceof HouseSyncUserDetails principal))
      throw new UnauthenticatedException();
    return principal.getId();
  }

  private static void keys(MultiValueMap<String, String> query, Set<String> allowed) {
    for (var entry : query.entrySet())
      if (!allowed.contains(entry.getKey()) || entry.getValue().size() != 1) throw invalid();
  }

  private static String required(MultiValueMap<String, String> query, String key) {
    String value = query.getFirst(key);
    if (value == null || value.isEmpty()) throw invalid();
    return value;
  }

  private static SupportedCurrency currency(String value) {
    try {
      return SupportedCurrency.valueOf(value);
    } catch (IllegalArgumentException failure) {
      throw invalid();
    }
  }

  private static int number(String raw, int fallback, int min, int max) {
    if (raw == null) return fallback;
    if (!raw.matches("0|[1-9][0-9]{0,5}")) throw invalid();
    int n = Integer.parseInt(raw);
    if (n < min || n > max) throw invalid();
    return n;
  }

  private static String key(String value) {
    if (value == null || !value.matches("[0-9a-f]{64}")) throw invalid();
    return value;
  }

  private static void cursor(String value) {
    RecurrencePolicy.validateCursor(value);
  }

  private static <T> ResponseEntity<T> ok(T body) {
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }

  private static <T> ResponseEntity<T> created(T body) {
    return ResponseEntity.status(HttpStatus.CREATED)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }

  private static void object(JsonNode body, Set<String> allowed, Set<String> required) {
    if (body == null || !body.isObject()) throw invalid();
    for (String field : required) if (!body.has(field)) throw invalid();
    body.propertyNames()
        .forEach(
            field -> {
              if (!allowed.contains(field)) throw invalid();
            });
  }

  private static String string(JsonNode body, String field, boolean nullable) {
    JsonNode value = body.get(field);
    if (value == null || value.isNull()) {
      if (value != null && !nullable) throw invalid();
      return null;
    }
    if (!value.isTextual()) throw invalid();
    return value.asText();
  }

  private static boolean truth(JsonNode body, String field) {
    JsonNode value = body.get(field);
    if (value == null || !value.isBoolean()) throw invalid();
    return value.booleanValue();
  }

  private static int version(JsonNode body, String field) {
    JsonNode value = body.get(field);
    if (value == null || !value.isInt() || value.intValue() < 0) throw invalid();
    return value.intValue();
  }

  private static UUID retry(String raw) {
    try {
      if (raw == null) throw invalid();
      UUID id = UUID.fromString(raw);
      if (!id.toString().equals(raw.toLowerCase(Locale.ROOT))) throw invalid();
      return id;
    } catch (IllegalArgumentException failure) {
      throw invalid();
    }
  }

  @GetMapping("/api/households/{householdId}/insights/recurring-candidates")
  public ResponseEntity<RecurringResponses.CandidatePage> candidates(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("currency", "review", "limit", "cursor"));
    SupportedCurrency currency = currency(required(query, "currency"));
    String review = query.getFirst("review");
    review = review == null ? "OPEN" : review;
    if (!Set.of("OPEN", "DISMISSED", "ALL").contains(review)) throw invalid();
    int limit = number(query.getFirst("limit"), 50, 1, 100);
    String cursor = query.getFirst("cursor");
    cursor(cursor);
    return ok(
        service.candidates(householdId, actor(authentication), currency, review, limit, cursor));
  }

  @GetMapping("/api/households/{householdId}/insights/recurring-evidence")
  public ResponseEntity<RecurringResponses.EvidencePage> evidence(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("currency", "merchantKey", "limit", "cursor"));
    SupportedCurrency currency = currency(required(query, "currency"));
    String merchant = key(required(query, "merchantKey"));
    int limit = number(query.getFirst("limit"), 50, 1, 100);
    String cursor = query.getFirst("cursor");
    cursor(cursor);
    return ok(
        service.candidateEvidence(
            householdId, actor(authentication), currency, merchant, limit, cursor));
  }

  @PutMapping(
      path = "/api/households/{householdId}/insights/recurring-review",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<RecurringResponses.Review> review(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody JsonNode body,
      Authentication authentication) {
    keys(query, Set.of());
    object(
        body,
        Set.of("currency", "merchantKey", "candidateFingerprint", "expectedVersion", "status"),
        Set.of("currency", "merchantKey", "candidateFingerprint", "expectedVersion", "status"));
    SupportedCurrency currency = currency(string(body, "currency", false));
    String merchant = key(string(body, "merchantKey", false));
    String fingerprint = string(body, "candidateFingerprint", false);
    if (fingerprint == null || !fingerprint.matches("[0-9a-f]{64}")) throw invalid();
    int version = version(body, "expectedVersion");
    String status = string(body, "status", false);
    if (!Set.of("OPEN", "DISMISSED").contains(status)) throw invalid();
    return ok(
        service.review(
            householdId, actor(authentication), currency, merchant, fingerprint, version, status));
  }

  @PostMapping(
      path = "/api/households/{householdId}/recurring-plans",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<RecurringResponses.Plan> create(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestHeader(name = "Idempotency-Key", required = false) String retry,
      @RequestBody JsonNode body,
      Authentication authentication) {
    keys(query, Set.of());
    Set<String> required =
        Set.of(
            "label",
            "kind",
            "currency",
            "matchDescription",
            "cadence",
            "anchorOn",
            "calendarAnchor",
            "expectedAmount",
            "acknowledgeHouseholdDisclosure");
    object(
        body,
        Set.of(
            "label",
            "kind",
            "currency",
            "matchDescription",
            "cadence",
            "anchorOn",
            "calendarAnchor",
            "expectedAmount",
            "acknowledgeHouseholdDisclosure",
            "candidate"),
        required);
    String candidateKey = null, fingerprint = null;
    if (body.has("candidate")) {
      JsonNode candidate = body.get("candidate");
      object(
          candidate,
          Set.of("merchantKey", "candidateFingerprint"),
          Set.of("merchantKey", "candidateFingerprint"));
      candidateKey = key(string(candidate, "merchantKey", false));
      fingerprint = string(candidate, "candidateFingerprint", false);
    }
    Input input =
        new Input(
            string(body, "label", false),
            string(body, "kind", false),
            currency(string(body, "currency", false)),
            string(body, "matchDescription", false),
            string(body, "cadence", false),
            string(body, "anchorOn", false),
            string(body, "calendarAnchor", true),
            string(body, "expectedAmount", true),
            truth(body, "acknowledgeHouseholdDisclosure"),
            candidateKey,
            fingerprint);
    UUID idempotency = retry(retry);
    var result = service.create(householdId, actor(authentication), input, idempotency);
    return result.replayed() ? ok(result.plan()) : created(result.plan());
  }

  @GetMapping("/api/households/{householdId}/recurring-plans")
  public ResponseEntity<RecurringResponses.PlanPage> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("currency", "status", "limit", "offset"));
    SupportedCurrency currency = currency(required(query, "currency"));
    String status = query.getFirst("status");
    status = status == null ? "ACTIVE" : status;
    if (!Set.of("ACTIVE", "ARCHIVED", "ALL").contains(status)) throw invalid();
    int limit = number(query.getFirst("limit"), 50, 1, 100),
        offset = number(query.getFirst("offset"), 0, 0, 10000);
    return ok(service.list(householdId, actor(authentication), currency, status, limit, offset));
  }

  @GetMapping("/api/households/{householdId}/recurring-plans/{id}")
  public ResponseEntity<RecurringResponses.Plan> detail(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of());
    return ok(service.detail(householdId, actor(authentication), id));
  }

  @PatchMapping(
      path = "/api/households/{householdId}/recurring-plans/{id}",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<RecurringResponses.Plan> patch(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody JsonNode body,
      Authentication authentication) {
    keys(query, Set.of());
    Set<String> mutable =
        Set.of(
            "label",
            "kind",
            "matchDescription",
            "cadence",
            "anchorOn",
            "calendarAnchor",
            "expectedAmount",
            "status");
    object(
        body,
        Set.of(
            "expectedVersion",
            "acknowledgeHouseholdDisclosure",
            "label",
            "kind",
            "matchDescription",
            "cadence",
            "anchorOn",
            "calendarAnchor",
            "expectedAmount",
            "status"),
        Set.of("expectedVersion"));
    int version = version(body, "expectedVersion");
    Map<String, String> edits = new java.util.HashMap<>();
    for (String field : mutable)
      if (body.has(field))
        edits.put(
            field,
            string(body, field, field.equals("expectedAmount") || field.equals("calendarAnchor")));
    if (edits.isEmpty()
        || (body.has("acknowledgeHouseholdDisclosure")
            && !truth(body, "acknowledgeHouseholdDisclosure"))) throw invalid();
    if (edits.containsKey("status")
        && (edits.size() != 1 || body.has("acknowledgeHouseholdDisclosure"))) throw invalid();
    if (!edits.containsKey("status") && !body.has("acknowledgeHouseholdDisclosure"))
      throw invalid();
    return ok(
        service.patch(
            householdId,
            actor(authentication),
            id,
            version,
            edits,
            body.has("acknowledgeHouseholdDisclosure")
                && truth(body, "acknowledgeHouseholdDisclosure")));
  }

  @GetMapping("/api/households/{householdId}/insights/recurring-plans")
  public ResponseEntity<RecurringResponses.ActivePlanPage> active(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("currency", "limit", "cursor"));
    SupportedCurrency currency = currency(required(query, "currency"));
    int limit = number(query.getFirst("limit"), 50, 1, 100);
    String cursor = query.getFirst("cursor");
    cursor(cursor);
    return ok(service.activePlans(householdId, actor(authentication), currency, limit, cursor));
  }

  @GetMapping("/api/households/{householdId}/recurring-plans/{id}/observations")
  public ResponseEntity<RecurringResponses.ObservationPage> observations(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("limit", "cursor"));
    int limit = number(query.getFirst("limit"), 50, 1, 100);
    String cursor = query.getFirst("cursor");
    cursor(cursor);
    return ok(service.observations(householdId, actor(authentication), id, limit, cursor));
  }
}
