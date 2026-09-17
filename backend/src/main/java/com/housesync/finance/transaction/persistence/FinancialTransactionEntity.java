package com.housesync.finance.transaction.persistence;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * Private manual ledger entry. Amounts map to the migration's NUMERIC(15, 3); the exact currency
 * scale was validated before binding, and responses re-pad to the currency scale. Associations stay
 * plain UUID columns: the composite database references enforce household/owner/currency
 * consistency for both the source account and a refund's expense.
 */
@Entity
@Table(name = "financial_transactions")
public class FinancialTransactionEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "account_id", nullable = false)
  private UUID accountId;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private TransactionKind kind;

  @Column(nullable = false, precision = 15, scale = 3)
  private BigDecimal amount;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 3)
  private SupportedCurrency currency;

  @Column(name = "occurred_on", nullable = false)
  private LocalDate occurredOn;

  @Column(nullable = false, length = 200)
  private String description;

  @Column(nullable = false, length = 16)
  private String source;

  @Column(nullable = false, length = 16)
  private String visibility;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private TransactionStatus status;

  @Column(name = "refund_of_transaction_id")
  private UUID refundOfTransactionId;

  @Column(nullable = false)
  private int version;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected FinancialTransactionEntity() {}

  public FinancialTransactionEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      UUID accountId,
      TransactionKind kind,
      BigDecimal amount,
      SupportedCurrency currency,
      LocalDate occurredOn,
      String description,
      UUID refundOfTransactionId,
      Instant createdAt) {
    this.id = id;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.accountId = accountId;
    this.kind = kind;
    this.amount = amount;
    this.currency = currency;
    this.occurredOn = occurredOn;
    this.description = description;
    this.source = "MANUAL";
    this.visibility = "PRIVATE";
    this.status = TransactionStatus.POSTED;
    this.refundOfTransactionId = refundOfTransactionId;
    this.version = 0;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
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

  public UUID getAccountId() {
    return accountId;
  }

  public TransactionKind getKind() {
    return kind;
  }

  public BigDecimal getAmount() {
    return amount;
  }

  public SupportedCurrency getCurrency() {
    return currency;
  }

  public LocalDate getOccurredOn() {
    return occurredOn;
  }

  public String getDescription() {
    return description;
  }

  public String getSource() {
    return source;
  }

  public String getVisibility() {
    return visibility;
  }

  public TransactionStatus getStatus() {
    return status;
  }

  public UUID getRefundOfTransactionId() {
    return refundOfTransactionId;
  }

  public int getVersion() {
    return version;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  /** Retains all economic data while excluding the entry from totals; not restorable. */
  public void voided(Instant updatedAt) {
    this.status = TransactionStatus.VOIDED;
    this.version += 1;
    this.updatedAt = updatedAt;
  }

  /** Economic correction of a posted entry; refund bounds are rechecked by the service. */
  public void correct(
      BigDecimal amount, LocalDate occurredOn, String description, Instant updatedAt) {
    this.amount = amount;
    this.occurredOn = occurredOn;
    this.description = description;
    this.version += 1;
    this.updatedAt = updatedAt;
  }
}
