package com.housesync.identity.web;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/**
 * Safe JSON error body. Never echoes submitted fields, SQL, stack traces, or credentials; carries
 * an opaque correlation id for server-side diagnosis.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiError(
    String code,
    String message,
    String correlationId,
    @JsonProperty("fieldErrors") Map<String, String> fieldErrors) {

  public static ApiError of(String code, String message, String correlationId) {
    return new ApiError(code, message, correlationId, null);
  }

  public static ApiError of(
      String code, String message, String correlationId, Map<String, String> fieldErrors) {
    return new ApiError(code, message, correlationId, fieldErrors);
  }
}
