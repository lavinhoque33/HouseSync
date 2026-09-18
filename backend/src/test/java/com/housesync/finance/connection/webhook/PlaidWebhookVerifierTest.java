package com.housesync.finance.connection.webhook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.plaid.ProviderErrorClass;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.VerifiedEvent;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.WebhookUnavailableException;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.WebhookVerificationException;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class PlaidWebhookVerifierTest {

  private static final Instant NOW = Instant.parse("2026-09-18T12:00:00Z");
  private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);

  private final FakePlaidAdapter adapter = new FakePlaidAdapter(CLOCK);
  private final PlaidWebhookVerifier verifier =
      new PlaidWebhookVerifier(adapter, new ObjectMapper(), CLOCK);

  private static KeyPair keyPair() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    return generator.generateKeyPair();
  }

  private static String sign(KeyPair pair, String alg, String kid, byte[] body, Instant iat)
      throws Exception {
    String header = "{\"alg\":\"" + alg + "\",\"kid\":\"" + kid + "\"}";
    String payload =
        "{\"iat\":"
            + iat.getEpochSecond()
            + ",\"request_body_sha256\":\""
            + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body))
            + "\",\"webhook_type\":\"TRANSACTIONS\",\"webhook_code\":\"SYNC_UPDATES_AVAILABLE\","
            + "\"item_id\":\"item-1\"}";
    String signingInput =
        base64Url(header.getBytes(StandardCharsets.US_ASCII))
            + "."
            + base64Url(payload.getBytes(StandardCharsets.UTF_8));
    Signature signer = Signature.getInstance("SHA256withECDSAinP1363Format");
    signer.initSign(pair.getPrivate());
    signer.update(signingInput.getBytes(StandardCharsets.US_ASCII));
    return signingInput + "." + base64Url(signer.sign());
  }

  private static String base64Url(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  private static byte[] body() {
    return ("{\"webhook_type\":\"TRANSACTIONS\","
            + "\"webhook_code\":\"SYNC_UPDATES_AVAILABLE\",\"item_id\":\"item-1\"}")
        .getBytes(StandardCharsets.UTF_8);
  }

  private void register(KeyPair pair, String kid, Instant expiresAt) {
    adapter.registerVerificationKey(
        new PlaidAdapter.VerificationKey(kid, pair.getPublic(), expiresAt));
  }

  @Test
  void validSignatureVerifiesAndCachesTheKey() throws Exception {
    KeyPair pair = keyPair();
    String kid = "kid-" + UUID.randomUUID();
    register(pair, kid, null);
    String jwt = sign(pair, "ES256", kid, body(), NOW);

    VerifiedEvent event = verifier.verify(body(), jwt);

    assertThat(event.webhookType()).isEqualTo("TRANSACTIONS");
    assertThat(event.webhookCode()).isEqualTo("SYNC_UPDATES_AVAILABLE");
    assertThat(event.remoteItemId()).isEqualTo("item-1");
    assertThat(adapter.keyFetchCount(kid)).isEqualTo(1);

    // Cached key survives a provider outage within the cache TTL.
    adapter.clearVerificationKeys();
    adapter.setKeyFetchFailure(ProviderErrorClass.TRANSIENT);
    VerifiedEvent cached = verifier.verify(body(), jwt);
    assertThat(cached.remoteItemId()).isEqualTo("item-1");
    assertThat(adapter.keyFetchCount(kid)).isEqualTo(1);
  }

  @Test
  void wrongAlgorithmIsRejected() throws Exception {
    KeyPair pair = keyPair();
    String kid = "kid-" + UUID.randomUUID();
    register(pair, kid, null);
    assertThatThrownBy(() -> verifier.verify(body(), sign(pair, "HS256", kid, body(), NOW)))
        .isInstanceOf(WebhookVerificationException.class);
  }

  @Test
  void unknownKeyIsRejectedAndSuppressed() throws Exception {
    KeyPair pair = keyPair();
    String kid = "kid-" + UUID.randomUUID();
    String jwt = sign(pair, "ES256", kid, body(), NOW);
    assertThatThrownBy(() -> verifier.verify(body(), jwt))
        .isInstanceOf(WebhookVerificationException.class);
    assertThat(adapter.keyFetchCount(kid)).isEqualTo(1);
    // A forged kid cannot trigger repeated fetches inside the suppression window.
    assertThatThrownBy(() -> verifier.verify(body(), jwt))
        .isInstanceOf(WebhookVerificationException.class);
    assertThat(adapter.keyFetchCount(kid)).isEqualTo(1);
  }

  @Test
  void wrongSignatureIsRejected() throws Exception {
    KeyPair signingPair = keyPair();
    KeyPair otherPair = keyPair();
    String kid = "kid-" + UUID.randomUUID();
    register(otherPair, kid, null);
    assertThatThrownBy(() -> verifier.verify(body(), sign(signingPair, "ES256", kid, body(), NOW)))
        .isInstanceOf(WebhookVerificationException.class);
  }

  @Test
  void staleAndFutureIssuedAtAreRejected() throws Exception {
    KeyPair pair = keyPair();
    String staleKid = "kid-" + UUID.randomUUID();
    register(pair, staleKid, null);
    assertThatThrownBy(
            () ->
                verifier.verify(
                    body(),
                    sign(pair, "ES256", staleKid, body(), NOW.minus(Duration.ofMinutes(6)))))
        .isInstanceOf(WebhookVerificationException.class);

    KeyPair futurePair = keyPair();
    String futureKid = "kid-" + UUID.randomUUID();
    register(futurePair, futureKid, null);
    assertThatThrownBy(
            () ->
                verifier.verify(
                    body(),
                    sign(futurePair, "ES256", futureKid, body(), NOW.plus(Duration.ofSeconds(60)))))
        .isInstanceOf(WebhookVerificationException.class);
  }

  @Test
  void bodyHashMismatchIsRejected() throws Exception {
    KeyPair pair = keyPair();
    String kid = "kid-" + UUID.randomUUID();
    register(pair, kid, null);
    String jwt = sign(pair, "ES256", kid, body(), NOW);
    byte[] tampered = "{\"webhook_type\":\"ITEM\"}".getBytes(StandardCharsets.UTF_8);
    assertThatThrownBy(() -> verifier.verify(tampered, jwt))
        .isInstanceOf(WebhookVerificationException.class);
  }

  @Test
  void expiredKeyIsRejected() throws Exception {
    KeyPair pair = keyPair();
    String kid = "kid-" + UUID.randomUUID();
    register(pair, kid, NOW.minusSeconds(1));
    assertThatThrownBy(() -> verifier.verify(body(), sign(pair, "ES256", kid, body(), NOW)))
        .isInstanceOf(WebhookVerificationException.class);
  }

  @Test
  void keyInfrastructureOutageIsUnavailableNotVerified() throws Exception {
    KeyPair pair = keyPair();
    String kid = "kid-" + UUID.randomUUID();
    adapter.setKeyFetchFailure(ProviderErrorClass.TRANSIENT);
    assertThatThrownBy(() -> verifier.verify(body(), sign(pair, "ES256", kid, body(), NOW)))
        .isInstanceOf(WebhookUnavailableException.class);
  }

  @Test
  void malformedHeadersAreRejected() throws Exception {
    assertThatThrownBy(() -> verifier.verify(body(), null))
        .isInstanceOf(WebhookVerificationException.class);
    assertThatThrownBy(() -> verifier.verify(body(), "not-a-jwt"))
        .isInstanceOf(WebhookVerificationException.class);
    assertThatThrownBy(() -> verifier.verify(body(), "a.b"))
        .isInstanceOf(WebhookVerificationException.class);
    assertThatThrownBy(() -> verifier.verify(new byte[0], "a.b.c"))
        .isInstanceOf(WebhookVerificationException.class);
  }
}
