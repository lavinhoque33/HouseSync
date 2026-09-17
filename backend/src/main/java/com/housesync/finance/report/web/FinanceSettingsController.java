package com.housesync.finance.report.web;

import com.housesync.finance.report.application.FinanceReportService;
import com.housesync.finance.report.application.FinanceReportService.PatchFields;
import com.housesync.finance.report.web.FinanceSettingsRequests.UpdateFinanceSettingsRequest;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Map;
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
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Household finance-settings endpoints (manual-finance API): every current member reads the
 * reporting zone and its version, while only a current household owner changes the zone with the
 * version as the concurrency token. Bodies are strict, query parameters are always rejected, and
 * every response is no-store JSON.
 */
@RestController
@RequestMapping("/api/households/{householdId}/finance-settings")
public class FinanceSettingsController {

  private final FinanceReportService reporting;

  public FinanceSettingsController(FinanceReportService reporting) {
    this.reporting = reporting;
  }

  @GetMapping
  public ResponseEntity<FinanceSettingsResponse> get(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    rejectQuery(query);
    return noCache(HttpStatus.OK, reporting.getSettings(householdId, actorId(authentication)));
  }

  @PatchMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<FinanceSettingsResponse> patch(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      @RequestBody(required = false) UpdateFinanceSettingsRequest body,
      Authentication authentication) {
    rejectQuery(query);
    if (body == null) {
      throw new ValidationFailedException(
          Map.of(
              "reportingTimeZone", "Choose a supported reporting time zone.",
              "expectedVersion", "Provide the current settings version."));
    }
    return noCache(
        HttpStatus.OK,
        reporting.patchSettings(
            householdId,
            actorId(authentication),
            new PatchFields(
                body.reportingTimeZone(),
                body.reportingTimeZonePresent(),
                body.expectedVersion(),
                body.expectedVersionPresent())));
  }

  private static void rejectQuery(MultiValueMap<String, String> query) {
    if (!query.isEmpty()) {
      // These routes accept no query parameters at all; the 400 is top level only.
      throw new ValidationFailedException(Map.of());
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

  private static <T> ResponseEntity<T> noCache(HttpStatus status, T body) {
    return ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }
}
