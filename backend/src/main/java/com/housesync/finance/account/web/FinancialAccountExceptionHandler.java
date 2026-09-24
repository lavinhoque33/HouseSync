package com.housesync.finance.account.web;

import com.housesync.finance.account.web.FinancialAccountExceptions.FinancialAccountNotFoundException;
import com.housesync.finance.account.web.FinancialAccountExceptions.IdempotencyConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionExhaustedException;
import com.housesync.finance.categorization.web.CategorizationRuleExceptions.CategoryRuleConflictException;
import com.housesync.finance.categorization.web.CategorizationRuleExceptions.RuleIdempotencyConflictException;
import com.housesync.finance.categorization.web.CategorizationRuleExceptions.RuleNotFoundException;
import com.housesync.finance.connection.web.ConnectionExceptions.BankActivityNotFoundException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectedFinanceDisabledException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionDisconnectedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionIdempotencyConflictException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotFoundException;
import com.housesync.finance.connection.web.ConnectionExceptions.ConnectionNotReadyException;
import com.housesync.finance.connection.web.ConnectionExceptions.LinkAttemptExpiredException;
import com.housesync.finance.connection.web.ConnectionExceptions.ManualSyncRateLimitedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationAdmittedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationAlreadyConfirmedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationDismissedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationInvalidException;
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationNotPostedException;
import com.housesync.finance.connection.web.ConnectionExceptions.ProviderTransientException;
import com.housesync.finance.connection.web.ConnectionExceptions.ReconciliationRequiredException;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.WebhookUnavailableException;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.WebhookVerificationException;
import com.housesync.finance.report.web.FinanceSettingsExceptions.FinanceSettingsForbiddenException;
import com.housesync.finance.report.web.FinanceSettingsExceptions.FinanceSettingsVersionConflictException;
import com.housesync.finance.report.web.FinanceSettingsExceptions.FinanceSettingsVersionExhaustedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AccountArchivedException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationIdempotencyConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.AllocationNotFoundException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.RefundConflictException;
import com.housesync.finance.transaction.web.FinancialTransactionExceptions.TransactionForbiddenException;
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

  @ExceptionHandler(TransactionForbiddenException.class)
  public ResponseEntity<ApiError> transactionForbidden(TransactionForbiddenException failure) {
    return error(
        HttpStatus.FORBIDDEN,
        ErrorCodes.FORBIDDEN,
        "Only the entry's owner can change it.",
        null,
        failure);
  }

  @ExceptionHandler(FinanceSettingsForbiddenException.class)
  public ResponseEntity<ApiError> financeSettingsForbidden(
      FinanceSettingsForbiddenException failure) {
    return error(
        HttpStatus.FORBIDDEN,
        ErrorCodes.FORBIDDEN,
        "Only the household owner can change finance settings.",
        null,
        failure);
  }

  @ExceptionHandler(FinanceSettingsVersionConflictException.class)
  public ResponseEntity<ApiError> financeSettingsVersionConflict(
      FinanceSettingsVersionConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.RESOURCE_VERSION_CONFLICT,
        "The finance settings changed. Refresh them before trying again.",
        null,
        failure);
  }

  @ExceptionHandler(FinanceSettingsVersionExhaustedException.class)
  public ResponseEntity<ApiError> financeSettingsVersionExhausted(
      FinanceSettingsVersionExhaustedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.RESOURCE_VERSION_EXHAUSTED,
        "The finance settings can no longer be changed.",
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

  @ExceptionHandler(AllocationNotFoundException.class)
  public ResponseEntity<ApiError> allocationNotFound(AllocationNotFoundException failure) {
    return error(
        HttpStatus.NOT_FOUND,
        ErrorCodes.ALLOCATION_NOT_FOUND,
        "No active allocation was found for this expense.",
        null,
        failure);
  }

  @ExceptionHandler(AllocationConflictException.class)
  public ResponseEntity<ApiError> allocationConflict(AllocationConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.ALLOCATION_CONFLICT,
        "The allocation conflicts with the expense state.",
        null,
        failure);
  }

  @ExceptionHandler(AllocationIdempotencyConflictException.class)
  public ResponseEntity<ApiError> allocationIdempotencyConflict(
      AllocationIdempotencyConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        "That request key was already used for different allocation details.",
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

  @ExceptionHandler(ConnectionNotFoundException.class)
  public ResponseEntity<ApiError> connectionNotFound(ConnectionNotFoundException failure) {
    return error(
        HttpStatus.NOT_FOUND,
        ErrorCodes.FINANCIAL_CONNECTION_NOT_FOUND,
        "Financial connection was not found.",
        null,
        failure);
  }

  @ExceptionHandler(LinkAttemptExpiredException.class)
  public ResponseEntity<ApiError> linkAttemptExpired(LinkAttemptExpiredException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.LINK_ATTEMPT_EXPIRED,
        "This link attempt expired. Start a new one.",
        null,
        failure);
  }

  @ExceptionHandler(ConnectionNotReadyException.class)
  public ResponseEntity<ApiError> connectionNotReady(ConnectionNotReadyException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.CONNECTION_NOT_READY,
        "The connection is not ready for this action.",
        null,
        failure);
  }

  @ExceptionHandler(ConnectionDisconnectedException.class)
  public ResponseEntity<ApiError> connectionDisconnected(ConnectionDisconnectedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.CONNECTION_DISCONNECTED,
        "The connection is no longer active. Link again.",
        null,
        failure);
  }

  @ExceptionHandler(ConnectionIdempotencyConflictException.class)
  public ResponseEntity<ApiError> connectionIdempotencyConflict(
      ConnectionIdempotencyConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        "That request key was already used for different connection details.",
        null,
        failure);
  }

  @ExceptionHandler(ConnectedFinanceDisabledException.class)
  public ResponseEntity<ApiError> connectedFinanceDisabled(
      ConnectedFinanceDisabledException failure) {
    return error(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCodes.CONNECTED_FINANCE_DISABLED,
        "Connected finance is not enabled.",
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

  @ExceptionHandler(ProviderTransientException.class)
  public ResponseEntity<ApiError> providerTransient(ProviderTransientException failure) {
    return error(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCodes.FINANCE_BUSY,
        "The provider is temporarily unavailable. Refresh before retrying.",
        null,
        failure);
  }

  @ExceptionHandler(ManualSyncRateLimitedException.class)
  public ResponseEntity<ApiError> manualSyncRateLimited(ManualSyncRateLimitedException failure) {
    return error(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCodes.MANUAL_SYNC_RATE_LIMITED,
        "A sync ran moments ago. Try again shortly.",
        null,
        failure);
  }

  @ExceptionHandler(BankActivityNotFoundException.class)
  public ResponseEntity<ApiError> bankActivityNotFound(BankActivityNotFoundException failure) {
    return error(
        HttpStatus.NOT_FOUND,
        ErrorCodes.BANK_ACTIVITY_NOT_FOUND,
        "Bank activity was not found.",
        null,
        failure);
  }

  @ExceptionHandler(RuleNotFoundException.class)
  public ResponseEntity<ApiError> ruleNotFound(RuleNotFoundException failure) {
    // Missing, foreign, and other-owner rules are indistinguishable: the message names no
    // household, owner, rule key, or evidence.
    return error(
        HttpStatus.NOT_FOUND,
        ErrorCodes.CATEGORY_RULE_NOT_FOUND,
        "Categorization rule was not found.",
        null,
        failure);
  }

  @ExceptionHandler(CategoryRuleConflictException.class)
  public ResponseEntity<ApiError> ruleConflict(CategoryRuleConflictException failure) {
    // An active rule already exists for this owner's derived match key; the response never
    // reveals whether another owner holds a similar rule.
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.CATEGORY_RULE_CONFLICT,
        "A rule for this exact match already exists.",
        null,
        failure);
  }

  @ExceptionHandler(RuleIdempotencyConflictException.class)
  public ResponseEntity<ApiError> ruleIdempotencyConflict(
      RuleIdempotencyConflictException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        "That request key was already used for different rule details.",
        null,
        failure);
  }

  @ExceptionHandler(ObservationNotPostedException.class)
  public ResponseEntity<ApiError> observationNotPosted(ObservationNotPostedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.OBSERVATION_NOT_POSTED,
        "Only posted bank activity can be confirmed.",
        null,
        failure);
  }

  @ExceptionHandler(ObservationAlreadyConfirmedException.class)
  public ResponseEntity<ApiError> observationAlreadyConfirmed(
      ObservationAlreadyConfirmedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.OBSERVATION_ALREADY_CONFIRMED,
        "That bank activity was already added to the ledger.",
        null,
        failure);
  }

  @ExceptionHandler(ObservationInvalidException.class)
  public ResponseEntity<ApiError> observationInvalid(ObservationInvalidException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.OBSERVATION_INVALID,
        "That bank activity has invalid provider details and needs review.",
        null,
        failure);
  }

  @ExceptionHandler(ObservationDismissedException.class)
  public ResponseEntity<ApiError> observationDismissed(ObservationDismissedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.OBSERVATION_DISMISSED,
        "That bank activity was dismissed.",
        null,
        failure);
  }

  @ExceptionHandler(ObservationAdmittedException.class)
  public ResponseEntity<ApiError> observationAdmitted(ObservationAdmittedException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.OBSERVATION_ADMITTED,
        "That bank activity is already in the ledger.",
        null,
        failure);
  }

  @ExceptionHandler(ReconciliationRequiredException.class)
  public ResponseEntity<ApiError> reconciliationRequired(ReconciliationRequiredException failure) {
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.RECONCILIATION_REQUIRED,
        "The bank change needs a separate review before this action.",
        null,
        failure);
  }

  @ExceptionHandler(WebhookVerificationException.class)
  public ResponseEntity<ApiError> webhookVerification(WebhookVerificationException failure) {
    return error(
        HttpStatus.UNAUTHORIZED,
        ErrorCodes.UNAUTHENTICATED,
        "Request could not be verified.",
        null,
        failure);
  }

  @ExceptionHandler(WebhookUnavailableException.class)
  public ResponseEntity<ApiError> webhookUnavailable(WebhookUnavailableException failure) {
    return error(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCodes.FINANCE_BUSY,
        "Webhook admission is temporarily unavailable.",
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
