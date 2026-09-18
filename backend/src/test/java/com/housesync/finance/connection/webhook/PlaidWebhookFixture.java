package com.housesync.finance.connection.webhook;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;

/** Shared signed-webhook fixture for integration and unit tests; never a production helper. */
public final class PlaidWebhookFixture {

  private PlaidWebhookFixture() {}

  public static KeyPair keyPair() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    return generator.generateKeyPair();
  }

  public static byte[] body(
      String webhookType, String webhookCode, String itemId, String errorCode) {
    StringBuilder json = new StringBuilder("{\"webhook_type\":\"").append(webhookType);
    json.append("\",\"webhook_code\":\"").append(webhookCode).append('"');
    if (itemId != null) {
      json.append(",\"item_id\":\"").append(itemId).append('"');
    }
    if (errorCode != null) {
      json.append(",\"error\":{\"error_code\":\"").append(errorCode).append("\"}");
    }
    json.append('}');
    return json.toString().getBytes(StandardCharsets.UTF_8);
  }

  public static String signedJwt(KeyPair pair, String kid, byte[] body, Instant issuedAt)
      throws Exception {
    return signedJwt(pair, kid, "ES256", body, issuedAt);
  }

  public static String signedJwt(
      KeyPair pair, String kid, String algorithm, byte[] body, Instant issuedAt) throws Exception {
    String header = "{\"alg\":\"" + algorithm + "\",\"kid\":\"" + kid + "\"}";
    String payload =
        "{\"iat\":"
            + issuedAt.getEpochSecond()
            + ",\"request_body_sha256\":\""
            + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body))
            + "\",\"webhook_type\":\"TRANSACTIONS\",\"webhook_code\":\"SYNC_UPDATES_AVAILABLE\","
            + "\"item_id\":\"item-from-jwt\"}";
    String signingInput =
        base64Url(header.getBytes(StandardCharsets.US_ASCII))
            + "."
            + base64Url(payload.getBytes(StandardCharsets.UTF_8));
    Signature signer = Signature.getInstance("SHA256withECDSAinP1363Format");
    signer.initSign(pair.getPrivate());
    signer.update(signingInput.getBytes(StandardCharsets.US_ASCII));
    return signingInput + "." + base64Url(signer.sign());
  }

  public static String base64Url(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }
}
