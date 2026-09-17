package com.housesync.finance.account.persistence;

import com.housesync.finance.account.domain.FinancialAccountKind;
import com.housesync.finance.account.domain.FinancialAccountStatus;
import com.housesync.finance.account.domain.SupportedCurrency;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "financial_accounts")
public class FinancialAccountEntity {

  @Id private UUID id;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(nullable = false, length = 100)
  private String name;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 32)
  private FinancialAccountKind kind;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 3)
  private SupportedCurrency currency;

  @Column(nullable = false, length = 16)
  private String source;

  @Column(nullable = false, length = 16)
  private String visibility;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 16)
  private FinancialAccountStatus status;

  @Column(nullable = false)
  private int version;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected FinancialAccountEntity() {}

  public FinancialAccountEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      String name,
      FinancialAccountKind kind,
      SupportedCurrency currency,
      Instant createdAt) {
    this(id, householdId, ownerUserId, name, kind, currency, "MANUAL", createdAt);
  }

  private FinancialAccountEntity(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      String name,
      FinancialAccountKind kind,
      SupportedCurrency currency,
      String source,
      Instant createdAt) {
    this.id = id;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.name = name;
    this.kind = kind;
    this.currency = currency;
    this.source = source;
    this.visibility = "PRIVATE";
    this.status = FinancialAccountStatus.ACTIVE;
    this.version = 0;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  /**
   * Creates a private account row admitted through explicit connected-account selection. The caller owns the surrounding selection transaction and has already validated
   * kind/currency eligibility and label policy.
   */
  public static FinancialAccountEntity connected(
      UUID id,
      UUID householdId,
      UUID ownerUserId,
      String name,
      FinancialAccountKind kind,
      SupportedCurrency currency,
      Instant createdAt) {
    return new FinancialAccountEntity(
        id, householdId, ownerUserId, name, kind, currency, "CONNECTED", createdAt);
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

  public String getName() {
    return name;
  }

  public FinancialAccountKind getKind() {
    return kind;
  }

  public SupportedCurrency getCurrency() {
    return currency;
  }

  public String getSource() {
    return source;
  }

  public String getVisibility() {
    return visibility;
  }

  public FinancialAccountStatus getStatus() {
    return status;
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

  public void update(String name, FinancialAccountStatus status, Instant updatedAt) {
    this.name = name;
    this.status = status;
    this.version += 1;
    this.updatedAt = updatedAt;
  }
}
