package com.housesync.finance.report.web;

/**
 * Exact documented finance-settings DTO: the household reporting zone plus the optimistic
 * concurrency token. Only current members read it; only a current household owner changes it.
 */
public record FinanceSettingsResponse(String reportingTimeZone, int version) {}
