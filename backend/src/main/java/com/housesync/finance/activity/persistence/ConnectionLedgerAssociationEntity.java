package com.housesync.finance.activity.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Observation-to-ledger provenance. At most one CURRENT association may exist per
 * observation (partial unique index) and per ledger entry; the association is what makes an
 * observation admitted, and a confirmation without it can never be visible reporting.
 *
 * <p>Resolution/replacement is out of scope: only CURRENT rows are created here, while the
 * VOIDED state reserves retained history for later use.
 */
@Entity
@Table(name = "connection_ledger_associations")
public class ConnectionLedgerAssociationEntity {

  @Id private UUID id;

  @Column(name = "observation_id", nullable = false)
  private UUID observationId;

  @Column(name = "transaction_id", nullable = false)
  private UUID transactionId;

  @Column(name = "household_id", nullable = false)
  private UUID householdId;

  @Column(name = "owner_user_id", nullable = false)
  private UUID ownerUserId;

  @Column(name = "account_id", nullable = false)
  private UUID accountId;

  /** Admitted currency; the composite reference binds it to the entry's own currency. */
  @Column(nullable = false, length = 3)
  private String currency;

  @Column(name = "admitted_revision", nullable = false, length = 64)
  private String admittedRevision;

  @Column(nullable = false, length = 16)
  private String state;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected ConnectionLedgerAssociationEntity() {}

  public ConnectionLedgerAssociationEntity(
      UUID id,
      UUID observationId,
      UUID transactionId,
      UUID householdId,
      UUID ownerUserId,
      UUID accountId,
      String currency,
      String admittedRevision,
      Instant now) {
    this.id = id;
    this.observationId = observationId;
    this.transactionId = transactionId;
    this.householdId = householdId;
    this.ownerUserId = ownerUserId;
    this.accountId = accountId;
    this.currency = currency;
    this.admittedRevision = admittedRevision;
    this.state = "CURRENT";
    this.createdAt = now;
  }

  public UUID getId() {
    return id;
  }

  public UUID getObservationId() {
    return observationId;
  }

  public UUID getTransactionId() {
    return transactionId;
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

  public String getCurrency() {
    return currency;
  }

  public String getAdmittedRevision() {
    return admittedRevision;
  }

  public String getState() {
    return state;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }
}
