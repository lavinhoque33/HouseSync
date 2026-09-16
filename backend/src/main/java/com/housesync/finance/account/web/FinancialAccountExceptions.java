package com.housesync.finance.account.web;

public final class FinancialAccountExceptions {

  private FinancialAccountExceptions() {}

  public static final class FinancialAccountNotFoundException extends RuntimeException {}

  public static final class IdempotencyConflictException extends RuntimeException {}

  public static final class ResourceVersionConflictException extends RuntimeException {}

  public static final class ResourceVersionExhaustedException extends RuntimeException {}
}
