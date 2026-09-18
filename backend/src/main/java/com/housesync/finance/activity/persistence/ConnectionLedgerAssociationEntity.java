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
 * <p>Replacement moves the CURRENT row to VOIDED while the replacement becomes CURRENT, so
 * earlier provenance is retained and the partial unique index keeps exactly one current association
 * per observation.
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

  /**
   * Replacement history step: the superseded CURRENT row is retained as VOIDED while the
   * replacement becomes CURRENT. A directly voided imported entry keeps its CURRENT row and stays
   * associated and excluded.
   */
  public void voided() {
    this.state = "VOIDED";
  }

  public Instant getCreatedAt() {
    return createdAt;
  }
}
