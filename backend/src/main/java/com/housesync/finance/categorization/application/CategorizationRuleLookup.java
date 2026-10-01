package com.housesync.finance.categorization.application;

import com.housesync.finance.categorization.domain.CategorizationMatchKeys.DerivedKey;
import com.housesync.finance.categorization.persistence.CategorizationRuleRepository;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Classification-time seam for exact owner-rule lookup. The new-entry classifier in the transaction
 * domain calls this use case inside its own authorized transaction; the lookup is scoped by
 * household and financial owner in SQL, so no other member's rule — and no broad fetch-then-filter
 * scan — is ever involved.
 */
@Service
public class CategorizationRuleLookup {

  /** One active owner rule prepared for classification: token, internal reference, ruleset. */
  public record OwnerRuleMatch(UUID ruleId, String category, String rulesetVersion) {}

  private final CategorizationRuleRepository repository;

  public CategorizationRuleLookup(CategorizationRuleRepository repository) {
    this.repository = repository;
  }

  /**
   * Finds the single exact ACTIVE owner rule for the derived match key, or nothing. The caller owns
   * the surrounding authorized transaction so the lookup shares its locks and commit.
   */
  @Transactional(propagation = Propagation.MANDATORY, readOnly = true)
  public Optional<OwnerRuleMatch> findActiveMatch(
      UUID householdId, UUID ownerUserId, DerivedKey derivedKey) {
    return repository
        .findActiveMatch(householdId, ownerUserId, derivedKey.matchType(), derivedKey.key())
        .map(
            rule ->
                new OwnerRuleMatch(
                    rule.getId(), rule.getCategory().name(), rule.getRulesetVersion()));
  }
}
