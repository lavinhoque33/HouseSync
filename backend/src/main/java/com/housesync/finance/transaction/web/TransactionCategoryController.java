package com.housesync.finance.transaction.web;

import com.housesync.finance.transaction.application.FinancialTransactionService;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Fixed transaction-category taxonomy: a bounded read-only list for current household
 * members, outside the transactions prefix so the security allowlist names it explicitly. No query
 * parameters are documented, so any parameter is rejected.
 */
@RestController
public class TransactionCategoryController {

  private final FinancialTransactionService transactions;

  public TransactionCategoryController(FinancialTransactionService transactions) {
    this.transactions = transactions;
  }

  @GetMapping("/api/households/{householdId}/transaction-categories")
  public ResponseEntity<TransactionCategoryListResponse> list(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication authentication) {
    if (!query.isEmpty()) {
      throw new ValidationFailedException(Map.of());
    }
    return ResponseEntity.status(HttpStatus.OK)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(transactions.listCategories(householdId, actorId(authentication)));
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
