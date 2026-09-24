package com.housesync.finance.categorization.persistence;

import com.housesync.finance.categorization.domain.RuleMatchType;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CategorizationRuleRepository
    extends JpaRepository<CategorizationRuleEntity, UUID> {

  /**
   * Authorized owner-scoped management lookup: the actor's own rule in this household only.
   * Membership is joined in the same query so a removed or non-member actor never resolves the row;
   * another member — whatever their household role — falls into the same private 404.
   */
  @Query(
      "SELECT r FROM CategorizationRuleEntity r, HouseholdMemberEntity m"
          + " WHERE r.id = :ruleId AND r.householdId = :householdId"
          + " AND r.ownerUserId = :actorId"
          + " AND m.householdId = r.householdId AND m.userId = :actorId")
  Optional<CategorizationRuleEntity> findOwnedScoped(
      @Param("householdId") UUID householdId,
      @Param("ruleId") UUID ruleId,
      @Param("actorId") UUID actorId);

  /** Row-locked variant for the authorized mutation path; missing/foreign rows stay invisible. */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT r FROM CategorizationRuleEntity r"
          + " WHERE r.id = :ruleId AND r.householdId = :householdId AND r.ownerUserId = :actorId")
  Optional<CategorizationRuleEntity> findOwnedForUpdate(
      @Param("householdId") UUID householdId,
      @Param("ruleId") UUID ruleId,
      @Param("actorId") UUID actorId);

  /**
   * Exact active-rule classification lookup, scoped by household and financial owner in SQL
   * (categorization contract §3): fetching broadly and filtering in memory is prohibited. The
   * partial unique index guarantees at most one match.
   */
  @Query(
      "SELECT r FROM CategorizationRuleEntity r"
          + " WHERE r.householdId = :householdId AND r.ownerUserId = :ownerUserId"
          + " AND r.matchType = :matchType AND r.matchKey = :matchKey"
          + " AND r.status = com.housesync.finance.categorization.domain.RuleStatus.ACTIVE")
  Optional<CategorizationRuleEntity> findActiveMatch(
      @Param("householdId") UUID householdId,
      @Param("ownerUserId") UUID ownerUserId,
      @Param("matchType") RuleMatchType matchType,
      @Param("matchKey") String matchKey);
}
