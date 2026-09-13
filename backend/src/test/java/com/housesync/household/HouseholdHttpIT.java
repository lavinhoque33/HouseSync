package com.housesync.household;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Household HTTP behavior against real PostgreSQL over HTTP with real
 * registration/login/session/CSRF flows: creation, membership-scoped reads, isolation, forged and
 * malformed input, validation boundaries, duplicate names, and concurrent creation.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@Testcontainers
class HouseholdHttpIT {

  static final String PASSWORD = "correct horse battery staple 123!";

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

  @Autowired private JdbcTemplate jdbc;
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void createReturnsOwnerHouseholdWithSafeDto() throws Exception {
    Agent agent = signedInAgent("create");
    Resp created = agent.post("/api/households", "{\"name\":\"Elm Street home\"}", agent.csrfToken);

    assertThat(created.status).isEqualTo(201);
    JsonNode body = created.json();
    assertThat(body.propertyNames()).containsExactlyInAnyOrder("id", "name", "role", "createdAt");
    assertThat(body.path("id").asText()).isNotBlank();
    UUID.fromString(body.path("id").asText());
    assertThat(body.path("name").asText()).isEqualTo("Elm Street home");
    assertThat(body.path("role").asText()).isEqualTo("OWNER");
    assertThat(Instant.parse(body.path("createdAt").asText()))
        .isBefore(Instant.now().plusSeconds(60));
    assertThat(created.body).doesNotContain("passwordHash", "ownerId", "userId", "members");
    assertThat(created.cacheControl()).contains("no-store");

    String actorId = agent.me().json().path("id").asText();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid"
                    + " AND user_id = ?::uuid AND role = 'OWNER'",
                Integer.class,
                body.path("id").asText(),
                actorId))
        .isEqualTo(1);
  }

  @Test
  void listStartsEmptyThenReturnsMembershipScopedOrdering() throws Exception {
    Agent agent = signedInAgent("list");
    assertThat(agent.get("/api/households").json().path("households").size()).isEqualTo(0);

    List<String> ids = new ArrayList<>();
    for (String name : List.of("Cedar", "Elm", "Birch")) {
      Resp created = agent.post("/api/households", "{\"name\":\"" + name + "\"}", agent.csrfToken);
      assertThat(created.status).isEqualTo(201);
      ids.add(created.json().path("id").asText());
    }

    JsonNode listed = agent.get("/api/households").json();
    assertThat(listed.propertyNames()).containsExactly("households");
    assertThat(listed.path("households").size()).isEqualTo(3);
    // Server ordering is createdAt then id: the response must already be sorted.
    List<String> actualOrder = new ArrayList<>();
    for (JsonNode node : listed.path("households")) {
      actualOrder.add(node.path("id").asText());
    }
    assertThat(actualOrder).containsExactlyInAnyOrderElementsOf(ids);
    for (int index = 1; index < listed.path("households").size(); index++) {
      JsonNode previous = listed.path("households").get(index - 1);
      JsonNode current = listed.path("households").get(index);
      int instantOrder =
          Instant.parse(previous.path("createdAt").asText())
              .compareTo(Instant.parse(current.path("createdAt").asText()));
      assertThat(instantOrder).isLessThanOrEqualTo(0);
      if (instantOrder == 0) {
        assertThat(
                UUID.fromString(previous.path("id").asText())
                    .compareTo(UUID.fromString(current.path("id").asText())))
            .isLessThan(0);
      }
    }
  }

  @Test
  void detailIsVisibleToMembersOnlyWithIndistinguishableNotFound() throws Exception {
    Agent owner = signedInAgent("owner");
    String householdId =
        owner
            .post("/api/households", "{\"name\":\"Elm Street home\"}", owner.csrfToken)
            .json()
            .path("id")
            .asText();

    Resp detail = owner.get("/api/households/" + householdId);
    assertThat(detail.status).isEqualTo(200);
    assertThat(detail.json().path("role").asText()).isEqualTo("OWNER");

    Agent stranger = signedInAgent("stranger");
    Resp nonMember = stranger.get("/api/households/" + householdId);
    Resp missing = stranger.get("/api/households/" + UUID.randomUUID());
    for (Resp denied : List.of(nonMember, missing)) {
      assertThat(denied.status).isEqualTo(404);
      assertThat(denied.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
      assertThat(denied.json().path("correlationId").asText()).isNotBlank();
    }
    // Missing and non-member responses are indistinguishable and leak nothing requested.
    assertThat(nonMember.json().path("message").asText())
        .isEqualTo(missing.json().path("message").asText());
    assertThat(nonMember.body).doesNotContain(householdId);
    assertThat(missing.body).doesNotContain("SQL", "at com.housesync");

    // The stranger's own collection stays empty: no cross-household leakage through lists.
    assertThat(stranger.get("/api/households").json().path("households").size()).isEqualTo(0);
  }

  @Test
  void memberRoleIsReturnedAndRemovalRevokesDetailAccess() throws Exception {
    Agent owner = signedInAgent("ownerrole");
    String householdId =
        owner
            .post("/api/households", "{\"name\":\"Elm Street home\"}", owner.csrfToken)
            .json()
            .path("id")
            .asText();
    Agent member = signedInAgent("memberrole");
    String memberId = member.me().json().path("id").asText();

    // MEMBER is normally assigned by invitation; seeded here to prove the detail
    // contract reports the caller's current role descriptively.
    assertThat(
            jdbc.update(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?::uuid, ?::uuid, 'MEMBER')",
                householdId,
                memberId))
        .isEqualTo(1);
    Resp detail = member.get("/api/households/" + householdId);
    assertThat(detail.status).isEqualTo(200);
    assertThat(detail.json().path("role").asText()).isEqualTo("MEMBER");
    assertThat(detail.json().path("name").asText()).isEqualTo("Elm Street home");
    assertThat(member.get("/api/households").json().path("households").size()).isEqualTo(1);

    // Current membership is checked on every request: removal revokes detail access.
    assertThat(
            jdbc.update(
                "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
                householdId,
                memberId))
        .isEqualTo(1);
    Resp revoked = member.get("/api/households/" + householdId);
    assertThat(revoked.status).isEqualTo(404);
    assertThat(revoked.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(revoked.body).doesNotContain(householdId);
    assertThat(member.get("/api/households").json().path("households").size()).isEqualTo(0);
  }

  @Test
  void malformedUuidIsSafeBadRequest() throws Exception {
    Agent agent = signedInAgent("malformed");
    Resp rejected = agent.get("/api/households/not-a-uuid");
    assertThat(rejected.status).isEqualTo(400);
    assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(rejected.json().path("correlationId").asText()).isNotBlank();
    assertThat(rejected.body).doesNotContain("not-a-uuid", "SQL", "at com.housesync");
  }

  @Test
  void anonymousHouseholdAccessIsUnauthorized() throws Exception {
    Agent anonymous = new Agent();
    assertThat(anonymous.get("/api/households").status).isEqualTo(401);
    assertThat(anonymous.get("/api/households").json().path("code").asText())
        .isEqualTo("UNAUTHENTICATED");
    assertThat(anonymous.get("/api/households/" + UUID.randomUUID()).status).isEqualTo(401);

    // A valid anonymous CSRF token does not substitute for authentication.
    String csrf = anonymous.csrf();
    Resp denied = anonymous.post("/api/households", "{\"name\":\"Elm Street home\"}", csrf);
    assertThat(denied.status).isEqualTo(401);
    assertThat(denied.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");
  }

  @Test
  void unimplementedHouseholdMethodsStayDenied() throws Exception {
    Agent agent = signedInAgent("methods");
    assertThat(agent.request("PUT", "/api/households", "{}", agent.csrfToken).status)
        .isEqualTo(403);
    assertThat(agent.request("DELETE", "/api/households", null, agent.csrfToken).status)
        .isEqualTo(403);
    String householdId =
        agent
            .post("/api/households", "{\"name\":\"Elm Street home\"}", agent.csrfToken)
            .json()
            .path("id")
            .asText();
    Resp denied = agent.request("DELETE", "/api/households/" + householdId, null, agent.csrfToken);
    assertThat(denied.status).isEqualTo(403);
    assertThat(denied.json().path("code").asText()).isEqualTo("FORBIDDEN");
    assertThat(agent.request("GET", "/api/households/a/b", null, null).status).isEqualTo(403);
  }

  @Test
  void forgedOwnershipFieldsAreRejected() throws Exception {
    Agent agent = signedInAgent("forged");
    String csrf = agent.csrfToken;
    List<String> forged =
        List.of(
            "{\"name\":\"Elm\",\"id\":\"" + UUID.randomUUID() + "\"}",
            "{\"name\":\"Elm\",\"householdId\":\"" + UUID.randomUUID() + "\"}",
            "{\"name\":\"Elm\",\"ownerId\":\"" + UUID.randomUUID() + "\"}",
            "{\"name\":\"Elm\",\"userId\":\"" + UUID.randomUUID() + "\"}",
            "{\"name\":\"Elm\",\"role\":\"MEMBER\"}",
            "{\"name\":\"Elm\",\"role\":\"OWNER\"}",
            "{\"name\":\"Elm\",\"members\":[]}",
            "{\"name\":\"Elm\",\"tenant\":\"other\"}");
    for (String payload : forged) {
      Resp rejected = agent.post("/api/households", payload, csrf);
      assertThat(rejected.status).as("payload %s", payload).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("correlationId").asText()).isNotBlank();
    }
    assertThat(agent.get("/api/households").json().path("households").size()).isEqualTo(0);
  }

  @Test
  void nameValidationBoundariesAreEnforced() throws Exception {
    Agent agent = signedInAgent("boundaries");
    String csrf = agent.csrfToken;
    for (String payload :
        List.of(
            "{}",
            "{\"name\":null}",
            "{\"name\":\"\"}",
            "{\"name\":\"   \"}",
            "{\"name\":\"" + "n".repeat(101) + "\"}",
            "{\"name\":\"a\\u0007b\"}")) {
      Resp rejected = agent.post("/api/households", payload, csrf);
      assertThat(rejected.status).as("payload %s", payload).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("correlationId").asText()).isNotBlank();
      assertThat(rejected.body).doesNotContain("SQL", "at com.housesync");
    }

    // Exactly 100 code points (counting an emoji as one) succeed.
    String boundary = "n".repeat(99) + smiley();
    assertThat(agent.post("/api/households", "{\"name\":\"" + boundary + "\"}", csrf).status)
        .isEqualTo(201);

    // Outer whitespace is trimmed; interior spacing is preserved.
    Resp padded = agent.post("/api/households", "{\"name\":\"  Elm  Street  \"}", agent.csrf());
    assertThat(padded.status).isEqualTo(201);
    assertThat(padded.json().path("name").asText()).isEqualTo("Elm  Street");

    // Visually blank Unicode-separator names are rejected with a name field error.
    char nbsp = (char) 160;
    char figureSpace = (char) 0x2007;
    char narrowNbsp = (char) 0x202F;
    for (String blank :
        List.of("" + nbsp, "" + figureSpace, "" + nbsp + figureSpace + narrowNbsp)) {
      Resp rejected = agent.post("/api/households", "{\"name\":\"" + blank + "\"}", agent.csrf());
      assertThat(rejected.status).as("blank %s", codePoints(blank)).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("fieldErrors").path("name").asText()).isNotBlank();
    }

    // Outer Unicode-whitespace padding is trimmed, not rejected.
    Resp nbspPadded =
        agent.post("/api/households", "{\"name\":\"" + nbsp + "Elm" + nbsp + "\"}", agent.csrf());
    assertThat(nbspPadded.status).isEqualTo(201);
    assertThat(nbspPadded.json().path("name").asText()).isEqualTo("Elm");

    Resp missing = agent.post("/api/households", "{}", agent.csrf());
    assertThat(missing.json().path("fieldErrors").path("name").asText()).isNotBlank();
  }

  private static String smiley() {
    return new String(Character.toChars(0x1F600));
  }

  private static String codePoints(String value) {
    StringBuilder rendered = new StringBuilder();
    value.codePoints().forEach(codePoint -> rendered.append(String.format("U+%04X ", codePoint)));
    return rendered.toString().trim();
  }

  @Test
  void duplicateNamesCreateDistinctHouseholds() throws Exception {
    Agent agent = signedInAgent("dupes");
    Resp first = agent.post("/api/households", "{\"name\":\"Shared name\"}", agent.csrfToken);
    Resp second = agent.post("/api/households", "{\"name\":\"Shared name\"}", agent.csrfToken);
    assertThat(first.status).isEqualTo(201);
    assertThat(second.status).isEqualTo(201);
    assertThat(first.json().path("id").asText()).isNotEqualTo(second.json().path("id").asText());
    assertThat(agent.get("/api/households").json().path("households").size()).isEqualTo(2);
  }

  @Test
  void unsafeCreateRequiresCsrf() throws Exception {
    Agent agent = signedInAgent("csrf");
    assertThat(agent.post("/api/households", "{\"name\":\"Elm\"}", null).status).isEqualTo(403);
    Resp mismatch = agent.post("/api/households", "{\"name\":\"Elm\"}", "not-the-token");
    assertThat(mismatch.status).isEqualTo(403);
    assertThat(mismatch.json().path("code").asText()).isEqualTo("CSRF_INVALID");
  }

  @Test
  void malformedJsonAndMediaTypesAreSafe() throws Exception {
    Agent agent = signedInAgent("shapes");
    Resp malformed = agent.post("/api/households", "{not json", agent.csrfToken);
    assertThat(malformed.status).isEqualTo(400);
    assertThat(malformed.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(malformed.json().path("correlationId").asText()).isNotBlank();
    assertThat(malformed.body).doesNotContain("SQL", "at com.housesync");

    HttpRequest request =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/households"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "text/plain")
            .header("Cookie", "SESSION=" + agent.sessionCookie)
            .header("X-CSRF-TOKEN", agent.csrfToken)
            .POST(HttpRequest.BodyPublishers.ofString("name=x"))
            .build();
    HttpResponse<String> media = client.send(request, HttpResponse.BodyHandlers.ofString());
    assertThat(media.statusCode()).isEqualTo(415);
    assertThat(media.body()).contains("correlationId").doesNotContain("at com.housesync");
  }

  @Test
  void expiredSessionLosesHouseholdAccess() throws Exception {
    Agent agent = signedInAgent("expiry");
    assertThat(agent.get("/api/households").status).isEqualTo(200);
    jdbc.update(
        "DELETE FROM spring_session WHERE session_id = ?",
        new String(Base64.getDecoder().decode(agent.sessionCookie)));
    Resp denied = agent.get("/api/households");
    assertThat(denied.status).isEqualTo(401);
    assertThat(denied.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");
  }

  @Test
  void concurrentRepeatedCreatesAreDistinctHouseholdsWithOneOwnerEach() throws Exception {
    Agent agent = signedInAgent("race");
    String actorId = agent.me().json().path("id").asText();
    int racers = 8;
    ExecutorService pool = Executors.newFixedThreadPool(racers);
    CountDownLatch start = new CountDownLatch(1);
    List<Future<Resp>> futures = new ArrayList<>();
    try {
      for (int i = 0; i < racers; i++) {
        futures.add(
            pool.submit(
                (Callable<Resp>)
                    () -> {
                      start.await(10, TimeUnit.SECONDS);
                      return postCreate(agent.sessionCookie, agent.csrfToken, "Race home");
                    }));
      }
      start.countDown();
      Set<String> ids = new HashSet<>();
      for (Future<Resp> future : futures) {
        Resp created = future.get(60, TimeUnit.SECONDS);
        assertThat(created.status).isEqualTo(201);
        assertThat(created.json().path("role").asText()).isEqualTo("OWNER");
        ids.add(created.json().path("id").asText());
      }
      assertThat(ids).hasSize(racers);
      // Every concurrently created household has exactly its one creator membership.
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id IN"
                      + " (SELECT id FROM households WHERE name = 'Race home'"
                      + " AND id IN (SELECT household_id FROM household_members"
                      + " WHERE user_id = ?::uuid))",
                  Integer.class,
                  actorId))
          .isEqualTo(racers);
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM (SELECT household_id FROM household_members"
                      + " WHERE user_id = ?::uuid GROUP BY household_id HAVING COUNT(*) <> 1) AS orphans",
                  Integer.class,
                  actorId))
          .isZero();
    } finally {
      pool.shutdownNow();
    }
  }

  // --- helpers ---

  private Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String email =
        tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    assertThat(agent.post("/api/auth/register", json(email), agent.csrf()).status).isEqualTo(201);
    assertThat(agent.post("/api/auth/login", json(email), agent.csrf()).status).isEqualTo(200);
    agent.csrf();
    return agent;
  }

  private static String json(String email) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
  }

  private Resp postCreate(String sessionCookie, String csrf, String name) throws Exception {
    HttpRequest request =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/households"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Cookie", "SESSION=" + sessionCookie)
            .header("X-CSRF-TOKEN", csrf)
            .POST(HttpRequest.BodyPublishers.ofString("{\"name\":\"" + name + "\"}"))
            .build();
    HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
    return new Resp(response.statusCode(), response.body(), response.headers());
  }

  record Resp(int status, String body, java.net.http.HttpHeaders headers) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }

    String cacheControl() {
      return headers.firstValue("Cache-Control").orElse("");
    }
  }

  /** Minimal same-origin browser: manual SESSION jar plus in-memory CSRF token. */
  class Agent {
    String sessionCookie;
    String csrfToken;

    String csrf() throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/csrf"))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      if (sessionCookie != null) {
        builder.header("Cookie", "SESSION=" + sessionCookie);
      }
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      assertThat(response.statusCode()).isEqualTo(200);
      rememberCookies(response);
      JsonNode node = mapper.readTree(response.body());
      csrfToken = node.path("token").asText();
      assertThat(node.path("headerName").asText()).isEqualTo("X-CSRF-TOKEN");
      assertThat(csrfToken).isNotBlank();
      return csrfToken;
    }

    Resp me() throws Exception {
      return get("/api/auth/me");
    }

    Resp get(String path) throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      if (sessionCookie != null) {
        builder.header("Cookie", "SESSION=" + sessionCookie);
      }
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      return toResp(response);
    }

    Resp post(String path, String json, String csrf) throws Exception {
      return request("POST", path, json == null ? "{}" : json, csrf);
    }

    Resp request(String method, String path, String json, String csrf) throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .header("Content-Type", "application/json")
              .header("Accept", "application/json")
              .method(
                  method,
                  json == null
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofString(json));
      if (sessionCookie != null) {
        builder.header("Cookie", "SESSION=" + sessionCookie);
      }
      if (csrf != null) {
        builder.header("X-CSRF-TOKEN", csrf);
      }
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      return toResp(response);
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

    private Resp toResp(HttpResponse<String> response) {
      return new Resp(response.statusCode(), response.body(), response.headers());
    }
  }
}
