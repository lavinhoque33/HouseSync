package com.housesync.finance.categorization.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.transaction.domain.TransactionKind;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class CategorizationAiProviderTest {
  private HttpServer server;
  private AtomicReference<String> received;
  private AtomicReference<String> response;
  private AtomicInteger status;
  private AtomicInteger delayMs;
  private CategorizationAiProvider provider;
  private final ObjectMapper mapper = new ObjectMapper();

  @BeforeEach
  void start() throws Exception {
    received = new AtomicReference<>();
    response = new AtomicReference<>();
    status = new AtomicInteger(200);
    delayMs = new AtomicInteger();
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/v1/chat/completions",
        exchange -> {
          try (exchange) {
            received.set(
                new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            if (delayMs.get() > 0) {
              try {
                Thread.sleep(delayMs.get());
              } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
              }
            }
            byte[] data = response.get().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status.get(), data.length);
            exchange.getResponseBody().write(data);
          }
        });
    server.start();
    provider =
        new CategorizationAiProvider(
            "test-key",
            "test-model",
            "AI_POLICY_V1",
            "http://127.0.0.1:" + server.getAddress().getPort() + "/v1/chat/completions",
            1000,
            mapper);
    response.set(
        envelope(
            "{\"category\":\"GROCERIES\",\"confidence\":\"MEDIUM\",\"reasonCode\":\"MERCHANT_CONTEXT\",\"model\":\"test-model\",\"policy\":\"AI_POLICY_V1\"}"));
  }

  @AfterEach
  void stop() {
    server.stop(0);
  }

  @Test
  void minimizedCaptureAndValidSuggestion() throws Exception {

    var suggestion =
        provider.suggest(
            new CategorizationAiProvider.Evidence(
                "corner market", TransactionKind.EXPENSE, "FOOD_AND_DRINK", "GROCERIES"));
    assertThat(suggestion.category()).isEqualTo("GROCERIES");
    var payload = mapper.readTree(received.get());
    var user = mapper.readTree(payload.path("messages").get(1).path("content").asText());
    assertThat(user.propertyNames())
        .containsExactlyInAnyOrder(
            "description", "kind", "providerPrimaryCode", "providerDetailCode");
    assertThat(user.path("description").asText()).isEqualTo("corner market");
    assertThat(user.path("kind").asText()).isEqualTo("EXPENSE");
    assertThat(user.toString())
        .doesNotContain(
            "amount",
            "currency",
            "accountId",
            "householdId",
            "ownerUserId",
            "visibility",
            "allocation",
            "token",
            "institution");
  }

  @Test
  void durablePolicyIdentityChangesWithModelOrValidationPolicy() {
    String current = CategorizationAiWorkService.reviewPolicy("test-model", "AI_POLICY_V1");
    assertThat(current).hasSize(32).matches("[0-9a-f]{32}");
    assertThat(CategorizationAiWorkService.reviewPolicy("new-model", "AI_POLICY_V1"))
        .isNotEqualTo(current);
    assertThat(CategorizationAiWorkService.reviewPolicy("test-model", "AI_POLICY_V2"))
        .isNotEqualTo(current);
  }

  @Test
  void unknownFieldsAndWrongIdentityAreTerminal() {
    response.set(
        envelope(
            "{\"category\":\"GROCERIES\",\"confidence\":\"MEDIUM\",\"reasonCode\":\"MERCHANT_CONTEXT\",\"model\":\"test-model\",\"policy\":\"AI_POLICY_V1\",\"extra\":\"ignored\"}"));
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isFalse());
    response.set(
        envelope(
            "{\"category\":\"GROCERIES\",\"confidence\":\"MEDIUM\",\"reasonCode\":\"MERCHANT_CONTEXT\",\"model\":\"other\",\"policy\":\"AI_POLICY_V1\"}"));
    assertThatThrownBy(this::suggest).isInstanceOf(CategorizationAiProvider.Failure.class);
  }

  @Test
  void rateLimitRetriesButAuthenticationDoesNot() {
    status.set(429);
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isTrue());
    status.set(401);
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isFalse());
  }

  @Test
  void invalidTaxonomyAndOversizedContentAreTerminal() {
    response.set(
        envelope(
            "{\"category\":\"UNKNOWN\",\"confidence\":\"MEDIUM\",\"reasonCode\":\"MERCHANT_CONTEXT\",\"model\":\"test-model\",\"policy\":\"AI_POLICY_V1\"}"));
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isFalse());
    response.set(
        envelope(
            "{\"category\":\"GROCERIES\",\"confidence\":\"MEDIUM\",\"reasonCode\":\"MERCHANT_CONTEXT\",\"model\":\"test-model\",\"policy\":\"AI_POLICY_V1\"}"
                + " ".repeat(1025)));
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isFalse());
  }

  @Test
  void outageAndTimeoutAreTransientButMalformedJsonIsNot() throws Exception {
    status.set(503);
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isTrue());
    status.set(200);
    delayMs.set(1300);
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isTrue());
    delayMs.set(0);
    response.set("{invalid");
    assertThatThrownBy(this::suggest)
        .isInstanceOf(CategorizationAiProvider.Failure.class)
        .satisfies(
            failure ->
                assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                    .isFalse());
    try (java.net.ServerSocket vacant = new java.net.ServerSocket(0)) {
      int port = vacant.getLocalPort();
      vacant.close();
      var disconnected =
          new CategorizationAiProvider(
              "test-key",
              "test-model",
              "AI_POLICY_V1",
              "http://127.0.0.1:" + port + "/v1/chat/completions",
              1000,
              mapper);
      assertThatThrownBy(
              () ->
                  disconnected.suggest(
                      new CategorizationAiProvider.Evidence(
                          "corner market", TransactionKind.EXPENSE, null, null)))
          .isInstanceOf(CategorizationAiProvider.Failure.class)
          .satisfies(
              failure ->
                  assertThat(((CategorizationAiProvider.Failure) failure).transientFailure())
                      .isTrue());
    }
  }

  private void suggest() throws Exception {
    provider.suggest(
        new CategorizationAiProvider.Evidence(
            "corner market", TransactionKind.EXPENSE, null, null));
  }

  private static String envelope(String content) {
    return "{\"model\":\"test-model\",\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":"
        + quote(content)
        + "}}]}";
  }

  private static String quote(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }
}
