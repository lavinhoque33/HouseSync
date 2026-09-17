package com.housesync.finance.connection.config;

import java.util.Base64;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Connected-finance configuration. The feature is explicitly opt-in: the default
 * application starts with {@code enabled=false} and manual finance is unchanged. When enabled, {@link
 * #validateFailClosed()} rejects startup unless every required secret and key parses, so a
 * misconfigured provider can never run half-initialized.
 */
@ConfigurationProperties(prefix = "app.connected-finance")
public class ConnectedFinanceProperties {

  /** Master switch; default disabled so the normal application never touches providers. */
  private boolean enabled = false;

  /** {@code plaid} for production paths, {@code fake} only for tests/explicit local config. */
  private String provider = "plaid";

  /**
   * Explicit opt-in for the deterministic fake adapter. The fake is never selected silently: {@code
   * provider=fake} without this flag fails closed.
   */
  private boolean fakeAllowed = false;

  /**
   * {@code sandbox} or {@code production}; persisted on connections/attempts as SANDBOX/PRODUCTION.
   */
  private String environment = "sandbox";

  private String clientId = "";
  private String secret = "";
  private String baseUrl = "";
  private String redirectUrl = "";
  private String webhookUrl = "";

  /**
   * Rotation-capable key set: comma-separated {@code keyId:base64(32 bytes)} entries. The first
   * entry encrypts new ciphertext; every entry remains usable for decryption.
   */
  private String encryptionKeys = "";

  /**
   * Link-attempt lifetime in minutes; capped by the provider token expiry, whichever is earlier.
   */
  private int attemptTtlMinutes = 30;

  public boolean isEnabled() {
    return enabled;
  }

  public void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  public String getProvider() {
    return provider;
  }

  public void setProvider(String provider) {
    this.provider = provider;
  }

  public boolean isFakeAllowed() {
    return fakeAllowed;
  }

  public void setFakeAllowed(boolean fakeAllowed) {
    this.fakeAllowed = fakeAllowed;
  }

  public String getEnvironment() {
    return environment;
  }

  public void setEnvironment(String environment) {
    this.environment = environment;
  }

  public String getClientId() {
    return clientId;
  }

  public void setClientId(String clientId) {
    this.clientId = clientId;
  }

  public String getSecret() {
    return secret;
  }

  public void setSecret(String secret) {
    this.secret = secret;
  }

  public String getBaseUrl() {
    return baseUrl;
  }

  public void setBaseUrl(String baseUrl) {
    this.baseUrl = baseUrl;
  }

  public String getRedirectUrl() {
    return redirectUrl;
  }

  public void setRedirectUrl(String redirectUrl) {
    this.redirectUrl = redirectUrl;
  }

  public String getWebhookUrl() {
    return webhookUrl;
  }

  public void setWebhookUrl(String webhookUrl) {
    this.webhookUrl = webhookUrl;
  }

  public String getEncryptionKeys() {
    return encryptionKeys;
  }

  public void setEncryptionKeys(String encryptionKeys) {
    this.encryptionKeys = encryptionKeys;
  }

  public int getAttemptTtlMinutes() {
    return attemptTtlMinutes;
  }

  public void setAttemptTtlMinutes(int attemptTtlMinutes) {
    this.attemptTtlMinutes = attemptTtlMinutes;
  }

  /** Normalized environment token stored on connections and attempts. */
  public String environmentToken() {
    return "production".equalsIgnoreCase(environment) ? "PRODUCTION" : "SANDBOX";
  }

  /** Resolved provider host, restricted to the fixed allowlist. */
  public String resolvedBaseUrl() {
    if (baseUrl != null && !baseUrl.isBlank()) {
      return baseUrl.strip();
    }
    return "production".equalsIgnoreCase(environment)
        ? "https://production.plaid.com"
        : "https://sandbox.plaid.com";
  }

  /**
   * Fails closed when the feature is enabled but configuration is invalid. Never called when
   * disabled, so the default application starts without any provider secrets or keys.
   */
  public void validateFailClosed() {
    if (!enabled) {
      return;
    }
    boolean fake = "fake".equalsIgnoreCase(provider);
    if (!fake && !"plaid".equalsIgnoreCase(provider)) {
      throw new IllegalStateException("connected finance provider must be plaid or fake");
    }
    if (fake && !fakeAllowed) {
      throw new IllegalStateException(
          "fake provider requires explicit app.connected-finance.fake-allowed=true");
    }
    if (!"sandbox".equalsIgnoreCase(environment) && !"production".equalsIgnoreCase(environment)) {
      throw new IllegalStateException(
          "connected finance environment must be sandbox or production");
    }
    String resolved = resolvedBaseUrl();
    if (!"https://sandbox.plaid.com".equals(resolved)
        && !"https://production.plaid.com".equals(resolved)) {
      throw new IllegalStateException("connected finance base URL is not allowlisted");
    }
    if (!fake) {
      if (clientId == null || clientId.isBlank() || secret == null || secret.isBlank()) {
        throw new IllegalStateException(
            "connected finance requires Plaid client ID and secret when enabled");
      }
    }
    validateEncryptionKeys(encryptionKeys);
    if (attemptTtlMinutes < 1 || attemptTtlMinutes > 30) {
      throw new IllegalStateException("connected finance attempt TTL must be 1-30 minutes");
    }
  }

  /** Parses the rotation-capable key set; shared with the crypto service. */
  static void validateEncryptionKeys(String configured) {
    if (configured == null || configured.isBlank()) {
      throw new IllegalStateException("connected finance requires encryption keys when enabled");
    }
    boolean any = false;
    for (String entry : configured.split(",")) {
      String trimmed = entry.strip();
      if (trimmed.isEmpty()) {
        continue;
      }
      int separator = trimmed.indexOf(':');
      if (separator <= 0) {
        throw new IllegalStateException("connected finance encryption key entry is malformed");
      }
      String keyId = trimmed.substring(0, separator);
      if (!keyId.matches("[A-Za-z0-9_\\-]{1,64}")) {
        throw new IllegalStateException("connected finance encryption key id is invalid");
      }
      byte[] raw;
      try {
        raw = Base64.getDecoder().decode(trimmed.substring(separator + 1));
      } catch (IllegalArgumentException rejected) {
        throw new IllegalStateException("connected finance encryption key is not base64", rejected);
      }
      if (raw.length != 32) {
        throw new IllegalStateException(
            "connected finance encryption keys must be 256-bit (32 bytes)");
      }
      any = true;
    }
    if (!any) {
      throw new IllegalStateException("connected finance requires encryption keys when enabled");
    }
  }
}
