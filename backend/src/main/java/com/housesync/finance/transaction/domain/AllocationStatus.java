package com.housesync.finance.transaction.domain;

/** Lifecycle of an expense allocation: created active, optionally revoked once, never restored. */
public enum AllocationStatus {
  ACTIVE,
  REVOKED
}
