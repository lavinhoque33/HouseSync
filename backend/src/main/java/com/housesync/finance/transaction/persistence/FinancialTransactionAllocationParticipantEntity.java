package com.housesync.finance.transaction.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import java.io.Serializable;
import java.math.BigDecimal;
import java.util.Objects;
import java.util.UUID;

/**
 * Frozen original share of one allocation participant: exact minor units at the allocation's
 * currency scale, persisted once at creation and never recomputed from later rosters. The currency
 * column mirrors the allocation's so the database scale check binds the share without a join.
 */
@Entity
@Table(name = "financial_transaction_allocation_participants")
@IdClass(FinancialTransactionAllocationParticipantEntity.Key.class)
public class FinancialTransactionAllocationParticipantEntity {

  @Id
  @Column(name = "allocation_id", nullable = false)
  private UUID allocationId;

  @Id
  @Column(name = "user_id", nullable = false)
  private UUID userId;

  @Column(nullable = false, length = 3)
  private String currency;

  @Column(nullable = false, precision = 15, scale = 3)
  private BigDecimal share;

  protected FinancialTransactionAllocationParticipantEntity() {}

  public FinancialTransactionAllocationParticipantEntity(
      UUID allocationId, UUID userId, String currency, BigDecimal share) {
    this.allocationId = allocationId;
    this.userId = userId;
    this.currency = currency;
    this.share = share;
  }

  public UUID getAllocationId() {
    return allocationId;
  }

  public UUID getUserId() {
    return userId;
  }

  public String getCurrency() {
    return currency;
  }

  public BigDecimal getShare() {
    return share;
  }

  /** Serializable primary-key projection matching the entity's two @Id columns. */
  public static class Key implements Serializable {

    private UUID allocationId;
    private UUID userId;

    protected Key() {}

    public Key(UUID allocationId, UUID userId) {
      this.allocationId = allocationId;
      this.userId = userId;
    }

    @Override
    public boolean equals(Object other) {
      if (this == other) return true;
      if (!(other instanceof Key that)) return false;
      return Objects.equals(allocationId, that.allocationId) && Objects.equals(userId, that.userId);
    }

    @Override
    public int hashCode() {
      return Objects.hash(allocationId, userId);
    }
  }
}
