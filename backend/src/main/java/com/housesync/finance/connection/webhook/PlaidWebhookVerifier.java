package com.housesync.finance.connection.webhook;

import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapterException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Plaid webhook verification over the exact original bytes (connected-finance contract §5).
 *
 * <p>Only ES256 over an EC P-256 JWK is accepted. The key id travels in the signed JWT header but
 * the key itself is always fetched through the adapter's fixed allowlisted host; header key URLs
 * ({@code jku}/{@code x5u}) are never trusted. Keys are cached for at most one hour, expired keys
 * are rejected, and unknown-key fetches are bounded per key id and per process so a forged header
 * cannot turn the endpoint into an amplifier. The body hash comparison is constant time over the
 * SHA-256 digest of the original bytes, and {@code iat} must be no older than five minutes and no
 * more than thirty seconds in the future.
 *
 * <p>Invalid signature, body, or age is a typed 401 rejection. Temporary verification-key
 * infrastructure failure is a typed 503 with no admission, never a verification success.
 */
@Component
public class PlaidWebhookVerifier {

  private static final Duration MAX_KEY_CACHE = Duration.ofHours(1);
  private static final Duration IAT_MAX_AGE = Duration.ofMinutes(5);
  private static final Duration IAT_MAX_FUTURE = Duration.ofSeconds(30);
  private static final Duration UNKNOWN_KEY_SUPPRESSION = Duration.ofSeconds(30);
  private static final int UNKNOWN_KEY_FETCH_LIMIT = 20;
  private static final Duration UNKNOWN_KEY_FETCH_WINDOW = Duration.ofMinutes(1);

  private final PlaidAdapter adapter;
  private final ObjectMapper mapper;
  private final Clock clock;
  private final Map<String, CachedKey> keyCache = new ConcurrentHashMap<>();
  private final Map<String, Instant> lastFetchAttempt = new ConcurrentHashMap<>();
  private final com.housesync.identity.ratelimit.SlidingWindowRateLimiter fetchLimiter;

  public PlaidWebhookVerifier(PlaidAdapter adapter, ObjectMapper mapper, Clock clock) {
    this.adapter = adapter;
    this.mapper = mapper;
    this.clock = clock;
    this.fetchLimiter = new com.housesync.identity.ratelimit.SlidingWindowRateLimiter(clock, 2048);
  }

  public VerifiedEvent verify(byte[] originalBody, String signatureHeader) {
    if (originalBody == null || originalBody.length == 0 || signatureHeader == null) {
      throw new WebhookVerificationException();
    }
    String[] segments = signatureHeader.split("\\.", -1);
    if (segments.length != 3 || segments[0].isEmpty() || segments[1].isEmpty()) {
      throw new WebhookVerificationException();
    }
    JsonNode header = decodeJson(segments[0]);
    String algorithm = header.path("alg").asText("");
    String keyId = header.path("kid").asText("");
    if (!"ES256".equals(algorithm) || keyId.isBlank()) {
      throw new WebhookVerificationException();
    }
    JsonNode payload = decodeJson(segments[1]);
    requireFreshIssuedAt(payload);
    requireBodyHash(originalBody, payload);
    byte[] signature;
    try {
      signature = Base64.getUrlDecoder().decode(segments[2]);
    } catch (IllegalArgumentException rejected) {
      throw new WebhookVerificationException();
    }
    PublicKey publicKey = resolveKey(keyId);
    // JOSE ES256 signatures are raw r||s; the JDK's P1363 format verifies exactly that encoding.
    if (signature.length != 64) {
      throw new WebhookVerificationException();
    }
    try {
      Signature verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
      verifier.initVerify(publicKey);
      verifier.update((segments[0] + "." + segments[1]).getBytes(StandardCharsets.US_ASCII));
      if (!verifier.verify(signature)) {
        throw new WebhookVerificationException();
      }
    } catch (WebhookVerificationException rejected) {
      throw rejected;
    } catch (java.security.GeneralSecurityException rejected) {
      throw new WebhookVerificationException();
    }
    String webhookType = payload.path("webhook_type").asText("");
    String webhookCode = payload.path("webhook_code").asText("");
    // The signed body is the routing authority: the JWT binds the exact bytes, and routing facts
    // (type/code/Item/error) come from the verified body rather than a header-side claim.
    JsonNode event = decodeJsonBytes(originalBody);
    webhookType = event.path("webhook_type").asText(webhookType);
    webhookCode = event.path("webhook_code").asText(webhookCode);
    if (webhookType.isBlank() || webhookCode.isBlank()) {
      throw new WebhookVerificationException();
    }
    String itemId = event.path("item_id").asText("");
    String errorCode = event.path("error").path("error_code").asText("");
    return new VerifiedEvent(
        webhookType,
        webhookCode,
        itemId.isBlank() ? null : itemId,
        errorCode.isBlank() ? null : errorCode);
  }

  private JsonNode decodeJsonBytes(byte[] body) {
    try {
      return mapper.readTree(body);
    } catch (RuntimeException rejected) {
      throw new WebhookVerificationException();
    }
  }

  private JsonNode decodeJson(String segment) {
    try {
      return mapper.readTree(Base64.getUrlDecoder().decode(segment));
    } catch (RuntimeException rejected) {
      throw new WebhookVerificationException();
    }
  }

  private void requireFreshIssuedAt(JsonNode payload) {
    JsonNode iatNode = payload.path("iat");
    if (!iatNode.isNumber()) {
      throw new WebhookVerificationException();
    }
    Instant issuedAt;
    try {
      issuedAt = Instant.ofEpochSecond(iatNode.asLong());
    } catch (RuntimeException rejected) {
      throw new WebhookVerificationException();
    }
    Instant now = Instant.now(clock);
    if (issuedAt.isBefore(now.minus(IAT_MAX_AGE)) || issuedAt.isAfter(now.plus(IAT_MAX_FUTURE))) {
      throw new WebhookVerificationException();
    }
  }

  private void requireBodyHash(byte[] originalBody, JsonNode payload) {
    JsonNode hashNode = payload.path("request_body_sha256");
    if (!hashNode.isTextual()) {
      throw new WebhookVerificationException();
    }
    String claimed = hashNode.asText().toLowerCase(Locale.ROOT);
    if (claimed.length() != 64) {
      throw new WebhookVerificationException();
    }
    byte[] expected;
    try {
      expected = HexFormat.of().parseHex(claimed);
    } catch (IllegalArgumentException rejected) {
      throw new WebhookVerificationException();
    }
    byte[] actual;
    try {
      actual = MessageDigest.getInstance("SHA-256").digest(originalBody);
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is required by the Java platform", impossible);
    }
    // Constant-time over the digest of the original bytes.
    if (!MessageDigest.isEqual(expected, actual)) {
      throw new WebhookVerificationException();
    }
  }

  private PublicKey resolveKey(String keyId) {
    Instant now = Instant.now(clock);
    CachedKey cached = keyCache.get(keyId);
    if (cached != null) {
      if (cached.expiresAt() != null && !cached.expiresAt().isAfter(now)) {
        keyCache.remove(keyId, cached);
        throw new WebhookVerificationException();
      }
      if (cached.cacheUntil().isAfter(now)) {
        return cached.key();
      }
      keyCache.remove(keyId, cached);
    }
    Instant lastAttempt = lastFetchAttempt.get(keyId);
    if (lastAttempt != null && lastAttempt.plus(UNKNOWN_KEY_SUPPRESSION).isAfter(now)) {
      // A forged kid must not become an unbounded fetch loop.
      throw new WebhookVerificationException();
    }
    if (fetchLimiter
        .tryAcquire("plaid-webhook-key-fetch", UNKNOWN_KEY_FETCH_LIMIT, UNKNOWN_KEY_FETCH_WINDOW)
        .isPresent()) {
      throw new WebhookUnavailableException();
    }
    if (lastFetchAttempt.size() > 4096) {
      // Bound the suppression map against a stream of forged key ids.
      lastFetchAttempt.clear();
    }
    lastFetchAttempt.put(keyId, now);
    PlaidAdapter.VerificationKey fetched;
    try {
      fetched = adapter.fetchVerificationKey(keyId);
    } catch (PlaidAdapterException failed) {
      switch (failed.getErrorClass()) {
        case TRANSIENT, RATE_LIMITED, NOT_READY -> throw new WebhookUnavailableException();
        default -> throw new WebhookVerificationException();
      }
    } catch (RuntimeException unexpected) {
      throw new WebhookUnavailableException();
    }
    if (fetched == null || fetched.publicKey() == null) {
      throw new WebhookVerificationException();
    }
    Instant expiresAt = fetched.expiresAt();
    if (expiresAt != null && !expiresAt.isAfter(now)) {
      throw new WebhookVerificationException();
    }
    Instant cacheUntil = now.plus(MAX_KEY_CACHE);
    if (expiresAt != null && expiresAt.isBefore(cacheUntil)) {
      cacheUntil = expiresAt;
    }
    keyCache.put(keyId, new CachedKey(fetched.publicKey(), expiresAt, cacheUntil));
    return fetched.publicKey();
  }

  /** Verified event class: the minimal routing facts, never a payload copy. */
  public record VerifiedEvent(
      String webhookType, String webhookCode, String remoteItemId, String errorCode) {}

  private record CachedKey(PublicKey key, Instant expiresAt, Instant cacheUntil) {}

  /** Invalid signature, body hash, or age: generic 401, no detail. */
  public static final class WebhookVerificationException extends RuntimeException {}

  /** Verification infrastructure or database outage: 503 with no admission. */
  public static final class WebhookUnavailableException extends RuntimeException {}
}
