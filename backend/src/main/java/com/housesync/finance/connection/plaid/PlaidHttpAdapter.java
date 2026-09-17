package com.housesync.finance.connection.plaid;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Plaid REST adapter over the JDK HTTP client (no provider SDK). Covers exactly these calls:
 * {@code /link/token/create} (new and update mode), {@code /item/public_token/exchange}, {@code
 * /accounts/get}, and {@code /item/remove}.
 *
 * <p>Runs fully outside domain write transactions; callers persist intent first. Request bodies and
 * response payloads are never logged. Failures normalize to {@link ProviderErrorClass}; Plaid error
 * codes are a diagnostic mapping, never a REST error surface.
 */
public class PlaidHttpAdapter implements PlaidAdapter {

  private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
  private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(20);

  private final ConnectedFinanceProperties properties;
  private final ObjectMapper mapper;
  private final Clock clock;
  private final HttpClient client;

  public PlaidHttpAdapter(ConnectedFinanceProperties properties, ObjectMapper mapper, Clock clock) {
    this.properties = properties;
    this.mapper = mapper;
    this.clock = clock;
    this.client =
        HttpClient.newBuilder()
            .connectTimeout(CONNECT_TIMEOUT)
            .version(HttpClient.Version.HTTP_1_1)
            .build();
  }

  @Override
  public LinkToken createLinkToken(UUID attemptId, String clientUserId) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("client_name", "HouseSync");
    body.put("country_codes", List.of("US", "CA"));
    body.put("language", "en");
    body.put("products", List.of("transactions"));
    body.put("user", Map.of("client_user_id", clientUserId));
    if (!properties.getRedirectUrl().isBlank()) {
      body.put("redirect_uri", properties.getRedirectUrl());
    }
    if (!properties.getWebhookUrl().isBlank()) {
      body.put("webhook", properties.getWebhookUrl());
    }
    return readLinkToken(post("/link/token/create", body));
  }

  @Override
  public LinkToken createUpdateLinkToken(String accessToken) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("access_token", accessToken);
    return readLinkToken(post("/link/token/create", body));
  }

  /**
   * Rejects missing/blank tokens and missing/unparseable/non-future expirations instead of
   * persisting an empty token or an assumed lifetime. Plaid documents {@code expiration} as an
   * ISO-8601 absolute timestamp; a numeric relative-seconds value is accepted only as compatibility
   * tolerance.
   */
  private LinkToken readLinkToken(JsonNode response) {
    String linkToken = response.path("link_token").asText(null);
    if (linkToken == null || linkToken.isBlank()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    Instant now = Instant.now(clock);
    Instant expiresAt = parseExpiration(response.path("expiration"));
    if (expiresAt == null || !expiresAt.isAfter(now)) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    return new LinkToken(linkToken, expiresAt);
  }

  private Instant parseExpiration(JsonNode expiration) {
    if (expiration == null || expiration.isNull()) {
      return null;
    }
    if (expiration.isNumber()) {
      long seconds = expiration.asLong(-1);
      return seconds <= 0 ? null : Instant.now(clock).plusSeconds(Math.max(60, seconds));
    }
    String text = expiration.asText(null);
    if (text == null || text.isBlank()) {
      return null;
    }
    try {
      return Instant.parse(text.strip());
    } catch (RuntimeException rejected) {
      return null;
    }
  }

  @Override
  public ExchangeResult exchangePublicToken(String publicToken) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("public_token", publicToken);
    JsonNode response = post("/item/public_token/exchange", body);
    String itemId = response.path("item_id").asText(null);
    String accessToken = response.path("access_token").asText(null);
    if (itemId == null || itemId.isBlank() || accessToken == null || accessToken.isBlank()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    return new ExchangeResult(itemId, accessToken);
  }

  @Override
  public List<RemoteAccount> fetchAccounts(String accessToken) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("access_token", accessToken);
    JsonNode response = post("/accounts/get", body);
    List<RemoteAccount> accounts = new ArrayList<>();
    JsonNode listed = response.path("accounts");
    if (!listed.isArray()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    for (JsonNode account : listed) {
      // A blank provider identity corrupts the whole discovery round: without a stable
      // remote identity no mapping can be keyed, so the round is invalid, not partial.
      String remoteId = account.path("account_id").asText(null);
      if (remoteId == null || remoteId.isBlank()) {
        throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
      }
      String type = account.path("type").asText("");
      String subtype = account.path("subtype").asText("");
      String name =
          account.path("official_name").asText(null) != null
              ? account.path("official_name").asText()
              : account.path("name").asText("Account");
      String currency = account.path("balances").path("iso_currency_code").asText(null);
      accounts.add(
          new RemoteAccount(
              remoteId, name, mapKind(type, subtype), currency == null ? "" : currency));
    }
    return accounts;
  }

  @Override
  public void removeItem(String accessToken) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("access_token", accessToken);
    post("/item/remove", body);
  }

  private JsonNode post(String path, Map<String, Object> body) {
    Map<String, Object> envelope = new LinkedHashMap<>();
    envelope.put("client_id", properties.getClientId());
    envelope.put("secret", properties.getSecret());
    envelope.putAll(body);
    String payload;
    try {
      payload = mapper.writeValueAsString(envelope);
    } catch (RuntimeException failed) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    HttpRequest request =
        HttpRequest.newBuilder(URI.create(properties.resolvedBaseUrl() + path))
            .timeout(REQUEST_TIMEOUT)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload))
            .build();
    HttpResponse<String> response;
    try {
      response = client.send(request, HttpResponse.BodyHandlers.ofString());
    } catch (IOException | InterruptedException failed) {
      if (failed instanceof InterruptedException) {
        Thread.currentThread().interrupt();
      }
      throw new PlaidAdapterException(ProviderErrorClass.TRANSIENT);
    }
    if (response.statusCode() == 429) {
      throw new PlaidAdapterException(ProviderErrorClass.RATE_LIMITED, retryAfterSeconds(response));
    }
    JsonNode parsed;
    try {
      parsed =
          response.body() == null || response.body().isBlank()
              ? mapper.createObjectNode()
              : mapper.readTree(response.body());
    } catch (RuntimeException failed) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    if (response.statusCode() >= 200 && response.statusCode() < 300) {
      return parsed;
    }
    throw new PlaidAdapterException(mapError(parsed, response.statusCode()));
  }

  /**
   * Diagnostic mapping of Plaid error codes to normalized classes. Unknown 5xx and network failures
   * are transient; unknown 4xx are permanent; auth/consent codes request recovery.
   */
  /** Parses a valid Retry-After delay; absent or malformed values stay empty. */
  static Long retryAfterSeconds(HttpResponse<String> response) {
    try {
      long seconds =
          response
              .headers()
              .firstValue("Retry-After")
              .map(String::strip)
              .map(Long::parseLong)
              .orElse(-1L);
      return seconds >= 0 ? seconds : null;
    } catch (RuntimeException rejected) {
      return null;
    }
  }

  static ProviderErrorClass mapError(JsonNode parsed, int status) {
    String code = parsed.path("error_code").asText("");
    return switch (code) {
      case "ITEM_LOGIN_REQUIRED", "INVALID_CREDENTIALS", "INVALID_MFA", "ITEM_LOCKED" ->
          ProviderErrorClass.REAUTH_REQUIRED;
      case "ITEM_CONCURRENTLY_DELETED" ->
          // The Item is gone remotely; recovery cannot reauthenticate it.
          ProviderErrorClass.PERMANENT;
      case "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" -> ProviderErrorClass.PAGINATION_RESTART;
      case "USER_CONSENT_REVOKED", "ITEM_CONSENT_REVOKED" -> ProviderErrorClass.CONSENT_REVOKED;
      case "RATE_LIMIT_EXCEEDED" -> ProviderErrorClass.RATE_LIMITED;
      case "TRANSACTIONS_NOT_READY" -> ProviderErrorClass.NOT_READY;
      case "PRODUCT_NOT_READY", "ITEM_PRODUCT_NOT_READY" -> ProviderErrorClass.NOT_READY;
      case "INVALID_REQUEST",
          "INVALID_INPUT",
          "INVALID_ACCESS_TOKEN",
          "ITEM_NOT_FOUND",
          "PRODUCT_NOT_ENABLED" ->
          ProviderErrorClass.PERMANENT;
      case "INSTITUTION_NOT_RESPONDING", "INSTITUTION_DOWN", "INSTITUTION_NOT_AVAILABLE" ->
          ProviderErrorClass.TRANSIENT;
      case "" -> status >= 500 ? ProviderErrorClass.TRANSIENT : ProviderErrorClass.PERMANENT;
      default -> status >= 500 ? ProviderErrorClass.TRANSIENT : ProviderErrorClass.PERMANENT;
    };
  }

  private static String mapKind(String type, String subtype) {
    if ("credit".equals(type)) {
      return "CREDIT_CARD";
    }
    if ("depository".equals(type)) {
      if ("checking".equalsIgnoreCase(subtype)) {
        return "CHECKING";
      }
      if ("savings".equalsIgnoreCase(subtype)
          || "cd".equalsIgnoreCase(subtype)
          || "money market".equalsIgnoreCase(subtype)) {
        return "SAVINGS";
      }
    }
    // PayPal, prepaid, loans, investments, and unknown types are ineligible; the service
    // preserves the null classification with an explicit exclusion reason.
    return "UNSUPPORTED";
  }
}
