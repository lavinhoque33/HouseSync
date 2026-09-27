package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Shared PostgreSQL HTTP harness for connected finance: session/CSRF agents, household setup, and
 * link/connection helpers. Every test uses isolated users and household-scoped assertions; the
 * deterministic fake provider supplies stable identities without live accounts.
 *
 * <p>Each concrete IT class owns its container (declared per class, not shared): a JVM-wide shared
 * container starts during test discovery and destabilizes full-suite runs.
 */
abstract class ConnectedFinanceITSupport {

  static final String PASSWORD = "correct horse battery staple 123!";

  static void registerContainerProperties(
      DynamicPropertyRegistry registry, PostgreSQLContainer container) {
    registry.add("DB_HOST", container::getHost);
    registry.add("DB_PORT", container::getFirstMappedPort);
    registry.add("DB_NAME", container::getDatabaseName);
    registry.add("DB_USER", container::getUsername);
    registry.add("DB_PASSWORD", container::getPassword);
  }

  @Autowired protected com.housesync.identity.application.IdentityGrants grants;
  @Autowired protected JdbcTemplate jdbc;
  @LocalServerPort protected int port;

  protected final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  protected final ObjectMapper mapper = new ObjectMapper();

  protected Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String email =
        tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    String enrollmentCode = grants.issue("ENROLLMENT", email).code();
    String registration = registrationJson(email, enrollmentCode);
    assertThat(agent.post("/api/auth/register", registration, agent.csrfToken()).status())
        .isEqualTo(201);
    assertThat(agent.post("/api/auth/login", identityJson(email), agent.csrfToken()).status())
        .isEqualTo(200);
    agent.csrfToken();
    return agent;
  }

  protected String createHousehold(Agent agent, String name) throws Exception {
    Resp response = agent.post("/api/households", "{\"name\":\"" + name + "\"}", agent.csrfToken);
    assertThat(response.status()).isEqualTo(201);
    return response.json().path("id").asText();
  }

  protected void addMember(String householdId, String userId, String role) {
    assertThat(
            jdbc.update(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?::uuid, ?::uuid, ?)",
                householdId,
                userId,
                role))
        .isEqualTo(1);
  }

  protected Resp startLink(Agent agent, String householdId, UUID key) throws Exception {
    return agent.request(
        "POST",
        "/api/households/" + householdId + "/connection-link-attempts",
        "{}",
        agent.csrfToken,
        key);
  }

  protected Resp completeLink(
      Agent agent, String householdId, String attemptId, UUID key, String body) throws Exception {
    return agent.request(
        "POST",
        "/api/households/" + householdId + "/connection-link-attempts/" + attemptId + "/complete",
        body,
        agent.csrfToken,
        key);
  }

  /** Linked connection plus the local IDs a test needs to drive sync and admission. */
  protected record ConnectedLink(
      String connectionId,
      String seed,
      String accessToken,
      String checkingMappingId,
      String savingsMappingId,
      String checkingAccountId,
      String savingsAccountId) {

    String remoteCheckingId() {
      return "fake-remote-checking-" + seed;
    }

    String remoteSavingsId() {
      return "fake-remote-savings-" + seed;
    }
  }

  /** Links and selects the requested discovered accounts through the real HTTP surface. */
  protected ConnectedLink linkAndSelect(
      Agent owner, String householdId, boolean selectChecking, boolean selectSavings)
      throws Exception {
    Resp started = startLink(owner, householdId, UUID.randomUUID());
    assertThat(started.status()).isEqualTo(201);
    String attemptId = started.json().path("id").asText();
    String publicToken =
        com.housesync.finance.connection.plaid.FakePlaidAdapter.publicTokenFor(
            UUID.fromString(attemptId));
    Resp completed =
        completeLink(
            owner,
            householdId,
            attemptId,
            UUID.randomUUID(),
            "{\"publicToken\":\"" + publicToken + "\"}");
    assertThat(completed.status()).isEqualTo(202);
    String connectionId = completed.json().path("connectionId").asText();

    Resp listed = owner.get("/api/households/" + householdId + "/financial-connections");
    assertThat(listed.status()).isEqualTo(200);
    int version = -1;
    for (JsonNode item : listed.json().path("items")) {
      if (connectionId.equals(item.path("id").asText())) {
        version = item.path("version").asInt();
      }
    }
    assertThat(version).isGreaterThanOrEqualTo(0);

    Resp accounts =
        owner.get(
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/accounts");
    assertThat(accounts.status()).isEqualTo(200);
    String checkingMapping = null;
    String savingsMapping = null;
    for (JsonNode item : accounts.json().path("items")) {
      if ("CHECKING".equals(item.path("kind").asText())) {
        checkingMapping = item.path("mappingId").asText();
      } else if ("SAVINGS".equals(item.path("kind").asText())) {
        savingsMapping = item.path("mappingId").asText();
      }
    }
    assertThat(checkingMapping).isNotNull();
    assertThat(savingsMapping).isNotNull();

    StringBuilder ids = new StringBuilder();
    if (selectChecking) {
      ids.append('"').append(checkingMapping).append('"');
    }
    if (selectSavings) {
      if (ids.length() > 0) ids.append(',');
      ids.append('"').append(savingsMapping).append('"');
    }
    Resp selected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":" + version + ",\"accountMappingIds\":[" + ids + "]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(selected.status()).isEqualTo(200);
    String checkingAccount = null;
    String savingsAccount = null;
    for (JsonNode account : selected.json().path("accounts")) {
      if ("CHECKING".equals(account.path("kind").asText())) {
        checkingAccount = account.path("id").asText();
      } else if ("SAVINGS".equals(account.path("kind").asText())) {
        savingsAccount = account.path("id").asText();
      }
    }
    String seed = publicToken.substring("fake-public-".length());
    return new ConnectedLink(
        connectionId,
        seed,
        "fake-access-" + seed,
        checkingMapping,
        savingsMapping,
        checkingAccount,
        savingsAccount);
  }

  /** Current connection version from the owner-scoped detail endpoint. */
  protected int liveConnectionVersion(Agent owner, String householdId, String connectionId)
      throws Exception {
    Resp response =
        owner.get("/api/households/" + householdId + "/financial-connections/" + connectionId);
    assertThat(response.status()).isEqualTo(200);
    return response.json().path("version").asInt();
  }

  /** Registration payload: the enrollment code is recipient-bound and single-use. */
  protected static String registrationJson(String email, String enrollmentCode) {
    return "{\"email\":\""
        + email
        + "\",\"password\":\""
        + PASSWORD
        + "\",\"enrollmentCode\":\""
        + enrollmentCode
        + "\"}";
  }

  protected static String identityJson(String email) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
  }

  protected record Resp(int status, String body, java.net.http.HttpHeaders headers) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }

    String cacheControl() {
      return headers.firstValue("Cache-Control").orElse("");
    }
  }

  protected class Agent {
    String sessionCookie;
    String csrfToken;
    String cachedUserId;

    String csrfToken() throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/csrf"))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      addSession(builder);
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      assertThat(response.statusCode()).isEqualTo(200);
      csrfToken = mapper.readTree(response.body()).path("token").asText();
      return csrfToken;
    }

    String userId() throws Exception {
      if (cachedUserId == null) cachedUserId = get("/api/auth/me").json().path("id").asText();
      return cachedUserId;
    }

    Resp get(String path) throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      addSession(builder);
      return send(builder.build());
    }

    Resp post(String path, String json, String csrf) throws Exception {
      return request("POST", path, json, csrf, null);
    }

    Resp request(String method, String path, String json, String csrf, UUID idempotencyKey)
        throws Exception {
      return raw(
          method,
          path,
          json,
          csrf,
          idempotencyKey == null ? null : idempotencyKey.toString(),
          json == null ? null : "application/json");
    }

    Resp raw(
        String method,
        String path,
        String json,
        String csrf,
        String idempotencyKey,
        String contentType)
        throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(15))
              .header("Accept", "application/json")
              .method(
                  method,
                  json == null
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofString(json));
      if (contentType != null) builder.header("Content-Type", contentType);
      if (csrf != null) builder.header("X-CSRF-TOKEN", csrf);
      if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
      addSession(builder);
      return send(builder.build());
    }

    private Resp send(HttpRequest request) throws Exception {
      HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      return new Resp(response.statusCode(), response.body(), response.headers());
    }

    private void addSession(HttpRequest.Builder builder) {
      if (sessionCookie != null) builder.header("Cookie", "SESSION=" + sessionCookie);
    }

    private void rememberCookies(HttpResponse<String> response) {
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
