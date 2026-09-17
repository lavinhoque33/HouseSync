package com.housesync.finance.account.web;

import com.housesync.finance.account.web.FinancialAccountExceptions.FinancialAccountNotFoundException;
import com.housesync.finance.account.web.FinancialAccountExceptions.IdempotencyConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionExhaustedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AccountArchivedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.RefundConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionIdempotencyConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVersionExhaustedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionVoidedException;
import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.housesync.identity.web.ApiError;
import com.housesync.identity.web.CorrelationIds;
import com.housesync.identity.web.ErrorCodes;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Maps finance-flow failures (accounts and transactions) to the shared safe error shape (reusing
 * the identity {@link ApiError}, {@link ErrorCodes}, and {@link CorrelationIds} so there is exactly
 * one error contract).
 *
 * <p>Scoped to the finance package so identity endpoints keep their existing mappings. There is
 * deliberately no catch-all {@code Exception} handler: unexpected failures and the finance
 * controllers' defense-in-depth {@code UnauthenticatedException} must fall through to the identity
 * handler so a missing session degrades to 401 {@code UNAUTHENTICATED}, never a fabricated 500.
 */
@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice(basePackages = "com.housesync.finance")
public class FinancialAccountExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(FinancialAccountExceptionHandler.class);

  @ExceptionHandler(ValidationFailedException.class)
  public ResponseEntity<ApiError> validation(ValidationFailedException failure) {
    return error(
        HttpStatus.BAD_REQUEST,
        ErrorCodes.VALIDATION_FAILED,
        "Check the supplied details.",
        failure.getFieldErrors(),
        failure);
  }

  @ExceptionHandler({
    HttpMessageNotReadableException.class,
    MethodArgumentTypeMismatchException.class
  })
  public ResponseEntity<ApiError> malformed(Exception failure) {
    return error(
        HttpStatus.BAD_REQUEST,
        ErrorCodes.VALIDATION_FAILED,
        "Check the supplied details.",
        null,
        failure);
  }

  @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
  public ResponseEntity<ApiError> unsupportedMedia(HttpMediaTypeNotSupportedException failure) {
    return error(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        ErrorCodes.VALIDATION_FAILED,
        "Unsupported media type.",
        null,
        failure);
  }

  @ExceptionHandler(HouseholdNotFoundException.class)
  public ResponseEntity<ApiError> householdNotFound(HouseholdNotFoundException failure) {
    return error(
        HttpStatus.NOT_FOUND,
        ErrorCodes.HOUSEHOLD_NOT_FOUND,
        "Household was not found.",
        null,
        failure);
  }

  @ExceptionHandler(FinancialAccountNotFoundException.class)
  public ResponseEntity<ApiError> accountNotFound(FinancialAccountNotFoundException failure) {
    return error(
        HttpStatus.NOT_FOUND,
        ErrorCodes.FINANCIAL_ACCOUNT_NOT_FOUND,
        "Financial account was not found.",
        null,
        failure);
  }

  @ExceptionHandler(TransactionNotFoundException.class)
  public ResponseEntity<ApiError> transactionNotFound(TransactionNotFoundException failure) {
    return error(
        HttpStatus.NOT_FOUND,
        ErrorCodes.TRANSACTION_NOT_FOUND,
        "Financial transaction was not found.",
        null,
        failure);
  }

  @ExceptionHandler(AccountArchivedException.class)
  public ResponseEntity<ApiError> accountArchived(AccountArchivedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.ACCOUNT_ARCHIVED,
        "The financial account is archived.",
        null,
        failure);
  }

  @ExceptionHandler(RefundConflictException.class)
  public ResponseEntity<ApiError> refundConflict(RefundConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.REFUND_CONFLICT,
        "The refund conflicts with its expense.",
        null,
        failure);
  }

  @ExceptionHandler(TransactionVoidedException.class)
  public ResponseEntity<ApiError> transactionVoided(TransactionVoidedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.TRANSACTION_VOIDED,
        "The transaction is voided.",
        null,
        failure);
  }

  @ExceptionHandler(TransactionIdempotencyConflictException.class)
  public ResponseEntity<ApiError> transactionIdempotencyConflict(
      TransactionIdempotencyConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        "That request key was already used for different transaction details.",
        null,
        failure);
  }

  @ExceptionHandler(TransactionVersionConflictException.class)
  public ResponseEntity<ApiError> transactionVersionConflict(
      TransactionVersionConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.RESOURCE_VERSION_CONFLICT,
        "The transaction changed. Refresh it before trying again.",
        null,
        failure);
  }

  @ExceptionHandler(TransactionVersionExhaustedException.class)
  public ResponseEntity<ApiError> transactionVersionExhausted(
      TransactionVersionExhaustedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.RESOURCE_VERSION_EXHAUSTED,
        "The transaction can no longer be changed.",
        null,
        failure);
  }

  @ExceptionHandler(IdempotencyConflictException.class)
  public ResponseEntity<ApiError> idempotencyConflict(IdempotencyConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        "That request key was already used for different account details.",
        null,
        failure);
  }

  @ExceptionHandler(ResourceVersionConflictException.class)
  public ResponseEntity<ApiError> versionConflict(ResourceVersionConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.RESOURCE_VERSION_CONFLICT,
        "The account changed. Refresh it before trying again.",
        null,
        failure);
  }

  @ExceptionHandler(ResourceVersionExhaustedException.class)
  public ResponseEntity<ApiError> versionExhausted(ResourceVersionExhaustedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.RESOURCE_VERSION_EXHAUSTED,
        "The account can no longer be changed.",
        null,
        failure);
  }

  @ExceptionHandler({PessimisticLockingFailureException.class, QueryTimeoutException.class})
  public ResponseEntity<ApiError> busy(Exception failure) {
    return error(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCodes.FINANCE_BUSY,
        "Finance is busy. Refresh before retrying.",
        null,
        failure);
  }

  private ResponseEntity<ApiError> error(
      HttpStatus status,
      String code,
      String message,
      Map<String, String> fieldErrors,
      Exception failure) {
    String correlationId = CorrelationIds.newId();
    if (status.is5xxServerError()) {
      log.error(
          "event=finance.request_failed code={} correlationId={} cause={}",
          code,
          correlationId,
          failure.getClass().getSimpleName());
    } else {
      log.warn(
          "event=finance.request_failed code={} correlationId={} cause={}",
          code,
          correlationId,
          failure.getClass().getSimpleName());
    }
    // Top-level (body/query/header) validations carry no field errors: the optional map is omitted
    // rather than emitted empty, and it never names synthetic keys or echoes submitted values.
    ApiError body =
        fieldErrors == null || fieldErrors.isEmpty()
            ? ApiError.of(code, message, correlationId)
            : ApiError.of(code, message, correlationId, fieldErrors);
    return ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }
}
