package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class ConnectedFinancePropertiesTest {

  private static final String KEYS = "test-key-1:" + base64();

  @Test
  void disabledStartsWithoutSecretsOrKeys() {
    ConnectedFinanceProperties properties = new ConnectedFinanceProperties();
    assertThatCode(properties::validateFailClosed).doesNotThrowAnyException();
    assertThat(properties.resolvedBaseUrl()).isEqualTo("https://sandbox.plaid.com");
  }

  @Test
  void enabledPlaidRequiresSecretsAndKeys() {
    ConnectedFinanceProperties missing = enabled("plaid", false);
    assertThatThrownBy(missing::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties noKeys = enabled("plaid", false);
    noKeys.setClientId("client");
    noKeys.setSecret("secret");
    assertThatThrownBy(noKeys::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties ready = enabled("plaid", false);
    ready.setClientId("client");
    ready.setSecret("secret");
    ready.setEncryptionKeys(KEYS);
    assertThatCode(ready::validateFailClosed).doesNotThrowAnyException();
    assertThat(ready.environmentToken()).isEqualTo("SANDBOX");
  }

  @Test
  void fakeRequiresExplicitOptInAndSkipsPlaidSecrets() {
    ConnectedFinanceProperties silent = enabled("fake", false);
    silent.setEncryptionKeys(KEYS);
    assertThatThrownBy(silent::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties explicit = enabled("fake", true);
    explicit.setEncryptionKeys(KEYS);
    assertThatCode(explicit::validateFailClosed).doesNotThrowAnyException();
  }

  @Test
  void rejectsUnknownProviderEnvironmentHostAndKeys() {
    ConnectedFinanceProperties provider = enabled("pluggy", false);
    provider.setEncryptionKeys(KEYS);
    assertThatThrownBy(provider::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties environment = enabled("fake", true);
    environment.setEnvironment("eu");
    environment.setEncryptionKeys(KEYS);
    assertThatThrownBy(environment::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties host = enabled("fake", true);
    host.setBaseUrl("https://evil.example.test");
    host.setEncryptionKeys(KEYS);
    assertThatThrownBy(host::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties shortKey = enabled("fake", true);
    shortKey.setEncryptionKeys("test-key-1:" + Base64.getEncoder().encodeToString(new byte[16]));
    assertThatThrownBy(shortKey::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties malformed = enabled("fake", true);
    malformed.setEncryptionKeys("not-a-key-entry");
    assertThatThrownBy(malformed::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties nonBase64 = enabled("fake", true);
    nonBase64.setEncryptionKeys("test-key-1:!!!not-base64!!!");
    assertThatThrownBy(nonBase64::validateFailClosed).isInstanceOf(IllegalStateException.class);

    ConnectedFinanceProperties badId = enabled("fake", true);
    badId.setEncryptionKeys("bad id!:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
    assertThatThrownBy(badId::validateFailClosed).isInstanceOf(IllegalStateException.class);
  }

  @Test
  void productionResolvesProductionHostAndToken() {
    ConnectedFinanceProperties properties = enabled("fake", true);
    properties.setEnvironment("production");
    properties.setEncryptionKeys(KEYS);
    assertThatCode(properties::validateFailClosed).doesNotThrowAnyException();
    assertThat(properties.environmentToken()).isEqualTo("PRODUCTION");
    assertThat(properties.resolvedBaseUrl()).isEqualTo("https://production.plaid.com");
  }

  private static ConnectedFinanceProperties enabled(String provider, boolean fakeAllowed) {
    ConnectedFinanceProperties properties = new ConnectedFinanceProperties();
    properties.setEnabled(true);
    properties.setProvider(provider);
    properties.setFakeAllowed(fakeAllowed);
    return properties;
  }

  private static String base64() {
    byte[] raw = new byte[32];
    for (int i = 0; i < raw.length; i++) {
      raw[i] = (byte) i;
    }
    return Base64.getEncoder().encodeToString(raw);
  }
}
