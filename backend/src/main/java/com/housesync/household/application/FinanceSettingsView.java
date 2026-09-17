package com.housesync.household.application;

/**
 * Household reporting settings as seen by finance integration: the stored IANA region zone plus the
 * optimistic concurrency token. Field mapping only; zone validation lives in the finance reporting
 * policy.
 */
public record FinanceSettingsView(String reportingTimeZone, int version) {}
