package com.housesync.identity.web;

/** Stable error codes for the identity/session and household contracts. */
public final class ErrorCodes {

  public static final String VALIDATION_FAILED = "VALIDATION_FAILED";
  public static final String INVALID_CREDENTIALS = "INVALID_CREDENTIALS";
  public static final String UNAUTHENTICATED = "UNAUTHENTICATED";
  public static final String CSRF_INVALID = "CSRF_INVALID";
  public static final String FORBIDDEN = "FORBIDDEN";
  public static final String REGISTRATION_CONFLICT = "REGISTRATION_CONFLICT";
  public static final String RATE_LIMITED = "RATE_LIMITED";
  public static final String HOUSEHOLD_NOT_FOUND = "HOUSEHOLD_NOT_FOUND";
  public static final String INTERNAL_ERROR = "INTERNAL_ERROR";

  private ErrorCodes() {}
}
