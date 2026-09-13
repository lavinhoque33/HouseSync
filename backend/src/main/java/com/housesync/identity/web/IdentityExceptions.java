package com.housesync.identity.web;

import java.util.Map;

/**
 * Domain exceptions for authentication flows. Each maps to a stable contract status/code in {@link
 * AuthExceptionHandler}; messages stay generic so unknown identifiers and wrong passwords are
 * indistinguishable.
 */
public final class IdentityExceptions {

  private IdentityExceptions() {}

  public static final class ValidationFailedException extends RuntimeException {
    private final Map<String, String> fieldErrors;

    public ValidationFailedException(Map<String, String> fieldErrors) {
      super("Validation failed.");
      this.fieldErrors = Map.copyOf(fieldErrors);
    }

    public Map<String, String> getFieldErrors() {
      return fieldErrors;
    }
  }

  public static final class RegistrationConflictException extends RuntimeException {
    public RegistrationConflictException() {
      super("Registration conflict.");
    }

    public RegistrationConflictException(Throwable cause) {
      super("Registration conflict.", cause);
    }
  }

  public static final class InvalidCredentialsException extends RuntimeException {
    public InvalidCredentialsException() {
      super("Invalid credentials.");
    }

    public InvalidCredentialsException(Throwable cause) {
      super("Invalid credentials.", cause);
    }
  }

  public static final class UnauthenticatedException extends RuntimeException {
    public UnauthenticatedException() {
      super("Authentication is required.");
    }
  }

  public static final class RateLimitedException extends RuntimeException {
    private final long retryAfterSeconds;

    public RateLimitedException(long retryAfterSeconds) {
      super("Rate limit exceeded.");
      this.retryAfterSeconds = Math.max(1L, retryAfterSeconds);
    }

    public long getRetryAfterSeconds() {
      return retryAfterSeconds;
    }
  }
}
