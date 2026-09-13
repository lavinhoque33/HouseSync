package com.housesync.household.invitation.application;

import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Validated capability credential for preview and acceptance. Carries the parsed invitation ID and
 * the strictly decoded 32 raw secret bytes. Validation failures use only the safe {@code
 * invitationId}/{@code secret} field keys and never echo submitted values.
 */
public record CapabilityCredential(UUID invitationId, byte[] rawSecret) {

  public CapabilityCredential {
    rawSecret = rawSecret.clone();
  }

  @Override
  public byte[] rawSecret() {
    return rawSecret.clone();
  }

  /**
   * Parses and strictly validates a raw capability request. Missing values, malformed UUIDs, and
   * non-canonical secrets are validation failures, not capability misses.
   *
   * @throws ValidationFailedException with safe field errors when the shape is invalid
   */
  public static CapabilityCredential parse(String invitationId, String secret) {
    Map<String, String> fieldErrors = new LinkedHashMap<>();
    UUID id = null;
    if (invitationId == null) {
      fieldErrors.put("invitationId", "Enter a valid invitation identifier.");
    } else {
      try {
        id = UUID.fromString(invitationId);
      } catch (IllegalArgumentException failure) {
        fieldErrors.put("invitationId", "Enter a valid invitation identifier.");
      }
    }
    byte[] raw = null;
    if (secret == null) {
      fieldErrors.put("secret", "Enter the invitation secret.");
    } else {
      try {
        raw = InvitationSecrets.decodeStrict(secret);
      } catch (IllegalArgumentException failure) {
        fieldErrors.put("secret", "Enter the invitation secret.");
      }
    }
    if (!fieldErrors.isEmpty()) {
      throw new ValidationFailedException(fieldErrors);
    }
    return new CapabilityCredential(id, raw);
  }
}
