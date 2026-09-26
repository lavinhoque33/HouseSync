package com.housesync.finance.report.application;

public final class RecurringExceptions {
  private RecurringExceptions() {}

  public static final class NotFound extends RuntimeException {}

  public static final class Forbidden extends RuntimeException {}

  public static final class Conflict extends RuntimeException {}

  public static final class VersionConflict extends RuntimeException {}

  public static final class VersionExhausted extends RuntimeException {}

  public static final class IdempotencyConflict extends RuntimeException {}
}
