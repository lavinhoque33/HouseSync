package com.housesync.finance.settlement;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
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
class SettlementHttpIT {
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
  @Autowired PlatformTransactionManager transactionManager;
  final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  final ObjectMapper mapper = new ObjectMapper();

  record Result(int status, String body, String cacheControl) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }
  }

  class Agent {
    String cookie, csrf;

    Result send(String method, String path, String body) throws Exception {
      var request =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(15))
              .header("Accept", "application/json");
      if (cookie != null) request.header("Cookie", "SESSION=" + cookie);
      if (csrf != null) request.header("X-CSRF-TOKEN", csrf);
      if (body != null) request.header("Content-Type", "application/json");
      request.method(
          method,
          body == null
              ? HttpRequest.BodyPublishers.noBody()
              : HttpRequest.BodyPublishers.ofString(body));
      var response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
      for (String value : response.headers().allValues("Set-Cookie")) {
        String pair = value.split(";", 2)[0];
        if (pair.startsWith("SESSION=")) cookie = pair.substring(8);
      }
      return new Result(
          response.statusCode(),
          response.body(),
          response.headers().firstValue("Cache-Control").orElse(""));
    }

    Result get(String path) throws Exception {
      return send("GET", path, null);
    }

    Result post(String path, String body) throws Exception {
      return send("POST", path, body);
    }

    String id() throws Exception {
      return get("/api/auth/me").json().path("id").asText();
    }
  }

  Agent register() throws Exception {
    Agent agent = new Agent();
    agent.csrf = agent.get("/api/auth/csrf").json().path("token").asText();
    String email = "s" + UUID.randomUUID().toString().substring(0, 12) + "@example.test";
    String identity =
        "{\"email\":\"" + email + "\",\"password\":\"correct horse battery staple 123!\"}";
    String enrollmentCode = grants.issue("ENROLLMENT", email).code();
    String registration =
        "{\"email\":\""
            + email
            + "\",\"password\":\"correct horse battery staple 123!\",\"enrollmentCode\":\""
            + enrollmentCode
            + "\"}";
    assertThat(agent.post("/api/auth/register", registration).status()).isEqualTo(201);
    assertThat(agent.post("/api/auth/login", identity).status()).isEqualTo(200);
    agent.csrf = agent.get("/api/auth/csrf").json().path("token").asText();
    return agent;
  }

  String household(Agent owner) throws Exception {
    return owner
        .post("/api/households", "{\"name\":\"Settlement home\"}")
        .json()
        .path("id")
        .asText();
  }

  void join(String home, Agent member) throws Exception {
    jdbc.update(
        "INSERT INTO household_members (household_id,user_id,role) VALUES (?::uuid,?::uuid,'MEMBER')",
        home,
        member.id());
  }

  void payment(String home, Agent sender, Agent recipient, String amount, String currency)
      throws Exception {
    jdbc.update(
        "INSERT INTO external_repayments (id,household_id,sender_user_id,recipient_user_id,currency,amount,occurred_on,status,version,created_at,updated_at,confirmed_at) VALUES (?::uuid,?::uuid,?::uuid,?::uuid,?,?::numeric,'2026-09-20','CONFIRMED',1,now(),now(),now())",
        UUID.randomUUID().toString(),
        home,
        sender.id(),
        recipient.id(),
        currency,
        amount);
  }

  @Test
  void repaymentOnlyBalancesPendingCorrectionsAndReverseCredit() throws Exception {
    Agent sender = register(), recipient = register(), outsider = register();
    String home = household(sender);
    join(home, recipient);
    String base = "/api/households/" + home;
    String suggestions = base + "/settlement-suggestions?currency=KWD";
    assertThat(outsider.get(suggestions).status()).isEqualTo(404);
    assertThat(sender.get(base + "/member-balances").json().path("currencies").size()).isZero();
    var empty = sender.get(suggestions);
    assertThat(empty.json().path("items").size()).isZero();
    assertThat(empty.json().path("residuals").path("currentDebtAfterPlan").asText())
        .isEqualTo("0.000");
    payment(home, sender, recipient, "0.003", "KWD");
    var balances = recipient.get(base + "/member-balances");
    assertThat(balances.cacheControl()).contains("no-store");
    assertThat(balances.json().path("currencies").get(0).path("currency").asText())
        .isEqualTo("KWD");
    var response = sender.get(suggestions);
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.cacheControl()).contains("no-store");
    assertThat(response.json().path("items").get(0).path("senderUserId").asText())
        .isEqualTo(recipient.id());
    assertThat(response.json().path("items").get(0).path("money").path("amount").asText())
        .isEqualTo("0.003");
    assertThat(response.body()).doesNotContain("accountId", "occurredOn", "repaymentId");
    jdbc.update(
        "UPDATE external_repayments SET amendment_action='REPLACE',amendment_proposer=?::uuid,amendment_amount=0.006,amendment_occurred_on='2026-09-20',amendment_created_at=now() WHERE household_id=?::uuid",
        sender.id(),
        home);
    assertThat(sender.get(suggestions).json().path("snapshot").asText())
        .isEqualTo(response.json().path("snapshot").asText());
    jdbc.update(
        "UPDATE external_repayments SET amount=0.006,amendment_action=NULL,amendment_proposer=NULL,amendment_amount=NULL,amendment_occurred_on=NULL,amendment_created_at=NULL WHERE household_id=?::uuid",
        home);
    assertThat(sender.get(suggestions).json().path("snapshot").asText())
        .isNotEqualTo(response.json().path("snapshot").asText());
    jdbc.update(
        "DELETE FROM household_members WHERE household_id=?::uuid AND user_id=?::uuid",
        home,
        recipient.id());
    var departed = sender.get(suggestions).json();
    assertThat(departed.path("items").size()).isZero();
    assertThat(departed.path("residuals").path("currentCreditAfterPlan").asText())
        .isEqualTo("0.006");
    assertThat(departed.path("residuals").path("departedDebt").asText()).isEqualTo("0.006");
    join(home, recipient);
    assertThat(sender.get(suggestions).json().path("items").size()).isEqualTo(1);
    jdbc.update(
        "UPDATE external_repayments SET status='VOIDED',version=3,voided_at=now() WHERE household_id=?::uuid",
        home);
    assertThat(sender.get(base + "/member-balances").json().path("currencies").size()).isZero();
  }

  @Test
  void paginationCursorValidationAndStaleness() throws Exception {
    Agent owner = register();
    String home = household(owner);
    String base = "/api/households/" + home + "/settlement-suggestions?currency=JPY";
    for (int i = 0; i < 103; i++) {
      Agent member = register();
      join(home, member);
      payment(home, owner, member, "1", "JPY");
    }
    Result first = owner.get(base + "&limit=100");
    assertThat(first.status()).as(first.body()).isEqualTo(200);
    assertThat(first.json().path("items").size()).isEqualTo(100);
    String cursor = first.json().path("nextCursor").asText();
    assertThat(cursor).isNotEmpty();
    Result second = owner.get(base + "&limit=100&cursor=" + cursor);
    assertThat(second.json().path("items").size()).isEqualTo(3);
    assertThat(second.json().path("nextCursor").isNull()).isTrue();
    assertThat(owner.get(base + "&limit=100&cursor=" + cursor).body()).isEqualTo(second.body());
    assertThat(owner.get(base + "&limit=0").status()).isEqualTo(400);
    assertThat(owner.get(base + "&limit=101").status()).isEqualTo(400);
    assertThat(owner.get(base + "&currency=USD").status()).isEqualTo(400);
    assertThat(owner.get(base + "&unexpected=1").status()).isEqualTo(400);
    assertThat(owner.get(base + "&cursor=" + "a".repeat(1025)).status()).isEqualTo(400);
    assertThat(owner.get(base + "&cursor=%25%25%25").status()).isEqualTo(400);
    String outOfRange =
        Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(
                ("1:" + first.json().path("snapshot").asText() + ":JPY:999999")
                    .getBytes(StandardCharsets.US_ASCII));
    assertThat(owner.get(base + "&cursor=" + outOfRange).status()).isEqualTo(400);
    String negative =
        Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(
                ("1:" + first.json().path("snapshot").asText() + ":JPY:-1")
                    .getBytes(StandardCharsets.US_ASCII));
    assertThat(owner.get(base + "&cursor=" + negative).status()).isEqualTo(400);
    jdbc.update(
        "UPDATE external_repayments SET amount=2 WHERE household_id=?::uuid AND id=(SELECT id FROM external_repayments WHERE household_id=?::uuid ORDER BY id LIMIT 1)",
        home,
        home);
    assertThat(owner.get(base + "&cursor=" + cursor).json().path("code").asText())
        .isEqualTo("SETTLEMENT_SNAPSHOT_STALE");
  }

  @Test
  void concurrentMembershipAndPaymentMutationProducesOneLockedSnapshot() throws Exception {
    Agent owner = register(), recipient = register();
    String home = household(owner);
    join(home, recipient);
    payment(home, owner, recipient, "1", "JPY");
    String recipientId = recipient.id();
    String path = "/api/households/" + home + "/settlement-suggestions?currency=JPY";
    String initial = owner.get(path).json().path("snapshot").asText();
    try (var pool = Executors.newSingleThreadExecutor()) {
      CountDownLatch started = new CountDownLatch(1);
      var transaction = new TransactionTemplate(transactionManager);
      var request =
          transaction.execute(
              ignored -> {
                jdbc.queryForObject(
                    "SELECT id FROM households WHERE id=?::uuid FOR UPDATE", String.class, home);
                var future =
                    pool.submit(
                        () -> {
                          started.countDown();
                          return owner.get(path);
                        });
                try {
                  assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException interrupted) {
                  Thread.currentThread().interrupt();
                  throw new AssertionError(interrupted);
                }
                jdbc.update(
                    "UPDATE external_repayments SET amount=2 WHERE household_id=?::uuid", home);
                jdbc.update(
                    "DELETE FROM household_members WHERE household_id=?::uuid AND user_id=?::uuid",
                    home,
                    recipientId);
                return future;
              });
      Result current = request.get(15, TimeUnit.SECONDS);
      assertThat(current.status()).isEqualTo(200);
      assertThat(current.json().path("snapshot").asText()).isNotEqualTo(initial);
      assertThat(current.json().path("items").size()).isZero();
      assertThat(current.json().path("residuals").path("departedDebt").asText()).isEqualTo("2");
      assertThat(current.json().path("residuals").path("currentCreditAfterPlan").asText())
          .isEqualTo("2");
    }
  }
}
