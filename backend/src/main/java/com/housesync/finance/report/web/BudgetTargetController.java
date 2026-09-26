package com.housesync.finance.report.web;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.application.BudgetTargetService;
import com.housesync.finance.report.application.SpendingInsightsService;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.YearMonth;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
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
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@RestController
public class BudgetTargetController {
  private final BudgetTargetService service;

  public BudgetTargetController(BudgetTargetService service) {
    this.service = service;
  }

  private static final JsonMapper STRICT_JSON =
      JsonMapper.builder()
          .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
          .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
          .build();
  private static final Pattern PAGE_NUMBER = Pattern.compile("0|[1-9][0-9]{0,5}");

  private static JsonNode parse(String raw) {
    try {
      return STRICT_JSON.readTree(raw);
    } catch (JacksonException | IllegalArgumentException failure) {
      throw invalid();
    }
  }

  private static ValidationFailedException invalid() {
    return new ValidationFailedException(Map.of());
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

  private static SupportedCurrency currency(String raw) {
    try {
      return SupportedCurrency.valueOf(raw);
    } catch (IllegalArgumentException | NullPointerException failure) {
      throw invalid();
    }
  }

  private static int number(String raw, int fallback, int min, int max) {
    if (raw == null) return fallback;
    if (!PAGE_NUMBER.matcher(raw).matches()) throw invalid();
    int value = Integer.parseInt(raw);
    if (value < min || value > max) throw invalid();
    return value;
  }

  private static UUID retry(String raw) {
    try {
      if (raw == null) throw invalid();
      UUID value = UUID.fromString(raw);
      if (!value.toString().equals(raw.toLowerCase(Locale.ROOT))) throw invalid();
      return value;
    } catch (IllegalArgumentException failure) {
      throw invalid();
    }
  }

  private static void object(JsonNode body, Set<String> fields) {
    if (body == null || !body.isObject() || body.size() != fields.size()) throw invalid();
    for (String field : body.propertyNames()) if (!fields.contains(field)) throw invalid();
  }

  private static String text(JsonNode body, String field) {
    JsonNode value = body.get(field);
    if (value == null || !value.isTextual()) throw invalid();
    return value.asText();
  }

  private static int version(JsonNode body) {
    JsonNode value = body.get("expectedVersion");
    if (value == null || !value.isInt() || value.intValue() < 0) throw invalid();
    return value.intValue();
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

  @PostMapping(
      path = "/api/households/{householdId}/budget-targets",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<BudgetResponses.BudgetTarget> create(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestHeader(name = "Idempotency-Key", required = false) String retry,
      @RequestBody String rawBody,
      Authentication auth) {
    keys(query, Set.of());
    JsonNode body = parse(rawBody);
    object(body, Set.of("month", "bucket", "money"));
    YearMonth month = SpendingInsightsService.parseMonth(text(body, "month"), false);
    String bucket = BudgetTargetService.bucket(text(body, "bucket"));
    JsonNode money = body.get("money");
    object(money, Set.of("amount", "currency"));
    SupportedCurrency currency = currency(text(money, "currency"));
    String amount = BudgetTargetService.amount(text(money, "amount"), currency);
    UUID key = retry(retry);
    var result = service.create(householdId, actor(auth), month, bucket, currency, amount, key);
    return result.replayed() ? ok(result.target()) : created(result.target());
  }

  @GetMapping("/api/households/{householdId}/budget-targets")
  public ResponseEntity<BudgetResponses.Page> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication auth) {
    keys(query, Set.of("month", "currency", "status", "limit", "offset"));
    YearMonth month = SpendingInsightsService.parseMonth(required(query, "month"), false);
    SupportedCurrency currency = currency(required(query, "currency"));
    String status = query.getFirst("status");
    if (status == null) status = "ACTIVE";
    if (!Set.of("ACTIVE", "ARCHIVED", "ALL").contains(status)) throw invalid();
    int limit = number(query.getFirst("limit"), 50, 1, 100);
    int offset = number(query.getFirst("offset"), 0, 0, 10000);
    return ok(service.list(householdId, actor(auth), month, currency, status, limit, offset));
  }

  @GetMapping("/api/households/{householdId}/budget-targets/{id}")
  public ResponseEntity<BudgetResponses.BudgetTarget> detail(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      Authentication auth) {
    keys(query, Set.of());
    return ok(service.detail(householdId, actor(auth), id));
  }

  @PatchMapping(
      path = "/api/households/{householdId}/budget-targets/{id}",
      consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<BudgetResponses.BudgetTarget> patch(
      @PathVariable UUID householdId,
      @PathVariable UUID id,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody String rawBody,
      Authentication auth) {
    keys(query, Set.of());
    JsonNode body = parse(rawBody);
    if (body == null || !body.isObject()) throw invalid();
    boolean archive = body.has("status");
    object(
        body, archive ? Set.of("expectedVersion", "status") : Set.of("expectedVersion", "amount"));
    int expectedVersion = version(body);
    String amount = null;
    if (archive) {
      if (!"ARCHIVED".equals(text(body, "status"))) throw invalid();
    } else {
      amount = text(body, "amount");
      if (!BudgetTargetService.amountSyntax(amount)) throw invalid();
    }
    return ok(service.patch(householdId, actor(auth), id, expectedVersion, amount, archive));
  }

  @GetMapping("/api/households/{householdId}/insights/budget-progress")
  public ResponseEntity<BudgetResponses.Progress> progress(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication auth) {
    keys(query, Set.of("month", "currency"));
    YearMonth month = SpendingInsightsService.parseMonth(required(query, "month"), false);
    SupportedCurrency currency = currency(required(query, "currency"));
    return ok(service.progress(householdId, actor(auth), month, currency));
  }
}
