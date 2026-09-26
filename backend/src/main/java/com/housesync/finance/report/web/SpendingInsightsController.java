package com.housesync.finance.report.web;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.application.SpendingInsightsService;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.YearMonth;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Strict syntax validation precedes the membership-locked derived report use cases. */
@RestController
@RequestMapping("/api/households/{householdId}/insights")
public class SpendingInsightsController {
  private final SpendingInsightsService insights;

  public SpendingInsightsController(SpendingInsightsService insights) {
    this.insights = insights;
  }

  @GetMapping("/spending-series")
  public ResponseEntity<SpendingInsightsResponse.Series> series(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("fromMonth", "toMonth", "currency", "dimension", "groupKey"));
    YearMonth from = SpendingInsightsService.parseMonth(required(query, "fromMonth"), false);
    YearMonth to = SpendingInsightsService.parseMonth(required(query, "toMonth"), true);
    if (!from.isBefore(to) || java.time.temporal.ChronoUnit.MONTHS.between(from, to) > 24)
      throw invalid();
    SupportedCurrency currency = currency(query);
    String dimension = query.getFirst("dimension"), group = query.getFirst("groupKey");
    if ((dimension == null) != (group == null)) throw invalid();
    if (dimension != null) {
      dimension(dimension);
      SpendingInsightsService.validateKey(dimension, group);
    }
    return ok(
        insights.series(householdId, actor(authentication), from, to, currency, dimension, group));
  }

  @GetMapping("/spending-comparison")
  public ResponseEntity<SpendingInsightsResponse.Comparison> comparison(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("month", "baselineMonth", "currency", "dimension", "limit", "cursor"));
    YearMonth month = SpendingInsightsService.parseMonth(required(query, "month"), false);
    YearMonth baseline =
        SpendingInsightsService.parseMonth(required(query, "baselineMonth"), false);
    if (month.equals(baseline)) throw invalid();
    SupportedCurrency currency = currency(query);
    String dimension = dimension(required(query, "dimension"));
    int pageSize = limit(query);
    SpendingInsightsService.validateCursorSyntax(query.getFirst("cursor"));
    return ok(
        insights.comparison(
            householdId,
            actor(authentication),
            month,
            baseline,
            currency,
            dimension,
            pageSize,
            query.getFirst("cursor")));
  }

  @GetMapping("/spending-evidence")
  public ResponseEntity<SpendingInsightsResponse.Evidence> evidence(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    keys(query, Set.of("month", "currency", "dimension", "groupKey", "limit", "cursor"));
    YearMonth month = SpendingInsightsService.parseMonth(required(query, "month"), false);
    SupportedCurrency currency = currency(query);
    String dimension = dimension(required(query, "dimension"));
    String group = required(query, "groupKey");
    SpendingInsightsService.validateKey(dimension, group);
    int pageSize = limit(query);
    SpendingInsightsService.validateCursorSyntax(query.getFirst("cursor"));
    return ok(
        insights.evidence(
            householdId,
            actor(authentication),
            month,
            currency,
            dimension,
            group,
            pageSize,
            query.getFirst("cursor")));
  }

  private static <T> ResponseEntity<T> ok(T body) {
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }

  private static void keys(MultiValueMap<String, String> query, Set<String> allowed) {
    for (Map.Entry<String, List<String>> entry : query.entrySet())
      if (!allowed.contains(entry.getKey()) || entry.getValue().size() != 1) throw invalid();
  }

  private static String required(MultiValueMap<String, String> query, String key) {
    String value = query.getFirst(key);
    if (value == null || value.isEmpty()) throw invalid();
    return value;
  }

  private static SupportedCurrency currency(MultiValueMap<String, String> query) {
    try {
      return SupportedCurrency.valueOf(required(query, "currency"));
    } catch (IllegalArgumentException rejected) {
      throw invalid();
    }
  }

  private static String dimension(String value) {
    if (!value.equals("CATEGORY") && !value.equals("MERCHANT")) throw invalid();
    return value;
  }

  private static int limit(MultiValueMap<String, String> query) {
    String value = query.getFirst("limit");
    if (value == null) return 50;
    if (!value.matches("[1-9][0-9]{0,2}")) throw invalid();
    int parsed = Integer.parseInt(value);
    if (parsed > 100) throw invalid();
    return parsed;
  }

  private static UUID actor(Authentication authentication) {
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal))
      throw new UnauthenticatedException();
    return principal.getId();
  }

  private static ValidationFailedException invalid() {
    return new ValidationFailedException(Map.of());
  }
}
