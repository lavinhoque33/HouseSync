package com.housesync.identity.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Maps authentication-flow failures to the stable contract error shape. Every response carries an
 * opaque correlation id and is not cacheable; nothing submitted by the caller, no SQL, and no stack
 * trace ever leaves the server.
 */
@RestControllerAdvice
public class AuthExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(AuthExceptionHandler.class);

  @ExceptionHandler(IdentityExceptions.ValidationFailedException.class)
  public ResponseEntity<ApiError> validation(IdentityExceptions.ValidationFailedException failure) {
    return error(
        HttpStatus.BAD_REQUEST,
        ErrorCodes.VALIDATION_FAILED,
        "Check the supplied details.",
        failure.getFieldErrors(),
        null);
  }

  /** Malformed JSON and rejected (for example unknown-field) request shapes. */
  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<ApiError> unreadable(HttpMessageNotReadableException failure) {
    return error(
        HttpStatus.BAD_REQUEST,
        ErrorCodes.VALIDATION_FAILED,
        "Check the supplied details.",
        null,
        failure);
  }

  /** Unsupported request content types. Shares the validation code; the status stays 415. */
  @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
  public ResponseEntity<ApiError> unsupportedMedia(HttpMediaTypeNotSupportedException failure) {
    return error(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        ErrorCodes.VALIDATION_FAILED,
        "Unsupported media type.",
        null,
        failure);
  }

  @ExceptionHandler(IdentityExceptions.RegistrationConflictException.class)
  public ResponseEntity<ApiError> conflict(
      IdentityExceptions.RegistrationConflictException failure) {
    // Generic on purpose: success/conflict distinguishability is a documented limited tradeoff.
    return error(
        HttpStatus.CONFLICT,
        ErrorCodes.REGISTRATION_CONFLICT,
        "An account with that email already exists.",
        null,
        failure);
  }

  @ExceptionHandler(IdentityExceptions.InvalidCredentialsException.class)
  public ResponseEntity<ApiError> invalidCredentials(
      IdentityExceptions.InvalidCredentialsException failure) {
    // Identical for unknown identifiers and incorrect passwords.
    return error(
        HttpStatus.UNAUTHORIZED,
        ErrorCodes.INVALID_CREDENTIALS,
        "Email or password is incorrect.",
        null,
        failure);
  }

  @ExceptionHandler(IdentityExceptions.UnauthenticatedException.class)
  public ResponseEntity<ApiError> unauthenticated(
      IdentityExceptions.UnauthenticatedException failure) {
    return error(
        HttpStatus.UNAUTHORIZED,
        ErrorCodes.UNAUTHENTICATED,
        "Authentication is required.",
        null,
        failure);
  }

  @ExceptionHandler(IdentityExceptions.RateLimitedException.class)
  public ResponseEntity<ApiError> rateLimited(IdentityExceptions.RateLimitedException failure) {
    String correlationId = CorrelationIds.newId();
    log.warn(
        "event=auth.rate_limited code={} correlationId={}", ErrorCodes.RATE_LIMITED, correlationId);
    return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
        .header("Retry-After", Long.toString(failure.getRetryAfterSeconds()))
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(
            ApiError.of(ErrorCodes.RATE_LIMITED, "Too many attempts. Retry later.", correlationId));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<ApiError> unexpected(Exception failure) {
    return error(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCodes.INTERNAL_ERROR,
        "Something went wrong. Retry later.",
        null,
        failure);
  }

  private ResponseEntity<ApiError> error(
      HttpStatus status,
      String code,
      String message,
      java.util.Map<String, String> fieldErrors,
      Exception failure) {
    String correlationId = CorrelationIds.newId();
    if (failure == null) {
      log.warn("event=auth.request_failed code={} correlationId={}", code, correlationId);
    } else if (status.is5xxServerError()) {
      log.error("event=auth.request_failed code={} correlationId={}", code, correlationId, failure);
    } else {
      log.warn(
          "event=auth.request_failed code={} correlationId={} cause={}",
          code,
          correlationId,
          failure.getClass().getSimpleName());
    }
    ApiError body =
        fieldErrors == null
            ? ApiError.of(code, message, correlationId)
            : ApiError.of(code, message, correlationId, fieldErrors);
    return ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(body);
  }
}
