package com.housesync.household.invitation.application;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * Capability secret codec. Secrets are exactly 43 unpadded base64url characters carrying 32
 * cryptographically random bytes; PostgreSQL stores only {@code SHA-256(raw bytes)}. Decoding is
 * strict: padded and alternate encodings are rejected, and the decoded bytes must re-encode to the
 * identical canonical string so non-canonical trailing bits cannot pass validation.
 */
public final class InvitationSecrets {

  public static final int SECRET_BYTE_LENGTH = 32;
  public static final int SECRET_TEXT_LENGTH = 43;
  public static final Pattern SECRET_PATTERN = Pattern.compile("^[A-Za-z0-9_-]{43}$");

  private static final SecureRandom RANDOM = new SecureRandom();
  private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
  private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

  private InvitationSecrets() {}

  /** Generates one fresh 43-character unpadded base64url secret from 32 secure random bytes. */
  public static String generate() {
    byte[] raw = new byte[SECRET_BYTE_LENGTH];
    RANDOM.nextBytes(raw);
    return ENCODER.encodeToString(raw);
  }

  /**
   * Strictly decodes a candidate secret to its 32 raw bytes. Rejects nulls, shape violations,
   * undecodable input, wrong byte lengths, and non-canonical encodings.
   *
   * @throws IllegalArgumentException when the candidate is not a strict capability secret
   */
  public static byte[] decodeStrict(String secret) {
    if (secret == null || !SECRET_PATTERN.matcher(secret).matches()) {
      throw new IllegalArgumentException("Invitation secret has an invalid shape.");
    }
    byte[] raw;
    try {
      raw = DECODER.decode(secret);
    } catch (IllegalArgumentException failure) {
      throw new IllegalArgumentException("Invitation secret is not decodable.", failure);
    }
    if (raw.length != SECRET_BYTE_LENGTH || !ENCODER.encodeToString(raw).equals(secret)) {
      throw new IllegalArgumentException("Invitation secret is not a canonical 32-byte value.");
    }
    return raw;
  }

  /** SHA-256 over the raw decoded secret bytes; the only value ever persisted. */
  public static byte[] sha256(byte[] raw) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(raw);
    } catch (NoSuchAlgorithmException failure) {
      throw new IllegalStateException("SHA-256 is unavailable.", failure);
    }
  }

  /** Constant-time digest comparison; never compares raw secrets with {@code equals}. */
  public static boolean digestEquals(byte[] first, byte[] second) {
    return MessageDigest.isEqual(first, second);
  }
}
