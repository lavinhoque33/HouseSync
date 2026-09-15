package com.housesync.household.web;

/**
 * Household-flow failures. Each maps to a stable contract status/code in {@link
 * HouseholdExceptionHandler}; messages stay generic so missing and non-member households are
 * indistinguishable.
 */
public final class HouseholdExceptions {

  private HouseholdExceptions() {}

  public static final class HouseholdNotFoundException extends RuntimeException {
    public HouseholdNotFoundException() {
      super("Household not found.");
    }
  }

  public static final class MembershipNotFoundException extends RuntimeException {
    public MembershipNotFoundException() {
      super("Membership not found.");
    }
  }

  public static final class MembershipForbiddenException extends RuntimeException {
    public MembershipForbiddenException() {
      super("Owner access is required.");
    }
  }

  public static final class MembershipSelfTargetException extends RuntimeException {
    public MembershipSelfTargetException() {
      super("Use the leave operation for your own membership.");
    }
  }

  public static final class LastOwnerRequiredException extends RuntimeException {
    public LastOwnerRequiredException() {
      super("The household must keep an owner.");
    }
  }
}
