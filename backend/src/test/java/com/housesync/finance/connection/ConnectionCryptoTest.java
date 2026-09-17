package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.crypto.ConnectionCrypto.CredentialCryptoException;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class ConnectionCryptoTest {

  private static final String KEY_ONE = base64(1);
  private static final String KEY_TWO = base64(2);

  @Test
  void roundTripBindsScopeEnvironmentAndKeyId() {
    ConnectionCrypto crypto = crypto("test-key-1:" + KEY_ONE);
    String envelope = crypto.encrypt("fake-access-abc", "connection/conn-1/credential");

    assertThat(envelope).startsWith("test-key-1:");
    assertThat(crypto.decrypt(envelope, "connection/conn-1/credential"))
        .isEqualTo("fake-access-abc");
    assertThat(crypto.activeKeyId()).isEqualTo("test-key-1");
  }

  @Test
  void ciphertextDoesNotMoveAcrossScopesConnectionsOrEnvironments() {
    ConnectionCrypto crypto = crypto("test-key-1:" + KEY_ONE);
    String envelope = crypto.encrypt("secret", "attempt/attempt-1/public-token");

    assertThatThrownBy(() -> crypto.decrypt(envelope, "attempt/attempt-2/public-token"))
        .isInstanceOf(CredentialCryptoException.class);
    assertThatThrownBy(() -> crypto.decrypt(envelope, "connection/conn-1/credential"))
        .isInstanceOf(CredentialCryptoException.class);

    ConnectedFinanceProperties production = properties("test-key-1:" + KEY_ONE);
    production.setEnvironment("production");
    assertThatThrownBy(
            () ->
                new ConnectionCrypto(production)
                    .decrypt(envelope, "attempt/attempt-1/public-token"))
        .isInstanceOf(CredentialCryptoException.class);
  }

  @Test
  void tamperedEnvelopeAndUnknownKeyFailWithoutDetail() {
    ConnectionCrypto crypto = crypto("test-key-1:" + KEY_ONE);
    String envelope = crypto.encrypt("secret", "scope");

    assertThatThrownBy(() -> crypto.decrypt(envelope + "A", "scope"))
        .isInstanceOf(CredentialCryptoException.class)
        .hasNoSuppressedExceptions();
    assertThatThrownBy(() -> crypto.decrypt("no-separator", "scope"))
        .isInstanceOf(CredentialCryptoException.class);
    assertThatThrownBy(() -> crypto.decrypt("retired:" + envelope.split(":", 2)[1], "scope"))
        .isInstanceOf(CredentialCryptoException.class);
  }

  @Test
  void rotationKeepsOlderCiphertextDecryptable() {
    ConnectionCrypto before = crypto("test-key-1:" + KEY_ONE);
    String envelope = before.encrypt("secret", "scope");

    ConnectionCrypto after = crypto("test-key-2:" + KEY_TWO + ",test-key-1:" + KEY_ONE);
    assertThat(after.activeKeyId()).isEqualTo("test-key-2");
    assertThat(after.decrypt(envelope, "scope")).isEqualTo("secret");
    String rotated = after.encrypt("secret", "scope");
    assertThat(rotated).startsWith("test-key-2:");
    assertThat(after.decrypt(rotated, "scope")).isEqualTo("secret");
    // An instance holding only the retired key cannot read new-key ciphertext.
    assertThatThrownBy(() -> before.decrypt(rotated, "scope"))
        .isInstanceOf(CredentialCryptoException.class);
  }

  @Test
  void noncesDifferAndDigestsAreStable() {
    ConnectionCrypto crypto = crypto("test-key-1:" + KEY_ONE);
    assertThat(crypto.encrypt("same", "scope")).isNotEqualTo(crypto.encrypt("same", "scope"));
    assertThat(crypto.hmacHex("token")).isEqualTo(crypto.hmacHex("token"));
    assertThat(crypto.hmacHex("token-a")).isNotEqualTo(crypto.hmacHex("token-b"));
    assertThat(ConnectionCrypto.sha256Hex("abc"))
        .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  }

  @Test
  void malformedRuntimeKeysFailClosedWithoutRawLeaks() {
    ConnectedFinanceProperties properties = properties("test-key-1:" + KEY_ONE);
    ConnectionCrypto crypto = new ConnectionCrypto(properties);
    assertThat(crypto.encrypt("secret", "scope")).startsWith("test-key-1:");

    properties.setEncryptionKeys("no-colon-here");
    assertThatThrownBy(() -> crypto.encrypt("secret", "scope"))
        .isInstanceOf(CredentialCryptoException.class);
    assertThatThrownBy(() -> crypto.decrypt("test-key-1:AAAA", "scope"))
        .isInstanceOf(CredentialCryptoException.class);
    assertThatThrownBy(() -> crypto.hmacHex("token")).isInstanceOf(CredentialCryptoException.class);
    assertThatThrownBy(crypto::activeKeyId).isInstanceOf(CredentialCryptoException.class);

    properties.setEncryptionKeys("bad-id!!:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    assertThatThrownBy(() -> crypto.encrypt("secret", "scope"))
        .isInstanceOf(CredentialCryptoException.class);
  }

  @Test
  void disabledFeatureRejectsCryptoUse() {
    ConnectedFinanceProperties disabled = properties("");
    disabled.setEnabled(false);
    ConnectionCrypto crypto = new ConnectionCrypto(disabled);
    assertThatThrownBy(() -> crypto.encrypt("secret", "scope"))
        .isInstanceOf(CredentialCryptoException.class);
    assertThatThrownBy(() -> crypto.decrypt("x:y", "scope"))
        .isInstanceOf(CredentialCryptoException.class);
  }

  private static ConnectionCrypto crypto(String keys) {
    ConnectedFinanceProperties properties = properties(keys);
    return new ConnectionCrypto(properties);
  }

  private static ConnectedFinanceProperties properties(String keys) {
    ConnectedFinanceProperties properties = new ConnectedFinanceProperties();
    properties.setEnabled(true);
    properties.setEncryptionKeys(keys);
    return properties;
  }

  private static String base64(int seed) {
    byte[] raw = new byte[32];
    for (int i = 0; i < raw.length; i++) {
      raw[i] = (byte) (seed * 31 + i);
    }
    return Base64.getEncoder().encodeToString(raw);
  }
}
