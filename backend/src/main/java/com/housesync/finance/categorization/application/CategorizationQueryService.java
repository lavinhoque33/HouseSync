package com.housesync.finance.categorization.application;

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
 * Owner-private categorization read use case. The route is financial-owner-only: the
 * authorization scope is the owner-scoped transaction lookup, so another current member — even one
 * sharing the household-disclosed entry — receives the generic privacy-preserving transaction 404
 * exactly like a foreign or missing resource. Only provenance is exposed; the review state is
 * constant {@code NONE} until the review queue exists.
 */
@Service
public class CategorizationQueryService {

  /** No review queue exists yet, so no transaction can ever be open for review. */
  private static final String REVIEW_STATE_NONE = "NONE";

  private final FinancialTransactionRepository transactions;
  private final HouseholdService households;

  public CategorizationQueryService(
      FinancialTransactionRepository transactions, HouseholdService households) {
    this.transactions = transactions;
    this.households = households;
  }

  @Transactional(readOnly = true)
  public CategorizationResponse get(UUID householdId, UUID transactionId, UUID actorId) {
    // Owner-scoped lookup IS the authorization: a member who does not own the row — including
    // one the entry is shared with — falls into the same generic transaction 404 as a foreign or
    // missing resource, so existence is never disclosed through this resource.
    return transactions
        .findOwnedScoped(householdId, transactionId, actorId)
        .map(CategorizationQueryService::toResponse)
        .orElseGet(
            () -> {
              // Separates the resource 404 from the household 404 for a non-member without
              // widening what a member learns about another owner's entries.
              households.requireFinanceMembership(householdId, actorId);
              throw new TransactionNotFoundException();
            });
  }

  /** Safe provenance projection; the exact six-field contract with no internal references. */
  private static CategorizationResponse toResponse(FinancialTransactionEntity transaction) {
    CategorizationOrigin origin = transaction.getCategoryOrigin();
    return new CategorizationResponse(
        transaction.getId(),
        transaction.getVersion(),
        transaction.getCategory(),
        origin.name(),
        transaction.getCategoryAssignedAt(),
        REVIEW_STATE_NONE);
  }
}
