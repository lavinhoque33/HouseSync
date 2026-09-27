package com.housesync.identity.web;

/**
 * Transport DTOs for registration and login. Unknown JSON fields are rejected by the global Jackson
 * setting ({@code fail-on-unknown-properties}); nullability is validated in the use case so missing
 * fields produce safe 400 errors.
 */
public final class AuthRequests {

  private AuthRequests() {}

  public record RegisterRequest(String email, String password, String enrollmentCode) {}

  public record LoginRequest(String email, String password) {}

  public record RecoveryRequest(String email, String recoveryCode, String newPassword) {}

  public record PasswordRequest(String currentPassword, String newPassword) {}
}
