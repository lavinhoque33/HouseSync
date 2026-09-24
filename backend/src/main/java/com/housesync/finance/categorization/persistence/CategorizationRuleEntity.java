package com.housesync.finance.categorization.persistence;

import com.housesync.finance.categorization.domain.CategorizationRulePolicy;
import com.housesync.finance.categorization.domain.RuleMatchType;
import com.housesync.finance.categorization.domain.RuleStatus;
import com.housesync.finance.transaction.domain.TransactionCategory;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * One owner-private exact categorization rule. Rules are scoped to one household and
 * one stable financial owner, never to membership rows, so departure preserves retained history
 * while current membership gates access; a household OWNER role confers no access to another user's
 * rules.
 *
 * <p>The V16 database bounds match forms and status; the partial unique index keeps at most one
 * ACTIVE rule per (household, owner, match type, key). Deactivation is one-way and retained — the
 * table is never hard-deleted while ledger provenance references it. {@code matchKey} is private
 * server state (a normalized text key or a scope-bound provider digest) and never reaches a browser
 * response; {@code matchLabel} is the bounded private display label.
 */
@Entity
@Table(name = "categorization_rules")
public class CategorizationRuleEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "source_transaction_id", nullable = false)
  private UUID sourceTransactionId;

  @Enumerated(EnumType.STRING)
  @Column(name = "match_type", nullable = false, length = 17)
  private RuleMatchType matchType;

  /** Private server-derived key: normalized text or the provider merchant digest. */
  @Column(name = "match_key", nullable = false, length = 200)
  private String matchKey;

  /** Bounded private display label; never the match key. */
  @Column(name = "match_label", nullable = false, length = 200)
  private String matchLabel;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 24)
  private TransactionCategory category;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private RuleStatus status;

  @Column(nullable = false)
  private int version;

  /** Owner-rule ruleset version recorded at creation and copied into OWNER_RULE assignments. */
  @Column(name = "ruleset_version", nullable = false, length = 32)
  private String rulesetVersion;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected CategorizationRuleEntity() {}

  /**
   * Creates one ACTIVE rule at version 0 from server-derived match evidence; clients cannot submit
   * household, owner, or match fields.
   */
  public static CategorizationRuleEntity create(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID sourceTransactionId,
      RuleMatchType matchType,
      String matchKey,
      String matchLabel,
      TransactionCategory category,
      Instant now) {
    CategorizationRuleEntity rule = new CategorizationRuleEntity();
    rule.id = id;
    rule.householdId = householdId;
    rule.ownerUserId = ownerUserId;
    rule.sourceTransactionId = sourceTransactionId;
    rule.matchType = matchType;
    rule.matchKey = matchKey;
    rule.matchLabel = matchLabel;
    rule.category = category;
    rule.status = RuleStatus.ACTIVE;
    rule.version = 0;
    rule.rulesetVersion = CategorizationRulePolicy.RULESET_VERSION;
    rule.createdAt = now;
    rule.updatedAt = now;
    return rule;
  }

  public UUID getId() {
    return id;
  }

  public UUID getHouseholdId() {
    return householdId;
  }

  public UUID getOwnerUserId() {
    return ownerUserId;
  }

  public UUID getSourceTransactionId() {
    return sourceTransactionId;
  }

  public RuleMatchType getMatchType() {
    return matchType;
  }

  public String getMatchKey() {
    return matchKey;
  }

  public String getMatchLabel() {
    return matchLabel;
  }

  public TransactionCategory getCategory() {
    return category;
  }

  public RuleStatus getStatus() {
    return status;
  }

  public int getVersion() {
    return version;
  }

  public String getRulesetVersion() {
    return rulesetVersion;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  /** One authorized category correction on an ACTIVE rule; inactive rules cannot change it. */
  public void categoryChanged(TransactionCategory category, Instant updatedAt) {
    this.category = category;
    this.version += 1;
    this.updatedAt = updatedAt;
  }

  /**
   * The one-way deactivation move: retained with its provenance, never reactivated, and no
   * prior OWNER_RULE assignment is rewritten.
   */
  public void deactivated(Instant updatedAt) {
    this.status = RuleStatus.INACTIVE;
    this.version += 1;
    this.updatedAt = updatedAt;
  }

  public boolean isActive() {
    return status == RuleStatus.ACTIVE;
  }
}
