package com.housesync.finance.transaction.domain;

/** Ledger meaning of a manual entry; the API sign convention lives in the money policy. */
public enum TransactionKind {
  EXPENSE,
  INCOME,
  REFUND,
  TRANSFER
}
