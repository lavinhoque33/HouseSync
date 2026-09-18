package com.housesync.identity.web;

/** Stable error codes for the identity/session, household, invitation, and finance contracts. */
public final class ErrorCodes {

  public static final String VALIDATION_FAILED = "VALIDATION_FAILED";
  public static final String INVALID_CREDENTIALS = "INVALID_CREDENTIALS";
  public static final String UNAUTHENTICATED = "UNAUTHENTICATED";
  public static final String CSRF_INVALID = "CSRF_INVALID";
  public static final String FORBIDDEN = "FORBIDDEN";
  public static final String REGISTRATION_CONFLICT = "REGISTRATION_CONFLICT";
  public static final String RATE_LIMITED = "RATE_LIMITED";
  public static final String HOUSEHOLD_NOT_FOUND = "HOUSEHOLD_NOT_FOUND";
  public static final String MEMBERSHIP_NOT_FOUND = "MEMBERSHIP_NOT_FOUND";
  public static final String LAST_OWNER_REQUIRED = "LAST_OWNER_REQUIRED";
  public static final String INVITATION_NOT_FOUND = "INVITATION_NOT_FOUND";
  public static final String FINANCIAL_ACCOUNT_NOT_FOUND = "FINANCIAL_ACCOUNT_NOT_FOUND";
  public static final String FINANCIAL_CONNECTION_NOT_FOUND = "FINANCIAL_CONNECTION_NOT_FOUND";
  public static final String LINK_ATTEMPT_EXPIRED = "LINK_ATTEMPT_EXPIRED";
  public static final String CONNECTION_NOT_READY = "CONNECTION_NOT_READY";
  public static final String CONNECTION_DISCONNECTED = "CONNECTION_DISCONNECTED";
  public static final String CONNECTED_FINANCE_DISABLED = "CONNECTED_FINANCE_DISABLED";
  public static final String TRANSACTION_NOT_FOUND = "TRANSACTION_NOT_FOUND";
  public static final String ACCOUNT_ARCHIVED = "ACCOUNT_ARCHIVED";
  public static final String REFUND_CONFLICT = "REFUND_CONFLICT";
  public static final String TRANSACTION_VOIDED = "TRANSACTION_VOIDED";
  public static final String ALLOCATION_NOT_FOUND = "ALLOCATION_NOT_FOUND";
  public static final String ALLOCATION_CONFLICT = "ALLOCATION_CONFLICT";
  public static final String IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT";
  public static final String RESOURCE_VERSION_CONFLICT = "RESOURCE_VERSION_CONFLICT";
  public static final String RESOURCE_VERSION_EXHAUSTED = "RESOURCE_VERSION_EXHAUSTED";
  public static final String FINANCE_BUSY = "FINANCE_BUSY";
  public static final String BANK_ACTIVITY_NOT_FOUND = "BANK_ACTIVITY_NOT_FOUND";
  public static final String OBSERVATION_NOT_POSTED = "OBSERVATION_NOT_POSTED";
  public static final String OBSERVATION_ALREADY_CONFIRMED = "OBSERVATION_ALREADY_CONFIRMED";
  public static final String OBSERVATION_INVALID = "OBSERVATION_INVALID";
  public static final String OBSERVATION_DISMISSED = "OBSERVATION_DISMISSED";
  public static final String OBSERVATION_ADMITTED = "OBSERVATION_ADMITTED";
  public static final String RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED";
  public static final String MANUAL_SYNC_RATE_LIMITED = "MANUAL_SYNC_RATE_LIMITED";
  public static final String INTERNAL_ERROR = "INTERNAL_ERROR";

  private ErrorCodes() {}
}
