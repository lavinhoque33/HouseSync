package com.housesync.finance.connection.plaid;

/**
 * Adapter failure carrying only the normalized class. The message is a fixed safe token; provider
 * payloads, identifiers, and secrets are never attached.
 */
public class PlaidAdapterException extends RuntimeException {

  private final ProviderErrorClass errorClass;
  private final Long retryAfterSeconds;

  public PlaidAdapterException(ProviderErrorClass errorClass) {
    this(errorClass, null);
  }

  public PlaidAdapterException(ProviderErrorClass errorClass, Long retryAfterSeconds) {
    super("provider." + errorClass.name().toLowerCase());
    this.errorClass = errorClass;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  public ProviderErrorClass getErrorClass() {
    return errorClass;
  }

  /** Valid provider Retry-After delay in seconds, or null when absent or malformed. */
  public Long getRetryAfterSeconds() {
    return retryAfterSeconds;
  }
}
