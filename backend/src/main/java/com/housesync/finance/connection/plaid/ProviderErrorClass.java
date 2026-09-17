package com.housesync.finance.connection.plaid;

/**
 * Normalized provider failure classes (connected-finance contract §3). Provider codes are
 * diagnostic mappings only; raw provider messages never leave the adapter.
 */
public enum ProviderErrorClass {
  NOT_READY,
  REAUTH_REQUIRED,
  CONSENT_REVOKED,
  RATE_LIMITED,
  TRANSIENT,
  PAGINATION_RESTART,
  PERMANENT,
  INVALID_DATA
}
