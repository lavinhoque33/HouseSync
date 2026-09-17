package com.housesync.finance.transaction.domain;

/** Ledger lifecycle: manual entries are POSTED; correction by voiding retains the record. */
public enum TransactionStatus {
  POSTED,
  VOIDED
}
