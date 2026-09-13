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
}
