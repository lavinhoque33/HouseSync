package com.housesync.finance.categorization.web;

import com.housesync.finance.categorization.application.CategorizationAiWorkService;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.web.IdentityExceptions.UnauthenticatedException;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CategorizationAiWorkController {
  private final CategorizationAiWorkService work;

  public CategorizationAiWorkController(CategorizationAiWorkService work) {
    this.work = work;
  }

  @GetMapping("/api/households/{householdId}/categorization-ai-work/status")
  public ResponseEntity<CategorizationAiWorkService.Status> status(
      @PathVariable UUID householdId,
      @RequestParam MultiValueMap<String, String> query,
      Authentication auth) {
    if (!query.isEmpty()) throw new ValidationFailedException(Map.of());
    if (auth == null
        || !auth.isAuthenticated()
        || !(auth.getPrincipal() instanceof HouseSyncUserDetails actor))
      throw new UnauthenticatedException();
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(work.status(householdId, actor.getId()));
  }
}
