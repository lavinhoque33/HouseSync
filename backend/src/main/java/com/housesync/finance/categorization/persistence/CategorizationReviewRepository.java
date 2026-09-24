package com.housesync.finance.categorization.persistence;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CategorizationReviewRepository
    extends JpaRepository<CategorizationReviewEntity, UUID> {
  @Query(
      "SELECT r FROM CategorizationReviewEntity r, HouseholdMemberEntity m WHERE r.id = :id AND r.householdId = :household AND r.ownerUserId = :owner AND m.householdId = r.householdId AND m.userId = :owner")
  Optional<CategorizationReviewEntity> findOwned(
      @Param("household") UUID household, @Param("id") UUID id, @Param("owner") UUID owner);

  @Query(
      "SELECT r FROM CategorizationReviewEntity r, HouseholdMemberEntity m WHERE r.transactionId = :id AND r.source = :source AND r.policyVersion = :policy AND r.evidenceFingerprint = :evidence AND r.householdId = :household AND r.ownerUserId = :owner AND m.householdId = r.householdId AND m.userId = :owner")
  Optional<CategorizationReviewEntity> findOwnedEvidence(
      @Param("household") UUID household,
      @Param("owner") UUID owner,
      @Param("id") UUID transactionId,
      @Param("source") String source,
      @Param("policy") String policy,
      @Param("evidence") String evidence);

  @Query(
      "SELECT r FROM CategorizationReviewEntity r, HouseholdMemberEntity m WHERE r.transactionId = :id AND r.status = 'OPEN' AND r.householdId = :household AND r.ownerUserId = :owner AND m.householdId = r.householdId AND m.userId = :owner")
  Optional<CategorizationReviewEntity> findOwnedOpen(
      @Param("household") UUID household,
      @Param("owner") UUID owner,
      @Param("id") UUID transactionId);

  @Query(
      "SELECT COUNT(r) FROM CategorizationReviewEntity r, HouseholdMemberEntity m WHERE r.householdId = :household AND r.ownerUserId = :owner AND r.status = 'OPEN' AND m.householdId = r.householdId AND m.userId = :owner")
  long countOpen(@Param("household") UUID household, @Param("owner") UUID owner);
}
