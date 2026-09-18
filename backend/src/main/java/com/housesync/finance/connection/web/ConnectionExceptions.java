package com.housesync.finance.connection.web;

public final class ConnectionExceptions {

  private ConnectionExceptions() {}

  /**
   * Indistinguishable 404 for foreign, missing, other-owner, and former-member connections,
   * attempts, operations, and mappings.
   */
  public static final class ConnectionNotFoundException extends RuntimeException {}

  /** Link attempt expired or its replay window closed; start a new attempt. */
  public static final class LinkAttemptExpiredException extends RuntimeException {}

  /** Connection or attempt cannot perform this action in its current state. */
  public static final class ConnectionNotReadyException extends RuntimeException {}

  /** Connection is suspended, disconnecting, or disconnected; link anew instead. */
  public static final class ConnectionDisconnectedException extends RuntimeException {}

  /** Same idempotency key reused with different canonical details. */
  public static final class ConnectionIdempotencyConflictException extends RuntimeException {}

  /** Connected finance is not enabled on this deployment. */
  public static final class ConnectedFinanceDisabledException extends RuntimeException {}

  /** Retryable provider or race outcome; mapped to 503 without provider detail. */
  public static final class ProviderTransientException extends RuntimeException {}

  /** Per-connection manual sync interval exceeded; the client waits and coalesces. */
  public static final class ManualSyncRateLimitedException extends RuntimeException {}

  /** Foreign, missing, other-owner, or former-member bank-activity resources share one 404. */
  public static final class BankActivityNotFoundException extends RuntimeException {}

  /** Observation is pending or removed and cannot be confirmed into the ledger. */
  public static final class ObservationNotPostedException extends RuntimeException {}

  /** The observation already has a current ledger association. */
  public static final class ObservationAlreadyConfirmedException extends RuntimeException {}

  /** The observation is quarantined as invalid and cannot be confirmed. */
  public static final class ObservationInvalidException extends RuntimeException {}

  /** The observation was dismissed; a material provider revision must reopen it first. */
  public static final class ObservationDismissedException extends RuntimeException {}

  /** Dismissal target is already admitted; dismiss only applies to unadmitted observations. */
  public static final class ObservationAdmittedException extends RuntimeException {}

  /**
   * Ledger and bank facts cannot be reconciled with the requested action: applying bank facts to a
   * removed observation, replacing without a current posted revision, or a currency/account
   * mismatch that needs a separately reviewed mapping correction.
   */
  public static final class ReconciliationRequiredException extends RuntimeException {}
}
