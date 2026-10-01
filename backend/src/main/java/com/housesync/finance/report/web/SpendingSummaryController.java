package com.housesync.finance.report.web;

import com.housesync.finance.report.application.FinanceReportService;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.LocalDate;
import java.util.List;
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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Exact spending-summary read (manual-finance API): every current member may read the per-currency
 * magnitudes over an explicit half-open date interval. Both {@code from} (inclusive) and {@code to}
 * (exclusive) are required; report boundaries may extend through {@code 9999-12-31} so the final
 * supported transaction date stays queryable. Query parameters are filtered strictly and the
 * aggregation runs in SQL under the household lifecycle lock, never over an unrestricted in-memory
 * result.
 */
@RestController
@RequestMapping("/api/households/{householdId}/spending-summary")
public class SpendingSummaryController {

  private static final Set<String> SUMMARY_PARAMETERS = Set.of("from", "to");
  private static final LocalDate MIN_FILTER_DATE = LocalDate.of(1900, 1, 1);
  private static final LocalDate MAX_FILTER_DATE = LocalDate.of(9999, 12, 31);

  private final FinanceReportService reporting;

  public SpendingSummaryController(FinanceReportService reporting) {
    this.reporting = reporting;
  }

  @GetMapping
  public ResponseEntity<SpendingSummaryResponse> summary(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query);
    LocalDate[] range = parseDateRange(query);
    return ResponseEntity.status(HttpStatus.OK)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(reporting.spendingSummary(householdId, actorId(authentication), range[0], range[1]));
  }

  private static void rejectQuery(MultiValueMap<String, String> query) {
    for (Map.Entry<String, List<String>> entry : query.entrySet()) {
      if (!SUMMARY_PARAMETERS.contains(entry.getKey()) || entry.getValue().size() != 1) {
        // Query parameters are not body fields and are never echoed; the 400 is top level only.
        throw new ValidationFailedException(Map.of());
      }
    }
  }

  /**
   * Inclusive {@code from}, exclusive {@code to}; both are required, with from strictly before to.
   */
  private static LocalDate[] parseDateRange(MultiValueMap<String, String> query) {
    String rawFrom = query.getFirst("from");
    String rawTo = query.getFirst("to");
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

  private static UUID actorId(Authentication authentication) {
    if (authentication == null
        || !authentication.isAuthenticated()
        || !(authentication.getPrincipal() instanceof HouseSyncUserDetails principal)) {
      throw new UnauthenticatedException();
    }
    return principal.getId();
  }
}
