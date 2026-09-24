package com.housesync.finance.categorization.application;

import com.housesync.finance.activity.application.BankActivityService;
import com.housesync.finance.categorization.domain.CategorizationOrigin;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.finance.transaction.web.CategorizationResponse;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionNotFoundException;
import com.housesync.household.application.HouseholdService;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owner-private categorization read use case. The route is financial-owner-only:
 * the authorization scope is the owner-scoped transaction lookup, so another current member — even
 * one sharing the household-disclosed entry — receives the generic privacy-preserving transaction
 * 404 exactly like a foreign or missing resource.
 *
 * <p>The seventh field, {@code ruleEligible}, reports whether the owner may explicitly
 * learn an exact rule from this entry right now. It is evaluated live for the current actor and
 * transaction — posted non-refund USER origin with a non-null category, a safe server-derived match
 * key, and no active rule for that key — and the derived key itself never leaves the server. The
 * review state reflects a current owner-scoped OPEN review without exposing its candidate here.
 */
@Service
public class CategorizationQueryService {

  private final FinancialTransactionRepository transactions;
  private final HouseholdService households;
  private final CategorizationRuleService rules;
  private final BankActivityService bankActivity;
  private final CategorizationReviewService reviews;

  public CategorizationQueryService(
      FinancialTransactionRepository transactions,
      HouseholdService households,
      CategorizationRuleService rules,
      BankActivityService bankActivity,
      CategorizationReviewService reviews) {
    this.transactions = transactions;
    this.households = households;
    this.rules = rules;
    this.bankActivity = bankActivity;
    this.reviews = reviews;
  }

  @Transactional(readOnly = true)
  public CategorizationResponse get(UUID householdId, UUID transactionId, UUID actorId) {
    // Owner-scoped lookup IS the authorization: a member who does not own the row — including
    // one the entry is shared with — falls into the same generic transaction 404 as a foreign or
    // missing resource, so existence is never disclosed through this resource.
    return transactions
        .findOwnedScoped(householdId, transactionId, actorId)
        .map(
            transaction ->
                toResponse(
                    transaction,
                    rules.ruleEligible(
                        householdId,
                        actorId,
                        transaction,
                        retainedMerchantIdentityDigest(householdId, transactionId, actorId)),
                    reviews.hasOpen(householdId, actorId, transactionId)))
        .orElseGet(
            () -> {
              // Separates the resource 404 from the household 404 for a non-member without
              // widening what a member learns about another owner's entries.
              households.requireFinanceMembership(householdId, actorId);
              throw new TransactionNotFoundException();
            });
  }

  /**
   * Retained provider merchant identity behind a connected entry's admitted observation, or null
   * for manual entries. The lookup is scoped to the owner so a foreign or replaced association
   * never contributes evidence.
   */
  private String retainedMerchantIdentityDigest(
      UUID householdId, UUID transactionId, UUID actorId) {
    return bankActivity
        .retainedCategorizationEvidence(householdId, transactionId, actorId)
        .map(BankActivityService.RetainedEvidence::merchantIdentityDigest)
        .orElse(null);
  }

  /** Safe provenance projection; the exact seven-field contract with no internal references. */
  private static CategorizationResponse toResponse(
      FinancialTransactionEntity transaction, boolean ruleEligible, boolean hasOpenReview) {
    CategorizationOrigin origin = transaction.getCategoryOrigin();
    return new CategorizationResponse(
        transaction.getId(),
        transaction.getVersion(),
        transaction.getCategory(),
        origin.name(),
        transaction.getCategoryAssignedAt(),
        hasOpenReview ? "OPEN" : "NONE",
        ruleEligible);
  }
}
