package com.housesync.finance.report.web;

/**
 * Finance-settings failures mapped by the shared finance exception advice. Messages stay generic so
 * missing and non-member households remain indistinguishable and no zone or version state is ever
 * embedded.
 */
public final class FinanceSettingsExceptions {

  private FinanceSettingsExceptions() {}

  /** A current non-owner member lacks authority over household finance settings. */
  public static final class FinanceSettingsForbiddenException extends RuntimeException {}

  public static final class FinanceSettingsVersionConflictException extends RuntimeException {}

  public static final class FinanceSettingsVersionExhaustedException extends RuntimeException {}
}
