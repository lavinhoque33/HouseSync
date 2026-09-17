package com.housesync.finance.transaction.persistence;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.transaction.domain.AllocationStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Persisted allocation header mirroring its expense's household, payer, and currency (the composite
 * database reference enforces the mirror), with the immutable original magnitude and the frozen
 * participants in {@link FinancialTransactionAllocationParticipantEntity}. Status moves once from
 * ACTIVE to REVOKED; history is retained with no separate allocation version — the expense
 * transaction version is the only concurrency token.
 */
@Entity
@Table(name = "financial_transaction_allocations")
public class FinancialTransactionAllocationEntity {

  @Id private UUID id;

  @Column(name = "transaction_id", nullable = false)
  private UUID transactionId;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "payer_user_id", nullable = false)
  private UUID payerUserId;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 3)
  private SupportedCurrency currency;

  @Column(name = "original_amount", nullable = false, precision = 15, scale = 3)
  private BigDecimal originalAmount;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private AllocationStatus status;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "revoked_at")
  private Instant revokedAt;

  protected FinancialTransactionAllocationEntity() {}

  public FinancialTransactionAllocationEntity(
      UUID id,
      UUID transactionId,
      UUID householdId,
      UUID payerUserId,
      SupportedCurrency currency,
      BigDecimal originalAmount,
      Instant createdAt) {
    this.id = id;
    this.transactionId = transactionId;
    this.householdId = householdId;
    this.payerUserId = payerUserId;
    this.currency = currency;
    this.originalAmount = originalAmount;
    this.status = AllocationStatus.ACTIVE;
    this.createdAt = createdAt;
    this.revokedAt = null;
  }

  public UUID getId() {
    return id;
  }

  public UUID getTransactionId() {
    return transactionId;
  }

  public UUID getHouseholdId() {
    return householdId;
  }

  public UUID getPayerUserId() {
    return payerUserId;
  }

  public SupportedCurrency getCurrency() {
    return currency;
  }

  public BigDecimal getOriginalAmount() {
    return originalAmount;
  }

  public AllocationStatus getStatus() {
    return status;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getRevokedAt() {
    return revokedAt;
  }

  /** One-way deactivation; the expense version bump is the caller's responsibility. */
  public void revoked(Instant revokedAt) {
    this.status = AllocationStatus.REVOKED;
    this.revokedAt = revokedAt;
  }
}
