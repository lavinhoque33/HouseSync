package com.housesync.household;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
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

/**
 * Household row-lock admission: while another transaction holds {@code FOR UPDATE} on a household,
 * a signed-in non-member gets the generic 404 at once on finance, lifecycle, and invitation routes
 * (no queueing behind the lock, no 503 after the 5s finance lock timeout), while current members
 * still serialize behind the lock.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class HouseholdLockAdmissionIT {

  private static final String PASSWORD = "correct horse battery staple 123!";
  private static final Duration PROMPT = Duration.ofSeconds(2);

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @DynamicPropertySource
  static void databaseProperties(DynamicPropertyRegistry registry) {
    registry.add("DB_HOST", POSTGRES::getHost);
    registry.add("DB_PORT", POSTGRES::getFirstMappedPort);
    registry.add("DB_NAME", POSTGRES::getDatabaseName);
    registry.add("DB_USER", POSTGRES::getUsername);
    registry.add("DB_PASSWORD", POSTGRES::getPassword);
  }

  @Autowired private com.housesync.identity.application.IdentityGrants grants;
  @Autowired private JdbcTemplate jdbc;
  @Autowired private DataSource dataSource;
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void nonMemberIsRejectedPromptlyWhileHouseholdRowIsLocked() throws Exception {
    Agent owner = signedInAgent("lock-owner");
    String householdId = createHousehold(owner, "Locked home");
    String ownerId = owner.userId();
    Agent outsider = signedInAgent("lock-outsider");

    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try {
        holdHouseholdLock(connection, householdId);

        assertPromptNotFound(
            () ->
                outsider.request(
                    "POST",
                    "/api/households/" + householdId + "/financial-accounts",
                    "{\"name\":\"Probe\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
                    UUID.randomUUID()));
        assertPromptNotFound(
            () ->
                outsider.request("POST", "/api/households/" + householdId + "/leave", null, null));
        assertPromptNotFound(
            () ->
                outsider.request(
                    "DELETE",
                    "/api/households/" + householdId + "/members/" + ownerId,
                    null,
                    null));
        assertPromptNotFound(() -> outsider.get("/api/households/" + householdId + "/invitations"));
        assertPromptNotFound(
            () ->
                outsider.request(
                    "POST", "/api/households/" + householdId + "/invitations", null, null));
      } finally {
        connection.rollback();
      }
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();
  }

  @Test
  void membersStillSerializeBehindTheHouseholdLock() throws Exception {
    Agent owner = signedInAgent("serial-owner");
    String householdId = createHousehold(owner, "Serialized home");
    Agent member = signedInAgent("serial-member");
    addMember(householdId, member.userId(), "MEMBER");

    ExecutorService pool = Executors.newFixedThreadPool(3);
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      Future<Resp> finance;
      Future<Resp> invitations;
      Future<Resp> leave;
      try {
        holdHouseholdLock(connection, householdId);
        finance =
            pool.submit(
                () ->
                    owner.request(
                        "POST",
                        "/api/households/" + householdId + "/financial-accounts",
                        "{\"name\":\"Queued\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
                        UUID.randomUUID()));
        invitations =
            pool.submit(() -> owner.get("/api/households/" + householdId + "/invitations"));
        leave =
            pool.submit(
                () ->
                    member.request(
                        "POST", "/api/households/" + householdId + "/leave", null, null));
        // All three member requests are queued on the row lock (well inside the 5s finance
        // timeout).
        awaitLockWaiters(3);
        assertThat(finance.isDone()).isFalse();
        assertThat(invitations.isDone()).isFalse();
        assertThat(leave.isDone()).isFalse();
      } finally {
        connection.rollback();
      }
      assertThat(finance.get(15, TimeUnit.SECONDS).status).isEqualTo(201);
      assertThat(invitations.get(15, TimeUnit.SECONDS).status).isEqualTo(200);
      assertThat(leave.get(15, TimeUnit.SECONDS).status).isEqualTo(204);
    } finally {
      pool.shutdownNow();
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(1);
  }

  private void holdHouseholdLock(Connection connection, String householdId) throws Exception {
    try (PreparedStatement lock =
        connection.prepareStatement("SELECT id FROM households WHERE id = ?::uuid FOR UPDATE")) {
      lock.setString(1, householdId);
      try (ResultSet rows = lock.executeQuery()) {
        assertThat(rows.next()).isTrue();
      }
    }
  }

  private void assertPromptNotFound(ThrowingRequest request) throws Exception {
    long started = System.nanoTime();
    Resp response = request.send();
    Duration elapsed = Duration.ofNanos(System.nanoTime() - started);
    assertThat(response.status).isEqualTo(404);
    assertThat(response.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(elapsed).isLessThan(PROMPT);
  }

  private void awaitLockWaiters(int expected) throws Exception {
    long deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
    Integer waiting = 0;
    while (System.nanoTime() < deadline) {
      waiting =
          jdbc.queryForObject(
              "SELECT COUNT(*) FROM pg_stat_activity"
                  + " WHERE datname = current_database() AND wait_event_type = 'Lock'",
              Integer.class);
      if (waiting != null && waiting >= expected) {
        return;
      }
      Thread.sleep(50);
    }
    throw new AssertionError("Expected " + expected + " lock waiters, saw " + waiting);
  }

  @FunctionalInterface
  private interface ThrowingRequest {
    Resp send() throws Exception;
  }

  private Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String email =
        tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    String enrollmentCode = grants.issue("ENROLLMENT", email).code();
    String registration =
        "{\"email\":\""
            + email
            + "\",\"password\":\""
            + PASSWORD
            + "\",\"enrollmentCode\":\""
            + enrollmentCode
            + "\"}";
    agent.csrfToken();
    assertThat(agent.request("POST", "/api/auth/register", registration, null).status)
        .isEqualTo(201);
    String login = "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
    assertThat(agent.request("POST", "/api/auth/login", login, null).status).isEqualTo(200);
    agent.csrfToken();
    return agent;
  }

  private String createHousehold(Agent agent, String name) throws Exception {
    Resp created = agent.request("POST", "/api/households", "{\"name\":\"" + name + "\"}", null);
    assertThat(created.status).isEqualTo(201);
    return created.json().path("id").asText();
  }

  private void addMember(String householdId, String userId, String role) {
    assertThat(
            jdbc.update(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?::uuid, ?::uuid, ?)",
                householdId,
                userId,
                role))
        .isEqualTo(1);
  }

  record Resp(int status, String body) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }
  }

  /** Local browser: own SESSION jar plus in-memory CSRF token. */
  class Agent {
    volatile String sessionCookie;
    volatile String csrfToken;
    String cachedUserId;

    void csrfToken() throws Exception {
      HttpResponse<String> response =
          client.send(
              withSession(
                      HttpRequest.newBuilder(
                              URI.create("http://localhost:" + port + "/api/auth/csrf"))
                          .timeout(Duration.ofSeconds(10))
                          .GET())
                  .build(),
              HttpResponse.BodyHandlers.ofString());
      remember(response);
      assertThat(response.statusCode()).isEqualTo(200);
      csrfToken = mapper.readTree(response.body()).path("token").asText();
    }

    String userId() throws Exception {
      if (cachedUserId == null) cachedUserId = get("/api/auth/me").json().path("id").asText();
      return cachedUserId;
    }

    Resp get(String path) throws Exception {
      return send(
          withSession(
              HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                  .timeout(Duration.ofSeconds(15))
                  .header("Accept", "application/json")
                  .GET()));
    }

    Resp request(String method, String path, String json, UUID idempotencyKey) throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(15))
              .header("Accept", "application/json")
              .header("X-CSRF-TOKEN", csrfToken)
              .method(
                  method,
                  json == null
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofString(json));
      if (json != null) builder.header("Content-Type", "application/json");
      if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey.toString());
      return send(withSession(builder));
    }

    private HttpRequest.Builder withSession(HttpRequest.Builder builder) {
      if (sessionCookie != null) builder.header("Cookie", "SESSION=" + sessionCookie);
      return builder;
    }

    private Resp send(HttpRequest.Builder builder) throws Exception {
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      remember(response);
      return new Resp(response.statusCode(), response.body());
    }

    private void remember(HttpResponse<String> response) {
      for (String setCookie : response.headers().allValues("Set-Cookie")) {
        String pair = setCookie.split(";", 2)[0];
        int separator = pair.indexOf('=');
        if (separator > 0 && pair.substring(0, separator).equals("SESSION")) {
          String value = pair.substring(separator + 1);
          sessionCookie = value.isEmpty() ? null : value;
        }
      }
    }
  }
}
