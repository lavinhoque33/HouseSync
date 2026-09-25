package com.housesync.finance.report.web;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.application.ContributionSummaryService;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
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

@RestController
@RequestMapping("/api/households/{householdId}/contribution-summary")
public class ContributionSummaryController {
  private static final Set<String> PARAMETERS =
      Set.of("from", "to", "currency", "limit", "offset", "snapshot");
  private static final Pattern DATE = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");
  private static final Pattern NUMBER = Pattern.compile("0|[1-9][0-9]*");
  private static final Pattern SNAPSHOT = Pattern.compile("[0-9a-f]{64}");
  private static final LocalDate MIN = LocalDate.of(1900, 1, 1);
  private static final LocalDate MAX = LocalDate.of(9999, 12, 31);
  private final ContributionSummaryService contributions;

  public ContributionSummaryController(ContributionSummaryService contributions) {
    this.contributions = contributions;
  }

  @GetMapping
  public ResponseEntity<ContributionSummaryResponse> summary(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    for (Map.Entry<String, List<String>> parameter : query.entrySet()) {
      if (!PARAMETERS.contains(parameter.getKey()) || parameter.getValue().size() != 1) invalid();
    }
    LocalDate from = date(query.getFirst("from"));
    LocalDate to = date(query.getFirst("to"));
    if (!from.isBefore(to)) invalid();
    SupportedCurrency currency;
    try {
      currency = SupportedCurrency.valueOf(query.getFirst("currency"));
    } catch (RuntimeException rejected) {
      throw new ValidationFailedException(Map.of("currency", "Choose a supported currency."));
    }
    int limit = number(query.getFirst("limit"), 50, 1, 100);
    int offset = number(query.getFirst("offset"), 0, 0, 10000);
    String snapshot = query.getFirst("snapshot");
    if ((snapshot != null && !SNAPSHOT.matcher(snapshot).matches())
        || (offset > 0 && snapshot == null)) invalid();
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal)) {
      throw new UnauthenticatedException();
    }
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(
            contributions.summary(
                householdId, principal.getId(), from, to, currency, limit, offset, snapshot));
  }

  private static LocalDate date(String value) {
    try {
      if (value == null || !DATE.matcher(value).matches()) invalid();
      LocalDate parsed = LocalDate.parse(value);
      if (parsed.isBefore(MIN) || parsed.isAfter(MAX)) invalid();
      return parsed;
    } catch (RuntimeException rejected) {
      throw new ValidationFailedException(Map.of());
    }
  }

  private static int number(String value, int fallback, int min, int max) {
    if (value == null) return fallback;
    if (!NUMBER.matcher(value).matches()) invalid();
    try {
      int result = Integer.parseInt(value);
      if (result < min || result > max) invalid();
      return result;
    } catch (NumberFormatException rejected) {
      throw new ValidationFailedException(Map.of());
    }
  }

  private static void invalid() {
    throw new ValidationFailedException(Map.of());
  }
}
