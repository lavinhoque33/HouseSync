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
}
