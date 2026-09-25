package com.housesync.finance.transaction.web;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.settlement.SettlementPlan;
import com.housesync.finance.settlement.SettlementService;
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
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Household-locked, member-visible net balances and read-only settlement suggestions. */
@RestController
@RequestMapping("/api/households/{householdId}")
public class MemberBalanceController {

  private final SettlementService settlements;

  public MemberBalanceController(SettlementService settlements) {
    this.settlements = settlements;
  }

  @GetMapping("/member-balances")
  public ResponseEntity<MemberBalancesResponse> memberBalances(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    if (!query.isEmpty()) {
      // This bounded read accepts no query parameters; the 400 is top level only.
      throw new ValidationFailedException(Map.of());
    }
    return ResponseEntity.status(HttpStatus.OK)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(settlements.memberBalances(householdId, actorId(authentication)));
  }

  @GetMapping("/settlement-suggestions")
  public ResponseEntity<SettlementPlan.Response> suggestions(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    for (var entry : query.entrySet()) {
      if ((!entry.getKey().equals("currency")
              && !entry.getKey().equals("limit")
              && !entry.getKey().equals("cursor"))
          || entry.getValue().size() != 1) {
        throw new ValidationFailedException(Map.of());
      }
    }
    SupportedCurrency currency;
    try {
      currency = SupportedCurrency.valueOf(query.getFirst("currency"));
    } catch (IllegalArgumentException | NullPointerException invalid) {
      throw new ValidationFailedException(Map.of("currency", "Choose a supported currency."));
    }
    int limit = 50;
    if (query.containsKey("limit")) {
      String raw = query.getFirst("limit");
      if (raw == null || !raw.matches("[1-9][0-9]{0,2}")) {
        throw new ValidationFailedException(Map.of("limit", "Choose a limit from 1 to 100."));
      }
      limit = Integer.parseInt(raw);
      if (limit > 100) {
        throw new ValidationFailedException(Map.of("limit", "Choose a limit from 1 to 100."));
      }
    }
    return ResponseEntity.status(HttpStatus.OK)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(
            settlements.suggestions(
                householdId, actorId(authentication), currency, limit, query.getFirst("cursor")));
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
