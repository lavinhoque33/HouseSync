package com.housesync.finance.transaction.web;

import com.housesync.finance.transaction.application.FinancialAllocationService;
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

/**
 * Derived member balances (ADR 0007): every current member may read the exact per-currency
 * obligations of the household. The read holds the household lifecycle lock and derives everything
 * from one consistent authorized snapshot; balances refresh after every relevant mutation and are
 * never persisted.
 */
@RestController
@RequestMapping("/api/households/{householdId}")
public class MemberBalanceController {

  private final FinancialAllocationService allocations;

  public MemberBalanceController(FinancialAllocationService allocations) {
    this.allocations = allocations;
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
        .body(allocations.memberBalances(householdId, actorId(authentication)));
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
