package com.housesync.finance.transaction.web;

import com.housesync.finance.transaction.application.FinancialTransactionService;
import com.housesync.finance.transaction.application.FinancialTransactionService.CreateFields;
import com.housesync.finance.transaction.application.FinancialTransactionService.CreateResult;
import com.housesync.finance.transaction.application.FinancialTransactionService.PatchFields;
import com.housesync.finance.transaction.web.FinancialTransactionRequests.CreateFinancialTransactionRequest;
import com.housesync.finance.transaction.web.FinancialTransactionRequests.MoneyPatch;
import com.housesync.finance.transaction.web.FinancialTransactionRequests.MoneyRequest;
import com.housesync.finance.transaction.web.FinancialTransactionRequests.UpdateFinancialTransactionRequest;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.LocalDate;
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

/**
 * Transaction endpoints: own entries at any visibility plus the household feed. Query
 * parameters are filtered in SQL after membership and visibility authorization, never in memory;
 * non-owner account references are redacted to null in the authorized projection.
 */
@RestController
@RequestMapping("/api/households/{householdId}/transactions")
public class FinancialTransactionController {

  private static final Set<String> LIST_PARAMETERS =
      Set.of("limit", "offset", "view", "accountId", "currency", "from", "to", "status");
  private static final Set<String> VIEWS = Set.of("OWN", "HOUSEHOLD");
  private static final Set<String> CURRENCIES =
      Set.of("BRL", "USD", "EUR", "GBP", "JPY", "KWD", "CAD");
  private static final LocalDate MIN_FILTER_DATE = LocalDate.of(1900, 1, 1);
  private static final LocalDate MAX_FILTER_DATE = LocalDate.of(9999, 12, 31);

  private final FinancialTransactionService transactions;

  public FinancialTransactionController(FinancialTransactionService transactions) {
    this.transactions = transactions;
  }

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinancialTransactionResponse> create(
      @PathVariable UUID householdId,
      @RequestHeader(name = "Idempotency-Key", required = false) String rawKey,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) CreateFinancialTransactionRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    UUID key = parseIdempotencyKey(rawKey);
    if (body == null) {
      throw new ValidationFailedException(
          Map.of(
              "accountId",
              "Choose an account.",
              "kind",
              "Choose expense, income, refund, or transfer.",
              "money.amount",
              "Enter an amount.",
              "money.currency",
              "Choose a supported currency.",
              "occurredOn",
              "Enter the transaction date.",
              "description",
              "Enter a description."));
    }
    MoneyRequest money = body.money();
    CreateResult created =
        transactions.create(
            householdId,
            actorId(authentication),
            key,
            new CreateFields(
                body.accountId(),
                body.kind(),
                money == null ? null : money.amount(),
                money == null ? null : money.currency(),
                body.occurredOn(),
                body.description(),
                body.visibility(),
                body.visibilityPresent(),
                body.category(),
                body.categoryPresent(),
                body.refundOfTransactionId(),
                body.refundOfTransactionIdPresent()));
    return noCache(created.replayed() ? HttpStatus.OK : HttpStatus.CREATED, created.transaction());
  }

  @GetMapping
  public ResponseEntity<FinancialTransactionListResponse> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query, LIST_PARAMETERS);
    int limit = parseInt(query, "limit", 50, 1, 100);
    int offset = parseInt(query, "offset", 0, 0, 10_000);
    String view = single(query, "view", "OWN");
    if (!VIEWS.contains(view)) {
      throw new ValidationFailedException(Map.of("view", "Choose your own or household entries."));
    }
    String status = single(query, "status", "POSTED");
    if (!Set.of("POSTED", "VOIDED", "ALL").contains(status)) {
      throw new ValidationFailedException(Map.of("status", "Choose posted, voided, or all."));
    }
    UUID accountId = parseUuidQuery(query, "accountId");
    if (accountId != null && !"OWN".equals(view)) {
      // A private account filter is meaningful only inside the actor's own view.
      throw new ValidationFailedException(
          Map.of("accountId", "Account filtering is available for your own entries."));
    }
    String currency = single(query, "currency", null);
    if (currency != null && !CURRENCIES.contains(currency)) {
      throw new ValidationFailedException(Map.of("currency", "Choose a supported currency."));
    }
    LocalDate[] range = parseDateRange(query);
    return noCache(
        HttpStatus.OK,
        transactions.list(
            householdId,
            actorId(authentication),
            view,
            status,
            accountId,
            currency,
            range[0],
            range[1],
            limit,
            offset));
  }

  @GetMapping("/{transactionId}")
  public ResponseEntity<FinancialTransactionResponse> get(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    return noCache(
        HttpStatus.OK, transactions.get(householdId, transactionId, actorId(authentication)));
  }

  @PatchMapping(path = "/{transactionId}", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinancialTransactionResponse> patch(
      @PathVariable UUID householdId,
      @PathVariable UUID transactionId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) UpdateFinancialTransactionRequest body,
      Authentication authentication) {
    rejectQuery(query, Set.of());
    if (body == null) {
      throw new ValidationFailedException(
          Map.of("expectedVersion", "Provide the current transaction version."));
    }
    MoneyPatch money = body.money();
    boolean moneyAmountPresent = money != null && money.amountPresent();
    boolean moneyCurrencyPresent = money != null && money.currencyPresent();
    return noCache(
        HttpStatus.OK,
        transactions.patch(
            householdId,
            transactionId,
            actorId(authentication),
            new PatchFields(
                body.expectedVersion(),
                body.expectedVersionPresent(),
                moneyAmountPresent ? money.amount() : null,
                moneyCurrencyPresent ? money.currency() : null,
                body.moneyPresent(),
                body.occurredOn(),
                body.occurredOnPresent(),
                body.description(),
                body.descriptionPresent(),
                body.visibility(),
                body.visibilityPresent(),
                body.category(),
                body.categoryPresent(),
                body.status(),
                body.statusPresent())));
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

  private static UUID parseUuidQuery(MultiValueMap<String, String> query, String name) {
    String value = query.getFirst(name);
    if (value == null) return null;
    try {
      return UUID.fromString(value);
    } catch (IllegalArgumentException rejected) {
      throw new ValidationFailedException(Map.of(name, "Choose an account."));
    }
  }

  /**
   * Inclusive {@code from}, exclusive {@code to}; both or neither, with from strictly before to.
   */
  private static LocalDate[] parseDateRange(MultiValueMap<String, String> query) {
    String rawFrom = query.getFirst("from");
    String rawTo = query.getFirst("to");
    if (rawFrom == null && rawTo == null) {
      return new LocalDate[] {null, null};
    }
    if (rawFrom == null || rawTo == null) {
      throw new ValidationFailedException(Map.of());
    }
    LocalDate from = parseFilterDate(rawFrom, "from");
    LocalDate to = parseFilterDate(rawTo, "to");
    if (!from.isBefore(to)) {
      throw new ValidationFailedException(Map.of());
    }
    return new LocalDate[] {from, to};
  }

  private static LocalDate parseFilterDate(String value, String name) {
    try {
      LocalDate parsed = LocalDate.parse(value);
      if (parsed.isBefore(MIN_FILTER_DATE) || parsed.isAfter(MAX_FILTER_DATE)) {
        throw new IllegalArgumentException();
      }
      return parsed;
    } catch (RuntimeException rejected) {
      throw new ValidationFailedException(Map.of(name, "Enter a supported date."));
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
