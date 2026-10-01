package com.housesync.finance.connection.crypto;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;

/**
 * Authenticated encryption for provider credentials and transient tokens.
 *
 * <p>AES-256-GCM with a 96-bit random nonce per encryption. The envelope is {@code
 * keyId:base64(nonce || ciphertext||tag)} so decryption resolves the exact key version and rotation
 * never breaks previously stored values. Ciphertext is bound through GCM additional authenticated
 * data to {@code HousesyncConnectedFinance/v1/<environment>/<scope>}, where the scope names the
 * owning connection or attempt plus the token purpose; moving ciphertext across connections,
 * attempts, or environments fails authentication.
 *
 * <p>Keys are parsed once at startup when the feature is enabled (fail-closed); when disabled the
 * bean exists but every operation rejects, keeping manual-finance paths usable without key
 * material.
 */
@Component
public class ConnectionCrypto {

  private static final int GCM_TAG_BITS = 128;
  private static final int NONCE_BYTES = 12;

  private final ConnectedFinanceProperties properties;
  private final SecureRandom random = new SecureRandom();
  private volatile Map<String, byte[]> keysById;
  private volatile String parsedSource;

  public ConnectionCrypto(ConnectedFinanceProperties properties) {
    this.properties = properties;
  }

  /** Active (first) key id used for new ciphertext; rotation keeps older ids decryptable. */
  public String activeKeyId() {
    Map<String, byte[]> keys = keys();
    return keys.keySet().iterator().next();
  }

  /** Encrypts with the active (first) key; the caller supplies the binding scope. */
  public String encrypt(String plaintext, String scope) {
    Map<String, byte[]> keys = keys();
    String activeId = keys.keySet().iterator().next();
    byte[] nonce = new byte[NONCE_BYTES];
    random.nextBytes(nonce);
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(
          Cipher.ENCRYPT_MODE,
          new SecretKeySpec(keys.get(activeId), "AES"),
          new GCMParameterSpec(GCM_TAG_BITS, nonce));
      cipher.updateAAD(aad(scope));
      byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
      byte[] envelope =
          ByteBuffer.allocate(nonce.length + ciphertext.length).put(nonce).put(ciphertext).array();
      return activeId + ":" + Base64.getEncoder().encodeToString(envelope);
    } catch (GeneralSecurityException failed) {
      throw new IllegalStateException("credential encryption failed", failed);
    }
  }

  /** Decrypts an envelope produced by {@link #encrypt}; any tampering or scope move fails. */
  public String decrypt(String envelope, String scope) {
    Map<String, byte[]> keys = keys();
    int separator = envelope == null ? -1 : envelope.indexOf(':');
    if (separator <= 0) {
      throw new CredentialCryptoException();
    }
    byte[] key = keys.get(envelope.substring(0, separator));
    if (key == null) {
      throw new CredentialCryptoException();
    }
    byte[] raw;
    try {
      raw = Base64.getDecoder().decode(envelope.substring(separator + 1));
    } catch (IllegalArgumentException rejected) {
      throw new CredentialCryptoException();
    }
    if (raw.length <= NONCE_BYTES) {
      throw new CredentialCryptoException();
    }
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(
          Cipher.DECRYPT_MODE,
          new SecretKeySpec(key, "AES"),
          new GCMParameterSpec(GCM_TAG_BITS, raw, 0, NONCE_BYTES));
      cipher.updateAAD(aad(scope));
      return new String(
          cipher.doFinal(raw, NONCE_BYTES, raw.length - NONCE_BYTES), StandardCharsets.UTF_8);
    } catch (GeneralSecurityException failed) {
      throw new CredentialCryptoException();
    }
  }

  /**
   * Keyed HMAC (active key bytes) over a short-lived public token for idempotency fingerprints. The
   * raw token never enters a fingerprint, error, or log.
   */
  public String hmacHex(String value) {
    return hmacHex(activeKeyId(), value);
  }

  /**
   * HMAC under an explicit key id. Completion fingerprints reserve the active id and replay with
   * the stored id, so encryption-key rotation never turns a legitimate retry into a conflict.
   */
  public String hmacHex(String keyId, String value) {
    byte[] key = keys().get(keyId);
    if (key == null) {
      throw new CredentialCryptoException();
    }
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(key, "HmacSHA256"));
      return HexFormat.of().formatHex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
    } catch (GeneralSecurityException failed) {
      throw new IllegalStateException("token fingerprint failed", failed);
    }
  }

  /** Opaque hex digest for provider identities; provider IDs stay out of storage and logs. */
  public static String sha256Hex(String value) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is required by the Java platform", impossible);
    }
  }

  private byte[] aad(String scope) {
    String environment =
        properties.getEnvironment() == null ? "sandbox" : properties.getEnvironment();
    String bound =
        "HousesyncConnectedFinance/v1/" + environment.strip().toLowerCase() + "/" + scope;
    return bound.getBytes(StandardCharsets.UTF_8);
  }

  private Map<String, byte[]> keys() {
    String source = properties.getEncryptionKeys();
    Map<String, byte[]> cached = keysById;
    if (cached != null && java.util.Objects.equals(parsedSource, source)) {
      return cached;
    }
    synchronized (this) {
      if (keysById != null && java.util.Objects.equals(parsedSource, source)) {
        return keysById;
      }
      // Rotation without restart is supported: a changed key set reparses (older ids stay
      // decryptable while configured). Malformed runtime changes fail closed with the safe
      // exception, never a raw parsing error.
      Map<String, byte[]> parsed = parseKeys(source);
      keysById = parsed;
      parsedSource = source;
      return parsed;
    }
  }

  private Map<String, byte[]> parseKeys(String source) {
    if (!properties.isEnabled() || source == null) {
      throw new CredentialCryptoException();
    }
    try {
      List<String> ids = new ArrayList<>();
      Map<String, byte[]> parsed = new LinkedHashMap<>();
      for (String entry : source.split(",")) {
        String trimmed = entry.strip();
        if (trimmed.isEmpty()) {
          continue;
        }
        int separator = trimmed.indexOf(':');
        if (separator <= 0) {
          throw new CredentialCryptoException();
        }
        String keyId = trimmed.substring(0, separator);
        if (!keyId.matches("[A-Za-z0-9_\\-]{1,64}")) {
          throw new CredentialCryptoException();
        }
        byte[] raw = Base64.getDecoder().decode(trimmed.substring(separator + 1));
        if (raw.length != 32) {
          throw new CredentialCryptoException();
        }
        if (!parsed.containsKey(keyId)) {
          ids.add(keyId);
        }
        parsed.put(keyId, raw);
      }
      if (ids.isEmpty()) {
        throw new CredentialCryptoException();
      }
      Map<String, byte[]> ordered = new LinkedHashMap<>();
      for (String id : ids) {
        ordered.put(id, parsed.get(id));
      }
      return ordered;
    } catch (IllegalArgumentException rejected) {
      throw new CredentialCryptoException();
    }
  }

  /** Safe authentication/decryption failure; never carries key or plaintext detail. */
  public static final class CredentialCryptoException extends RuntimeException {}
}
