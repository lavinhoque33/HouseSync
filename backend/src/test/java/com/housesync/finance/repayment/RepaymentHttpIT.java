package com.housesync.finance.repayment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class RepaymentHttpIT {
  @Container
  static final PostgreSQLContainer postgres =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @DynamicPropertySource
  static void db(DynamicPropertyRegistry registry) {
    registry.add("DB_HOST", postgres::getHost);
    registry.add("DB_PORT", postgres::getFirstMappedPort);
    registry.add("DB_NAME", postgres::getDatabaseName);
    registry.add("DB_USER", postgres::getUsername);
    registry.add("DB_PASSWORD", postgres::getPassword);
  }

  @Autowired JdbcTemplate jdbc;
  @Autowired com.housesync.identity.application.IdentityGrants grants;
  @LocalServerPort int port;
  final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  final ObjectMapper mapper = new ObjectMapper();

  record Result(int status, String text) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(text);
    }
  }

  class Agent {
    String cookie, csrf;

    Result send(String method, String path, String body, String key, boolean csrfHeader)
        throws Exception {
      var request =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(15))
              .header("Accept", "application/json");
      if (cookie != null) request.header("Cookie", "SESSION=" + cookie);
      if (csrfHeader && csrf != null) request.header("X-CSRF-TOKEN", csrf);
      if (key != null) request.header("Idempotency-Key", key);
      if (body != null) request.header("Content-Type", "application/json");
      request.method(
          method,
          body == null
              ? HttpRequest.BodyPublishers.noBody()
              : HttpRequest.BodyPublishers.ofString(body));
      var response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
      for (String header : response.headers().allValues("Set-Cookie")) {
        String pair = header.split(";", 2)[0];
        if (pair.startsWith("SESSION=")) cookie = pair.substring(8);
      }
      return new Result(response.statusCode(), response.body());
    }

    String csrf() throws Exception {
      Result result = send("GET", "/api/auth/csrf", null, null, false);
      assertThat(result.status()).isEqualTo(200);
      csrf = result.json().path("token").asText();
      return csrf;
    }

    Result post(String path, String body, String key) throws Exception {
      return send("POST", path, body, key, true);
    }

    Result get(String path) throws Exception {
      return send("GET", path, null, null, false);
    }

    String id() throws Exception {
      return get("/api/auth/me").json().path("id").asText();
    }
  }

  Agent register(String tag) throws Exception {
    Agent a = new Agent();
    a.csrf();
    String email = tag + UUID.randomUUID().toString().substring(0, 8) + "@example.test";
    String identity =
        "{\"email\":\"" + email + "\",\"password\":\"correct horse battery staple 123!\"}";
    String enrollmentCode = grants.issue("ENROLLMENT", email).code();
    String registration =
        "{\"email\":\""
            + email
            + "\",\"password\":\"correct horse battery staple 123!\",\"enrollmentCode\":\""
            + enrollmentCode
            + "\"}";
    assertThat(a.post("/api/auth/register", registration, null).status()).isEqualTo(201);
    assertThat(a.post("/api/auth/login", identity, null).status()).isEqualTo(200);
    a.csrf();
    return a;
  }

  String home(Agent owner) throws Exception {
    Result created = owner.post("/api/households", "{\"name\":\"Repayment home\"}", null);
    assertThat(created.status()).isEqualTo(201);
    return created.json().path("id").asText();
  }

  void join(String home, Agent member) throws Exception {
    jdbc.update(
        "INSERT INTO household_members (household_id,user_id,role) VALUES (?::uuid,?::uuid,'MEMBER')",
        home,
        member.id());
  }

  String body(Agent recipient, String amount) throws Exception {
    return "{\"recipientUserId\":\""
        + recipient.id()
        + "\",\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\"USD\"},\"occurredOn\":\"2026-09-20\"}";
  }

  @Test
  void consentReplayPartyPrivacyAmendmentsAndAtomicEvents() throws Exception {
    Agent sender = register("repay-s"),
        recipient = register("repay-r"),
        other = register("repay-o");
    String home = home(sender);
    join(home, recipient);
    join(home, other);
    String path = "/api/households/" + home + "/repayments";
    String key = UUID.randomUUID().toString(), body = body(recipient, "3.00");
    Result first = sender.post(path, body, key);
    assertThat(first.status()).as(first.text()).isEqualTo(201);
    String id = first.json().path("id").asText();
    String detail = path + "/" + id;
    assertThat(first.json().path("version").asInt()).isZero();
    assertThat(first.json().path("allowedActions").get(0).asText()).isEqualTo("CANCEL");
    assertThat(sender.post(path, body(recipient, "3"), key).status()).isEqualTo(200);
    assertThat(sender.post(path, body(recipient, "4.00"), key).json().path("code").asText())
        .isEqualTo("IDEMPOTENCY_CONFLICT");
    assertThat(other.get(detail).json().path("code").asText()).isEqualTo("REPAYMENT_NOT_FOUND");
    assertThat(other.get(detail + "/events").status()).isEqualTo(404);
    assertThat(other.get(path).json().path("items").size()).isZero();
    assertThat(other.get(path).json().path("hasMore").asBoolean()).isFalse();
    assertThat(
            sender
                .get(path + "?status=PENDING&currency=USD&from=2026-09-20&to=2026-09-21")
                .json()
                .path("items")
                .size())
        .isEqualTo(1);
    assertThat(sender.get(path + "?status=CONFIRMED").json().path("items").size()).isZero();
    assertThat(sender.get(path + "?limit=1&limit=2").status()).isEqualTo(400);
    assertThat(sender.get(path + "?offset=10001").status()).isEqualTo(400);
    assertThat(sender.get(path + "?unexpected=x").status()).isEqualTo(400);
    assertThat(
            other
                .post(
                    detail + "/decision", "{\"expectedVersion\":0,\"decision\":\"CONFIRM\"}", null)
                .status())
        .isEqualTo(404);
    assertThat(
            sender
                .post(
                    detail + "/decision", "{\"expectedVersion\":0,\"decision\":\"CONFIRM\"}", null)
                .json()
                .path("code")
                .asText())
        .isEqualTo("REPAYMENT_CONFLICT");
    Result accepted =
        recipient.post(
            detail + "/decision", "{\"expectedVersion\":0,\"decision\":\"CONFIRM\"}", null);
    assertThat(accepted.status()).as(accepted.text()).isEqualTo(200);
    assertThat(accepted.json().path("confirmedAt").isNull()).isFalse();
    assertThat(
            sender
                .post(detail + "/decision", "{\"expectedVersion\":0,\"decision\":\"CANCEL\"}", null)
                .status())
        .isEqualTo(409);
    Result proposed =
        sender.post(
            detail + "/amendment",
            "{\"expectedVersion\":1,\"action\":\"REPLACE\",\"money\":{\"amount\":\"4.00\",\"currency\":\"USD\"},\"occurredOn\":\"2026-09-21\"}",
            null);
    assertThat(proposed.status()).as(proposed.text()).isEqualTo(200);
    assertThat(proposed.json().path("money").path("amount").asText()).isEqualTo("3.00");
    assertThat(proposed.json().path("pendingAmendment").path("money").path("amount").asText())
        .isEqualTo("4.00");
    assertThat(
            sender
                .post(
                    detail + "/amendment/decision",
                    "{\"expectedVersion\":2,\"decision\":\"CONFIRM\"}",
                    null)
                .status())
        .isEqualTo(409);
    Result replaced =
        recipient.post(
            detail + "/amendment/decision",
            "{\"expectedVersion\":2,\"decision\":\"CONFIRM\"}",
            null);
    assertThat(replaced.status()).isEqualTo(200);
    assertThat(replaced.json().path("money").path("amount").asText()).isEqualTo("4.00");
    assertThat(replaced.json().path("version").asInt()).isEqualTo(3);
    assertThat(sender.get(path + "?status=PENDING").json().path("items").size()).isZero();
    assertThat(
            sender
                .get(path + "?status=CONFIRMED&from=2026-09-21&to=2026-09-22")
                .json()
                .path("items")
                .size())
        .isEqualTo(1);
    assertThat(
            sender
                .get(path + "?status=CONFIRMED&from=2026-09-20&to=2026-09-21")
                .json()
                .path("items")
                .size())
        .isZero();
    assertThat(
            sender
                .get(detail + "/events?offset=2&limit=2")
                .json()
                .path("items")
                .get(0)
                .path("eventType")
                .asText())
        .isEqualTo("AMENDMENT_PROPOSED");
    assertThat(
            sender
                .get(detail + "/events?offset=3")
                .json()
                .path("items")
                .get(0)
                .path("money")
                .path("amount")
                .asText())
        .isEqualTo("4.00");
    assertThat(sender.get(detail + "/events?limit=2").json().path("hasMore").asBoolean()).isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM external_repayment_events WHERE repayment_id=?::uuid",
                Integer.class,
                id))
        .isEqualTo(4);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM external_repayment_idempotency_keys WHERE repayment_id=?::uuid",
                Integer.class,
                id))
        .isEqualTo(1);
  }

  @Test
  void currentMembershipStrictInputAbortAndConcurrentSameKey() throws Exception {
    Agent sender = register("race-s"), recipient = register("race-r");
    String home = home(sender);
    join(home, recipient);
    String path = "/api/households/" + home + "/repayments";
    String key = UUID.randomUUID().toString(), body = body(recipient, "0.01");
    assertThat(
            sender
                .post(path, body.replace("\"occurredOn\"", "\"unknown\":2,\"occurredOn\""), key)
                .status())
        .isEqualTo(400);
    assertThat(
            sender
                .post(
                    path,
                    body.replace("\"occurredOn\"", "\"occurredOn\":\"2020-01-01\",\"occurredOn\""),
                    key)
                .status())
        .isEqualTo(400);
    assertThat(sender.send("POST", path, body, key, false).status()).isEqualTo(403);
    jdbc.update(
        "DELETE FROM household_members WHERE household_id=?::uuid AND user_id=?::uuid",
        home,
        recipient.id());
    assertThat(sender.post(path, body, key).status()).isEqualTo(400);
    join(home, recipient);
    try (var pool = Executors.newFixedThreadPool(2)) {
      CountDownLatch start = new CountDownLatch(1);
      var a =
          pool.submit(
              () -> {
                start.await();
                return sender.post(path, body, key);
              });
      var b =
          pool.submit(
              () -> {
                start.await();
                return sender.post(path, body, key);
              });
      start.countDown();
      Result left = a.get(), right = b.get();
      assertThat(java.util.Set.of(left.status(), right.status()))
          .containsExactlyInAnyOrder(201, 200);
      assertThat(left.json().path("id").asText()).isEqualTo(right.json().path("id").asText());
      String detail = path + "/" + left.json().path("id").asText();
      jdbc.update(
          "DELETE FROM household_members WHERE household_id=?::uuid AND user_id=?::uuid",
          home,
          recipient.id());
      assertThat(sender.post(path, body, key).status()).isEqualTo(200);
      assertThat(recipient.get(detail).status()).isEqualTo(404);
      assertThat(
              sender
                  .post(
                      detail + "/decision", "{\"expectedVersion\":0,\"decision\":\"CANCEL\"}", null)
                  .status())
          .isEqualTo(200);
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM external_repayment_events WHERE repayment_id=?::uuid",
                  Integer.class,
                  left.json().path("id").asText()))
          .isEqualTo(2);
    }
  }

  @Test
  void schemaRejectsInvalidMoneyAndImmutableEventMutation() throws Exception {
    Agent sender = register("schema-s"), recipient = register("schema-r");
    String home = home(sender);
    join(home, recipient);
    String path = "/api/households/" + home + "/repayments";
    String id =
        sender
            .post(path, body(recipient, "2.00"), UUID.randomUUID().toString())
            .json()
            .path("id")
            .asText();
    assertThatThrownBy(
            () -> jdbc.update("UPDATE external_repayments SET amount=1.234 WHERE id=?::uuid", id))
        .hasMessageContaining("repayment_money");
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "UPDATE external_repayments SET currency='JPY',amount=1.5 WHERE id=?::uuid",
                    id))
        .hasMessageContaining("repayment_money");
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "UPDATE external_repayments SET sender_user_id=recipient_user_id WHERE id=?::uuid",
                    id))
        .hasMessageContaining("repayment_distinct_parties");
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "UPDATE external_repayments SET amendment_action='REPLACE' WHERE id=?::uuid",
                    id))
        .hasMessageContaining("repayment_amendment");
    assertThatThrownBy(
            () ->
                jdbc.update(
                    "UPDATE external_repayment_events SET amount=9 WHERE repayment_id=?::uuid", id))
        .hasMessageContaining("repayment events are immutable");
    assertThatThrownBy(
            () ->
                jdbc.update("DELETE FROM external_repayment_events WHERE repayment_id=?::uuid", id))
        .hasMessageContaining("repayment events are immutable");
    assertThat(sender.get(path + "/" + id).json().path("money").path("amount").asText())
        .isEqualTo("2.00");
  }

  @Test
  void departedRecipientMustRejoinBeforeConfirmingAndClosedStateStaysTerminal() throws Exception {
    Agent sender = register("lifecycle-s"), recipient = register("lifecycle-r");
    String home = home(sender);
    join(home, recipient);
    String path = "/api/households/" + home + "/repayments";
    String id =
        sender
            .post(path, body(recipient, "2.00"), UUID.randomUUID().toString())
            .json()
            .path("id")
            .asText();
    jdbc.update(
        "DELETE FROM household_members WHERE household_id=?::uuid AND user_id=?::uuid",
        home,
        recipient.id());
    assertThat(sender.get(path + "/" + id).json().path("allowedActions").get(0).asText())
        .isEqualTo("CANCEL");
    assertThat(
            recipient
                .post(
                    path + "/" + id + "/decision",
                    "{\"expectedVersion\":0,\"decision\":\"CONFIRM\"}",
                    null)
                .status())
        .isEqualTo(404);
    join(home, recipient);
    assertThat(
            recipient
                .post(
                    path + "/" + id + "/decision",
                    "{\"expectedVersion\":0,\"decision\":\"CONFIRM\"}",
                    null)
                .status())
        .isEqualTo(200);
    String confirmed = path + "/" + id;
    Result voidProposal =
        sender.post(confirmed + "/amendment", "{\"expectedVersion\":1,\"action\":\"VOID\"}", null);
    assertThat(voidProposal.status()).isEqualTo(200);
    assertThat(voidProposal.json().path("pendingAmendment").path("money").isNull()).isTrue();
    Result voided =
        recipient.post(
            confirmed + "/amendment/decision",
            "{\"expectedVersion\":2,\"decision\":\"CONFIRM\"}",
            null);
    assertThat(voided.status()).isEqualTo(200);
    assertThat(voided.json().path("status").asText()).isEqualTo("VOIDED");
    assertThat(voided.json().path("voidedAt").isNull()).isFalse();
    assertThat(
            sender
                .post(confirmed + "/amendment", "{\"expectedVersion\":3,\"action\":\"VOID\"}", null)
                .json()
                .path("code")
                .asText())
        .isEqualTo("REPAYMENT_CONFLICT");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM external_repayments WHERE household_id=?::uuid AND status='CONFIRMED'",
                Integer.class,
                home))
        .isZero();
  }

  @Test
  void reportingZoneDateBoundRecheckedOnConsentButNeverOnReplay() throws Exception {
    Agent sender = register("date-s"), recipient = register("date-r");
    String home = home(sender);
    join(home, recipient);
    String path = "/api/households/" + home + "/repayments";
    jdbc.update(
        "UPDATE households SET reporting_time_zone='Pacific/Kiritimati' WHERE id=?::uuid", home);
    String today = java.time.LocalDate.now(java.time.ZoneId.of("Pacific/Kiritimati")).toString();
    String assertion = body(recipient, "1.00").replace("2026-09-20", today);
    String key = UUID.randomUUID().toString();
    Result created = sender.post(path, assertion, key);
    assertThat(created.status()).as(created.text()).isEqualTo(201);
    String id = created.json().path("id").asText();
    jdbc.update("UPDATE households SET reporting_time_zone='Etc/GMT+12' WHERE id=?::uuid", home);
    // In the UTC-12 reporting zone, the same calendar day is still tomorrow.
    assertThat(sender.post(path, assertion, key).status()).isEqualTo(200);
    assertThat(
            recipient
                .post(
                    path + "/" + id + "/decision",
                    "{\"expectedVersion\":0,\"decision\":\"CONFIRM\"}",
                    null)
                .json()
                .path("code")
                .asText())
        .isEqualTo("VALIDATION_FAILED");
    assertThat(sender.get(path + "/" + id).json().path("status").asText()).isEqualTo("PENDING");
    assertThat(
            sender
                .post(
                    path + "/" + id + "/decision",
                    "{\"expectedVersion\":0,\"decision\":\"CANCEL\"}",
                    null)
                .status())
        .isEqualTo(200);
    assertThat(sender.post(path, assertion, key).status()).isEqualTo(200);
    assertThat(sender.get(path + "/" + id + "/events").json().path("items").size()).isEqualTo(2);
  }
}
