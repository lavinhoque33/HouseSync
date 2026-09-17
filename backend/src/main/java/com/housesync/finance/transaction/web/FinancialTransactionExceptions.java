package com.housesync.finance.transaction.web;

/**
 * Transaction-flow failures mapped by the shared finance exception advice. Messages stay generic so
 * missing, foreign, and hidden resources are indistinguishable, and no financial payload, version,
 * or refund state is ever embedded.
 */
public final class FinancialTransactionExceptions {

  private FinancialTransactionExceptions() {}

  public static final class TransactionNotFoundException extends RuntimeException {}

  public static final class TransactionIdempotencyConflictException extends RuntimeException {}

  public static final class TransactionVersionConflictException extends RuntimeException {}

  public static final class TransactionVersionExhaustedException extends RuntimeException {}

  public static final class AccountArchivedException extends RuntimeException {}

  public static final class RefundConflictException extends RuntimeException {}

  public static final class TransactionVoidedException extends RuntimeException {}
}
