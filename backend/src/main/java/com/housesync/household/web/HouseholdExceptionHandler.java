package com.housesync.household.web;

import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.housesync.identity.web.ApiError;
import com.housesync.identity.web.CorrelationIds;
import com.housesync.identity.web.ErrorCodes;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Maps household-flow failures to the shared safe error shape (reusing the identity {@link
 * ApiError}, {@link ErrorCodes}, and {@link CorrelationIds} so there is exactly one error
 * contract).
 *
 * <p>Scoped to the household package so identity endpoints keep their existing mappings. Specific
 * exception mappings here always win over the identity handler's generic {@code Exception}
 * fallback, so household 404/validation responses can never degrade into a 500 through handler
 * ordering.
 */
@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice(basePackages = "com.housesync.household")
public class HouseholdExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(HouseholdExceptionHandler.class);

  /**
   * Missing and non-member households share one generic 404. The body never contains the requested
   * ID or name.
   */
  @ExceptionHandler(HouseholdNotFoundException.class)
  public ResponseEntity<ApiError> notFound(HouseholdNotFoundException failure) {
    String correlationId = CorrelationIds.newId();
    log.warn(
        "event=household.request_failed code={} correlationId={}",
        ErrorCodes.HOUSEHOLD_NOT_FOUND,
        correlationId);
    return ResponseEntity.status(HttpStatus.NOT_FOUND)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(
            ApiError.of(ErrorCodes.HOUSEHOLD_NOT_FOUND, "Household was not found.", correlationId));
  }

  /** Malformed path UUIDs (for example {@code /api/households/not-a-uuid}) are a safe 400. */
  @ExceptionHandler(MethodArgumentTypeMismatchException.class)
  public ResponseEntity<ApiError> malformedId(MethodArgumentTypeMismatchException failure) {
    String correlationId = CorrelationIds.newId();
    log.warn(
        "event=household.request_failed code={} correlationId={} cause={}",
        ErrorCodes.VALIDATION_FAILED,
        correlationId,
        failure.getClass().getSimpleName());
    return ResponseEntity.status(HttpStatus.BAD_REQUEST)
        .cacheControl(CacheControl.noStore())
        .contentType(MediaType.APPLICATION_JSON)
        .body(
            ApiError.of(
                ErrorCodes.VALIDATION_FAILED, "Check the supplied details.", correlationId));
  }
}
