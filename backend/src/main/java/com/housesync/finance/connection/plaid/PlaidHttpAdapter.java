package com.housesync.finance.connection.plaid;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Base64;
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
  public LinkToken createUpdateLinkToken(String accessToken, String clientUserId) {
    // Plaid requires the same base envelope as new-link mode and rejects products in update mode.
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("client_name", "HouseSync");
    body.put("country_codes", List.of("US", "CA"));
    body.put("language", "en");
    body.put("user", Map.of("client_user_id", clientUserId));
    if (!properties.getRedirectUrl().isBlank()) {
      body.put("redirect_uri", properties.getRedirectUrl());
    }
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

  /**
   * One {@code /transactions/sync} page. Envelope corruption (non-array lists, missing next cursor
   * or has-more flag, an upset without account/transaction identity, or a non-numeric amount)
   * aborts the round rather than inventing values; a domain-invalid but identifiable transaction
   * keeps its provider fields and is quarantined by the normalizer. The mapper is the dedicated
   * exact-decimal mapper, so {@code decimalValue()} never passes through a binary float.
   */
  @Override
  public SyncPage fetchTransactionChanges(String accessToken, String cursor) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("access_token", accessToken);
    body.put("count", 100);
    if (cursor != null && !cursor.isBlank()) {
      body.put("cursor", cursor);
    }
    JsonNode response = post("/transactions/sync", body);
    JsonNode added = response.path("added");
    JsonNode modified = response.path("modified");
    JsonNode removed = response.path("removed");
    JsonNode nextCursorNode = response.path("next_cursor");
    JsonNode hasMoreNode = response.path("has_more");
    if (!added.isArray() || !modified.isArray() || !removed.isArray()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    if (!nextCursorNode.isTextual() || nextCursorNode.asText().isBlank()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    if (!hasMoreNode.isBoolean()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    List<ProviderTransaction> upserts = new ArrayList<>();
    for (JsonNode transaction : added) {
      upserts.add(parseTransaction(transaction));
    }
    for (JsonNode transaction : modified) {
      upserts.add(parseTransaction(transaction));
    }
    List<String> removedIds = new ArrayList<>();
    for (JsonNode transaction : removed) {
      String remoteId = readText(transaction, "transaction_id");
      // A removal without identity cannot become a tombstone or be replayed safely.
      if (remoteId == null) {
        throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
      }
      removedIds.add(remoteId);
    }
    boolean historyReady =
        "HISTORICAL_UPDATE_COMPLETE"
            .equalsIgnoreCase(response.path("transactions_update_status").asText(""));
    return new SyncPage(
        upserts, removedIds, nextCursorNode.asText(), hasMoreNode.asBoolean(), historyReady);
  }

  private ProviderTransaction parseTransaction(JsonNode transaction) {
    String remoteAccountId = readText(transaction, "account_id");
    String remoteTransactionId = readText(transaction, "transaction_id");
    if (remoteAccountId == null || remoteTransactionId == null) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    String predecessor = readText(transaction, "pending_transaction_id");
    JsonNode pendingNode = transaction.path("pending");
    if (!pendingNode.isMissingNode() && !pendingNode.isBoolean()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    boolean pending = pendingNode.isBoolean() && pendingNode.asBoolean();
    String officialCurrency = readText(transaction, "iso_currency_code");
    String unofficialCurrency = readText(transaction, "unofficial_currency_code");
    BigDecimal amount = readDecimal(transaction.path("amount"));
    LocalDate postedOn = readDate(transaction.path("date"));
    LocalDate authorizedOn = readDate(transaction.path("authorized_date"));
    String name = readText(transaction, "name");
    String merchantName = readText(transaction, "merchant_name");
    // Stable merchant identity is provider-scoped evidence; the display name is bounded untrusted
    // text distinct from the statement description. Personal-finance codes normalize to the
    // documented uppercase token shape before anything persists.
    String merchantIdentity = readText(transaction, "merchant_entity_id");
    String merchantDisplayName = merchantName;
    String pfcPrimary =
        normalizePfcCode(readText(transaction.path("personal_finance_category"), "primary"));
    String pfcDetail =
        normalizePfcCode(readText(transaction.path("personal_finance_category"), "detailed"));
    if (pfcDetail != null && pfcPrimary == null) {
      // A detail code without its primary is unsafe evidence and never surfaced.
      pfcDetail = null;
    }
    return new ProviderTransaction(
        remoteAccountId,
        remoteTransactionId,
        predecessor,
        pending,
        officialCurrency,
        unofficialCurrency,
        amount,
        postedOn,
        authorizedOn,
        name,
        merchantName,
        merchantIdentity,
        merchantDisplayName,
        pfcPrimary,
        pfcDetail);
  }

  /**
   * Provider category codes are uppercase identifier-shaped tokens; a lowercase, punctuated, or
   * over-limit value is malformed evidence and becomes null rather than a coerced guess.
   */
  private static String normalizePfcCode(String raw) {
    if (raw == null || raw.isBlank() || raw.length() > 200) {
      return null;
    }
    for (int index = 0; index < raw.length(); index++) {
      char character = raw.charAt(index);
      boolean allowed =
          (character >= 'A' && character <= 'Z')
              || (character >= '0' && character <= '9')
              || character == '_';
      if (!allowed) {
        return null;
      }
    }
    return raw;
  }

  /**
   * Provider decimal tokens arrive as JSON numbers. Anything else (absent, string, boolean) is a
   * corrupt envelope; correctness cannot be recovered by guessing.
   */
  private static BigDecimal readDecimal(JsonNode node) {
    if (node.isMissingNode() || node.isNull()) {
      return null;
    }
    if (!node.isNumber()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    try {
      return node.decimalValue();
    } catch (RuntimeException rejected) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
  }

  private static LocalDate readDate(JsonNode node) {
    String text = node.isTextual() ? node.asText() : null;
    if (text == null || text.isBlank()) {
      return null;
    }
    try {
      return LocalDate.parse(text.strip());
    } catch (RuntimeException rejected) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
  }

  private static String readText(JsonNode object, String field) {
    JsonNode node = object.path(field);
    if (node.isMissingNode() || node.isNull()) {
      return null;
    }
    if (!node.isTextual()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    String text = node.asText();
    return text.isBlank() ? null : text;
  }

  /**
   * Fetches a Plaid verification JWK by key id through the fixed allowlisted host. The JWK must be
   * an EC P-256 key for ES256; a malformed key is invalid data while a missing endpoint or a
   * provider failure is transient infrastructure, never a verification success.
   */
  @Override
  public VerificationKey fetchVerificationKey(String keyId) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("key_id", keyId);
    JsonNode response = post("/webhook_verification_key/get", body);
    JsonNode key = response.path("key");
    if (!key.isObject()) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    String kid = readText(key, "kid");
    String kty = readText(key, "kty");
    String crv = readText(key, "crv");
    if (kid == null || !"EC".equals(kty) || !"P-256".equals(crv)) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    String alg = readText(key, "alg");
    if (alg != null && !"ES256".equals(alg)) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    String x = readText(key, "x");
    String y = readText(key, "y");
    if (x == null || y == null) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
    Instant expiredAt = null;
    String expired = readText(key, "expired_at");
    if (expired != null) {
      try {
        expiredAt = Instant.parse(expired.strip());
      } catch (RuntimeException rejected) {
        throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
      }
    }
    try {
      AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
      parameters.init(new ECGenParameterSpec("secp256r1"));
      ECParameterSpec spec = parameters.getParameterSpec(ECParameterSpec.class);
      ECPoint point =
          new ECPoint(
              new BigInteger(1, Base64.getUrlDecoder().decode(x)),
              new BigInteger(1, Base64.getUrlDecoder().decode(y)));
      PublicKey publicKey =
          KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, spec));
      return new VerificationKey(kid, publicKey, expiredAt);
    } catch (RuntimeException | java.security.GeneralSecurityException rejected) {
      throw new PlaidAdapterException(ProviderErrorClass.INVALID_DATA);
    }
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
