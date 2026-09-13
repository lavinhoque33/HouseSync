package com.housesync.household.invitation.web;

/**
 * Invitation-flow failures. Each maps to a stable contract status/code in {@link
 * com.housesync.household.web.HouseholdExceptionHandler}; messages stay generic so wrong, expired,
 * revoked, consumed, missing, and wrong-household capabilities are indistinguishable.
 */
public final class InvitationExceptions {

  private InvitationExceptions() {}

  public static final class InvitationNotFoundException extends RuntimeException {
    public InvitationNotFoundException() {
      super("Invitation not found.");
    }
  }

  public static final class InvitationForbiddenException extends RuntimeException {
    public InvitationForbiddenException() {
      super("Invitation access is denied.");
    }
  }

  public static final class InvitationServiceException extends RuntimeException {
    public InvitationServiceException() {
      super("Invitation request failed.");
    }

    public InvitationServiceException(Throwable cause) {
      super("Invitation request failed.", cause);
    }
  }
}
