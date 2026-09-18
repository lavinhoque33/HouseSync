package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapterException;
import com.housesync.finance.connection.plaid.PlaidHttpAdapter;
import com.housesync.finance.connection.plaid.ProviderErrorClass;
import com.housesync.finance.connection.plaid.RemoteAccount;
import com.sun.net.httpserver.HttpServer;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

class PlaidHttpAdapterTest {

  private HttpServer server;
  private final List<String> paths = new CopyOnWriteArrayList<>();
  private final List<String> bodies = new CopyOnWriteArrayList<>();
  private volatile int status = 200;
  private volatile String payload = "{}";

  private PlaidHttpAdapter adapter;
  private ConnectedFinanceProperties properties;

  @BeforeEach
  void startStub() throws Exception {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          paths.add(exchange.getRequestURI().getPath());
          bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
          byte[] response = payload.getBytes(StandardCharsets.UTF_8);
          exchange.getResponseHeaders().add("Content-Type", "application/json");
          exchange.sendResponseHeaders(status, response.length);
          exchange.getResponseBody().write(response);
          exchange.close();
        });
    server.start();
    properties = new ConnectedFinanceProperties();
    properties.setClientId("test-client");
    properties.setSecret("test-secret");
    properties.setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
    adapter =
        new PlaidHttpAdapter(
            properties,
            JsonMapper.builder().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).build(),
            Clock.fixed(Instant.EPOCH, ZoneOffset.UTC));
  }

  @AfterEach
  void stopStub() {
    server.stop(0);
  }

  @Test
  void linkTokenCreateUsesAllowlistedPathCredentialsAndOpaqueUser() {
    payload = "{\"link_token\":\"link-123\",\"expiration\":900}";
    PlaidAdapter.LinkToken token = adapter.createLinkToken(UUID.randomUUID(), "opaque-user-1");

    assertThat(paths).containsExactly("/link/token/create");
    assertThat(bodies.get(0))
        .contains("\"client_id\":\"test-client\"")
        .contains("\"secret\":\"test-secret\"")
        .contains("\"country_codes\":[\"US\",\"CA\"]")
        .contains("\"products\":[\"transactions\"]")
        .contains("\"user\":{\"client_user_id\":\"opaque-user-1\"}");
    assertThat(token.linkToken()).isEqualTo("link-123");
    assertThat(token.expiresAt()).isEqualTo(Instant.EPOCH.plusSeconds(900));
  }

  @Test
  void updateLinkTokenUsesUpdateModeEnvelopeWithoutProducts() {
    payload = "{\"link_token\":\"link-update\",\"expiration\":900}";
    PlaidAdapter.LinkToken token = adapter.createUpdateLinkToken("access-1", "opaque-user-1");

    assertThat(paths).containsExactly("/link/token/create");
    assertThat(bodies.get(0))
        .contains("\"client_name\":\"HouseSync\"")
        .contains("\"country_codes\":[\"US\",\"CA\"]")
        .contains("\"language\":\"en\"")
        .contains("\"user\":{\"client_user_id\":\"opaque-user-1\"}")
        .contains("\"access_token\":\"access-1\"")
        .doesNotContain("\"products\"")
        .doesNotContain("\"redirect_uri\"");
    assertThat(token.linkToken()).isEqualTo("link-update");
    assertThat(token.expiresAt()).isEqualTo(Instant.EPOCH.plusSeconds(900));
  }

  @Test
  void updateLinkTokenCarriesConfiguredRedirectUri() {
    payload = "{\"link_token\":\"link-update\",\"expiration\":900}";
    properties.setRedirectUrl("https://app.example.test/connected-finance/callback");

    adapter.createUpdateLinkToken("access-1", "opaque-user-1");

    assertThat(bodies.get(0))
        .contains("\"redirect_uri\":\"https://app.example.test/connected-finance/callback\"");
  }

  @Test
  void linkTokenRejectsBlankTokenAndInvalidExpiration() {
    payload = "{}";
    assertThatThrownBy(() -> adapter.createLinkToken(UUID.randomUUID(), "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.INVALID_DATA));

    payload = "{\"link_token\":\"\",\"expiration\":900}";
    assertThatThrownBy(() -> adapter.createLinkToken(UUID.randomUUID(), "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class);

    payload = "{\"link_token\":\"link-1\"}";
    assertThatThrownBy(() -> adapter.createUpdateLinkToken("access-1", "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class);

    payload = "{\"link_token\":\"link-1\",\"expiration\":0}";
    assertThatThrownBy(() -> adapter.createUpdateLinkToken("access-1", "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class);
  }

  @Test
  void linkTokenParsesIsoExpirationExactly() {
    // Fixed clock is the epoch: a realistic Plaid ISO timestamp parses to the exact instant.
    payload = "{\"link_token\":\"link-iso\",\"expiration\":\"1970-01-02T00:00:00Z\"}";
    PlaidAdapter.LinkToken token = adapter.createLinkToken(UUID.randomUUID(), "opaque-user-1");
    assertThat(token.linkToken()).isEqualTo("link-iso");
    assertThat(token.expiresAt()).isEqualTo(Instant.parse("1970-01-02T00:00:00Z"));

    payload = "{\"link_token\":\"link-iso\",\"expiration\":\"1970-01-02T00:00:00+00:00\"}";
    PlaidAdapter.LinkToken offset = adapter.createUpdateLinkToken("access-1", "opaque-user-1");
    assertThat(offset.expiresAt()).isEqualTo(Instant.parse("1970-01-02T00:00:00Z"));

    payload = "{\"link_token\":\"link-iso\",\"expiration\":\"1969-12-31T23:59:59Z\"}";
    assertThatThrownBy(() -> adapter.createLinkToken(UUID.randomUUID(), "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.INVALID_DATA));

    payload = "{\"link_token\":\"link-iso\",\"expiration\":\"not-a-timestamp\"}";
    assertThatThrownBy(() -> adapter.createUpdateLinkToken("access-1", "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class);

    payload = "{\"link_token\":\"link-iso\",\"expiration\":\"\"}";
    assertThatThrownBy(() -> adapter.createLinkToken(UUID.randomUUID(), "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class);
  }

  @Test
  void exchangeReturnsItemIdentityAndCredential() {
    payload = "{\"access_token\":\"access-1\",\"item_id\":\"item-1\"}";
    PlaidAdapter.ExchangeResult result = adapter.exchangePublicToken("public-1");

    assertThat(paths).containsExactly("/item/public_token/exchange");
    assertThat(result.remoteItemId()).isEqualTo("item-1");
    assertThat(result.accessToken()).isEqualTo("access-1");
  }

  @Test
  void accountsGetNormalizesKindsAndCurrencies() {
    payload =
        "{\"accounts\":["
            + "{\"account_id\":\"a1\",\"name\":\"Checking\",\"official_name\":null,"
            + "\"type\":\"depository\",\"subtype\":\"checking\","
            + "\"balances\":{\"iso_currency_code\":\"USD\"}},"
            + "{\"account_id\":\"a2\",\"name\":\"Card\",\"official_name\":\"Prime Card\","
            + "\"type\":\"credit\",\"subtype\":\"credit card\","
            + "\"balances\":{\"iso_currency_code\":\"CAD\"}},"
            + "{\"account_id\":\"a3\",\"name\":\"Loan\",\"type\":\"loan\",\"subtype\":\"auto\","
            + "\"balances\":{\"iso_currency_code\":\"USD\"}}]}";
    List<RemoteAccount> accounts = adapter.fetchAccounts("access-1");

    assertThat(paths).containsExactly("/accounts/get");
    assertThat(accounts)
        .containsExactly(
            new RemoteAccount("a1", "Checking", "CHECKING", "USD"),
            new RemoteAccount("a2", "Prime Card", "CREDIT_CARD", "CAD"),
            new RemoteAccount("a3", "Loan", "UNSUPPORTED", "USD"));
  }

  @Test
  void depositorySubtypesMapToSavingsOrChecking() {
    payload =
        "{\"accounts\":["
            + "{\"account_id\":\"s1\",\"name\":\"Savings\",\"type\":\"depository\","
            + "\"subtype\":\"savings\",\"balances\":{\"iso_currency_code\":\"USD\"}},"
            + "{\"account_id\":\"s2\",\"name\":\"CD\",\"type\":\"depository\",\"subtype\":\"cd\","
            + "\"balances\":{\"iso_currency_code\":\"USD\"}},"
            + "{\"account_id\":\"s3\",\"name\":\"MM\",\"type\":\"depository\","
            + "\"subtype\":\"money market\",\"balances\":{\"iso_currency_code\":\"USD\"}},"
            + "{\"account_id\":\"c1\",\"name\":\"Checking\",\"type\":\"depository\","
            + "\"subtype\":\"checking\",\"balances\":{\"iso_currency_code\":\"CAD\"}},"
            + "{\"account_id\":\"p1\",\"name\":\"PayPal\",\"type\":\"depository\","
            + "\"subtype\":\"paypal\",\"balances\":{\"iso_currency_code\":\"USD\"}},"
            + "{\"account_id\":\"l1\",\"name\":\"Loan\",\"type\":\"loan\",\"subtype\":\"auto\","
            + "\"balances\":{\"iso_currency_code\":\"USD\"}}]}";
    List<RemoteAccount> accounts = adapter.fetchAccounts("access-1");

    assertThat(accounts.stream().map(RemoteAccount::kind).toList())
        .containsExactly("SAVINGS", "SAVINGS", "SAVINGS", "CHECKING", "UNSUPPORTED", "UNSUPPORTED");
  }

  @Test
  void blankAccountIdentityInvalidatesTheWholeRound() {
    payload =
        "{\"accounts\":["
            + "{\"account_id\":\"a1\",\"name\":\"Ok\",\"type\":\"depository\","
            + "\"subtype\":\"checking\",\"balances\":{\"iso_currency_code\":\"USD\"}},"
            + "{\"account_id\":\"\",\"name\":\"Blank\",\"type\":\"depository\","
            + "\"subtype\":\"checking\",\"balances\":{\"iso_currency_code\":\"USD\"}}]}";
    assertThatThrownBy(() -> adapter.fetchAccounts("access-1"))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.INVALID_DATA));
  }

  @Test
  void providerFailuresNormalizeWithoutPayloads() {
    payload = "{\"error_code\":\"ITEM_LOGIN_REQUIRED\"}";
    status = 400;
    assertThatThrownBy(() -> adapter.fetchAccounts("access-1"))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.REAUTH_REQUIRED));

    payload = "not json";
    status = 500;
    assertThatThrownBy(() -> adapter.removeItem("access-1"))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.INVALID_DATA));
  }

  @Test
  void itemRemoveConfirmsQuietly() {
    payload = "{\"removed\":true}";
    adapter.removeItem("access-1");
    assertThat(paths).containsExactly("/item/remove");
    assertThat(bodies.get(0)).contains("\"access_token\":\"access-1\"");
  }

  @Test
  void transactionSyncParsesExactDecimalsSignsAndPages() {
    payload =
        "{\"added\":[{\"account_id\":\"a1\",\"transaction_id\":\"t1\",\"pending\":false,"
            + "\"iso_currency_code\":\"USD\",\"amount\":12.3400,\"date\":\"2026-09-01\","
            + "\"name\":\"Coffee\",\"merchant_name\":null,\"pending_transaction_id\":null}],"
            + "\"modified\":[{\"account_id\":\"a1\",\"transaction_id\":\"t2\",\"pending\":false,"
            + "\"iso_currency_code\":\"CAD\",\"amount\":-250.0000,\"date\":\"2026-09-02\","
            + "\"name\":\"Payroll\"}],"
            + "\"removed\":[{\"transaction_id\":\"t0\"}],"
            + "\"next_cursor\":\"cursor-2\",\"has_more\":true,"
            + "\"transactions_update_status\":\"HISTORICAL_UPDATE_COMPLETE\"}";
    PlaidAdapter.SyncPage page = adapter.fetchTransactionChanges("access-1", null);

    assertThat(paths).containsExactly("/transactions/sync");
    assertThat(bodies.get(0)).contains("\"count\":100").doesNotContain("\"cursor\"");
    assertThat(page.upserts()).hasSize(2);
    PlaidAdapter.ProviderTransaction debit = page.upserts().get(0);
    // The exact provider token survives: 12.3400 is not 12.34 or a binary float.
    assertThat(debit.amount().toPlainString()).isEqualTo("12.3400");
    assertThat(debit.postedOn()).isEqualTo(java.time.LocalDate.of(2026, 9, 1));
    assertThat(debit.officialCurrency()).isEqualTo("USD");
    assertThat(page.upserts().get(1).amount().toPlainString()).isEqualTo("-250.0000");
    assertThat(page.removedRemoteTransactionIds()).containsExactly("t0");
    assertThat(page.nextCursor()).isEqualTo("cursor-2");
    assertThat(page.hasMore()).isTrue();
    assertThat(page.historyReady()).isTrue();
  }

  @Test
  void transactionSyncSendsCursorAndRequiresEnvelopeFacts() {
    payload =
        "{\"added\":[],\"modified\":[],\"removed\":[],\"next_cursor\":\"c3\",\"has_more\":false}";
    adapter.fetchTransactionChanges("access-1", "cursor-1");
    assertThat(bodies.get(0)).contains("\"cursor\":\"cursor-1\"");

    payload = "{\"added\":[],\"modified\":[],\"removed\":[]}";
    assertThatThrownBy(() -> adapter.fetchTransactionChanges("access-1", null))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.INVALID_DATA));

    payload =
        "{\"added\":[{\"transaction_id\":\"t1\",\"pending\":false,\"amount\":1.0,"
            + "\"date\":\"2026-09-01\"}],\"modified\":[],\"removed\":[],"
            + "\"next_cursor\":\"c4\",\"has_more\":false}";
    assertThatThrownBy(() -> adapter.fetchTransactionChanges("access-1", null))
        .isInstanceOf(PlaidAdapterException.class);

    payload =
        "{\"added\":[{\"account_id\":\"a1\",\"pending\":false,\"amount\":1.0,"
            + "\"date\":\"2026-09-01\"}],\"modified\":[],\"removed\":[],"
            + "\"next_cursor\":\"c5\",\"has_more\":false}";
    assertThatThrownBy(() -> adapter.fetchTransactionChanges("access-1", null))
        .isInstanceOf(PlaidAdapterException.class);

    payload =
        "{\"added\":[{\"account_id\":\"a1\",\"transaction_id\":\"t1\",\"pending\":false,"
            + "\"amount\":\"1.00\",\"date\":\"2026-09-01\"}],\"modified\":[],\"removed\":[],"
            + "\"next_cursor\":\"c6\",\"has_more\":false}";
    assertThatThrownBy(() -> adapter.fetchTransactionChanges("access-1", null))
        .isInstanceOf(PlaidAdapterException.class);
  }

  @Test
  void webhookVerificationKeyParsesP256JwkThroughFixedHost() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    KeyPair pair = generator.generateKeyPair();
    ECPublicKey publicKey = (ECPublicKey) pair.getPublic();
    payload =
        "{\"key\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"alg\":\"ES256\",\"kid\":\"kid-1\",\"use\":\"sig\","
            + "\"x\":\""
            + base64Url(coordinate(publicKey.getW().getAffineX()))
            + "\",\"y\":\""
            + base64Url(coordinate(publicKey.getW().getAffineY()))
            + "\",\"expired_at\":\"2030-01-01T00:00:00Z\"}}";
    PlaidAdapter.VerificationKey key = adapter.fetchVerificationKey("kid-1");

    assertThat(paths).containsExactly("/webhook_verification_key/get");
    assertThat(key.keyId()).isEqualTo("kid-1");
    assertThat(key.publicKey()).isInstanceOf(ECPublicKey.class);
    assertThat(key.expiresAt()).isEqualTo(Instant.parse("2030-01-01T00:00:00Z"));

    payload = "{\"key\":{\"kty\":\"RSA\",\"kid\":\"kid-2\",\"n\":\"abc\",\"e\":\"AQAB\"}}";
    assertThatThrownBy(() -> adapter.fetchVerificationKey("kid-2"))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.INVALID_DATA));
  }

  private static byte[] coordinate(BigInteger value) {
    byte[] raw = value.toByteArray();
    if (raw.length == 32) {
      return raw;
    }
    byte[] padded = new byte[32];
    if (raw.length > 32) {
      System.arraycopy(raw, raw.length - 32, padded, 0, 32);
    } else {
      System.arraycopy(raw, 0, padded, 32 - raw.length, raw.length);
    }
    return padded;
  }

  private static String base64Url(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }
}
