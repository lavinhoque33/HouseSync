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
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class PlaidHttpAdapterTest {

  private HttpServer server;
  private final List<String> paths = new CopyOnWriteArrayList<>();
  private final List<String> bodies = new CopyOnWriteArrayList<>();
  private volatile int status = 200;
  private volatile String payload = "{}";

  private PlaidHttpAdapter adapter;

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
    ConnectedFinanceProperties properties = new ConnectedFinanceProperties();
    properties.setClientId("test-client");
    properties.setSecret("test-secret");
    properties.setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
    adapter =
        new PlaidHttpAdapter(
            properties, new ObjectMapper(), Clock.fixed(Instant.EPOCH, ZoneOffset.UTC));
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
    assertThatThrownBy(() -> adapter.createUpdateLinkToken("access-1"))
        .isInstanceOf(PlaidAdapterException.class);

    payload = "{\"link_token\":\"link-1\",\"expiration\":0}";
    assertThatThrownBy(() -> adapter.createUpdateLinkToken("access-1"))
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
    PlaidAdapter.LinkToken offset = adapter.createUpdateLinkToken("access-1");
    assertThat(offset.expiresAt()).isEqualTo(Instant.parse("1970-01-02T00:00:00Z"));

    payload = "{\"link_token\":\"link-iso\",\"expiration\":\"1969-12-31T23:59:59Z\"}";
    assertThatThrownBy(() -> adapter.createLinkToken(UUID.randomUUID(), "opaque-user-1"))
        .isInstanceOf(PlaidAdapterException.class)
        .satisfies(
            failure ->
                assertThat(((PlaidAdapterException) failure).getErrorClass())
                    .isEqualTo(ProviderErrorClass.INVALID_DATA));

    payload = "{\"link_token\":\"link-iso\",\"expiration\":\"not-a-timestamp\"}";
    assertThatThrownBy(() -> adapter.createUpdateLinkToken("access-1"))
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
}
