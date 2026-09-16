package com.housesync.identity;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import com.housesync.identity.persistence.UserRepository;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * End-to-end identity/session behavior against real PostgreSQL over HTTP.
 *
 * <p>Runs with a raised source-address throttle so functional flows stay isolated from rate-limit
 * assertions; {@code AuthIpRateLimitIT} and {@code AuthEmailRateLimitIT} cover the 429 boundaries
 * with production defaults. Each test uses distinct identifiers and sessions.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class AuthSessionIT {

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
  @Autowired private UserRepository users;
  @Autowired private PasswordEncoder passwordEncoder;
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  // --- lifecycle ---

  @Test
  void registrationDoesNotAuthenticate() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("register");
    Resp created = agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf());
    assertThat(created.status).isEqualTo(201);
    assertThat(created.json().path("email").asText()).isEqualTo(email);
    assertThat(created.json().path("id").asText()).isNotBlank();
    assertThat(created.body).doesNotContain("passwordHash", "{bcrypt}", "$2a$", PASSWORD);

    Resp me = agent.get("/api/auth/me");
    assertThat(me.status).isEqualTo(401);
    assertThat(me.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");
  }

  @Test
  void emailIsNormalizedAndDuplicatesConflictGenerically() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("dup");
    Resp created =
        agent.post(
            "/api/auth/register", json("  " + email.toUpperCase() + "  ", PASSWORD), agent.csrf());
    assertThat(created.status).isEqualTo(201);
    assertThat(created.json().path("email").asText()).isEqualTo(email);

    Resp conflict = agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf());
    assertThat(conflict.status).isEqualTo(409);
    assertThat(conflict.json().path("code").asText()).isEqualTo("REGISTRATION_CONFLICT");
    assertThat(conflict.json().path("correlationId").asText()).isNotBlank();
    assertThat(conflict.body).doesNotContain(PASSWORD).doesNotContain(email.split("@")[0] + "x");
  }

  @Test
  void longestEmailRegistersLogsInAndOut() throws Exception {
    String boundary = "l".repeat(247) + "@b.test";
    assertThat(boundary.length()).isEqualTo(254);
    Agent agent = new Agent();
    Resp created = agent.post("/api/auth/register", json(boundary, PASSWORD), agent.csrf());
    assertThat(created.status).isEqualTo(201);
    assertThat(created.json().path("email").asText()).isEqualTo(boundary);

    // The session principal column must hold the full identifier: this login failed while it
    // was still VARCHAR(100).
    Resp login = agent.post("/api/auth/login", json(boundary, PASSWORD), agent.csrf());
    assertThat(login.status).isEqualTo(200);
    assertThat(agent.get("/api/auth/me").json().path("email").asText()).isEqualTo(boundary);
    assertThat(
            jdbc.queryForObject(
                "SELECT character_maximum_length FROM information_schema.columns"
                    + " WHERE table_schema = 'public' AND table_name = 'spring_session'"
                    + " AND column_name = 'principal_name'",
                Integer.class))
        .isEqualTo(254);

    agent.csrf();
    assertThat(agent.postEmpty("/api/auth/logout").status).isEqualTo(204);
    assertThat(agent.get("/api/auth/me").status).isEqualTo(401);

    // One character over the policy is rejected at the boundary.
    Agent over = new Agent();
    assertThat(
            over.post(
                    "/api/auth/register", json("l".repeat(248) + "@b.test", PASSWORD), over.csrf())
                .status)
        .isEqualTo(400);
  }

  @Test
  void concurrentDuplicateRegistrationsYieldOneWinner() throws Exception {
    String email = uniqueEmail("race");
    int racers = 8;
    ListAppender<ILoggingEvent> logs = captureLogs();
    ExecutorService pool = Executors.newFixedThreadPool(racers);
    CountDownLatch start = new CountDownLatch(1);
    List<Future<Integer>> futures = new ArrayList<>();
    try {
      for (int i = 0; i < racers; i++) {
        futures.add(
            pool.submit(
                (Callable<Integer>)
                    () -> {
                      start.await(10, TimeUnit.SECONDS);
                      Agent agent = new Agent();
                      return agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf())
                          .status;
                    }));
      }
      start.countDown();
      List<Integer> statuses = new ArrayList<>();
      for (Future<Integer> future : futures) {
        statuses.add(future.get(60, TimeUnit.SECONDS));
      }
      assertThat(statuses).filteredOn(status -> status == 201).hasSize(1);
      assertThat(statuses).filteredOn(status -> status == 409).hasSize(racers - 1);
    } finally {
      pool.shutdownNow();
      detachLogs(logs);
    }
    // Losers resolve through ON CONFLICT without any SQL exception, so no log may carry the
    // submitted identifier. The capture itself is proven non-empty by the conflict warnings.
    assertThat(logs.list).isNotEmpty();
    assertNoLogContains(logs, email);
  }

  @Test
  @Transactional
  void duplicateInsertAtPersistenceBoundaryLogsNoIdentifiers() {
    String email = uniqueEmail("nolog");
    String hash = passwordEncoder.encode(PASSWORD);
    ListAppender<ILoggingEvent> logs = captureLogs();
    try {
      assertThat(users.insertIgnoreConflict(UUID.randomUUID(), email, hash, Instant.now()))
          .isEqualTo(1);
      assertThat(users.insertIgnoreConflict(UUID.randomUUID(), email, hash, Instant.now()))
          .isEqualTo(0);
      assertThat(users.findByEmail(email)).isPresent();
    } finally {
      detachLogs(logs);
    }
    // The conflicting insert raised no SQL exception, so neither Hibernate's error logging nor
    // our handlers may have recorded the identifier. Rolls back with the test transaction.
    assertNoLogContains(logs, email);
  }

  @Test
  void registrationEnforcesPasswordBoundaries() throws Exception {
    Agent agent = new Agent();
    String csrf = agent.csrf();
    assertThat(agent.post("/api/auth/register", json(uniqueEmail("pw"), "too-short"), csrf).status)
        .isEqualTo(400);
    assertThat(
            agent.post("/api/auth/register", json(uniqueEmail("pw"), "a".repeat(73)), csrf).status)
        .isEqualTo(400);
    assertThat(
            agent.post(
                    "/api/auth/register", json(uniqueEmail("pw"), "fifteen chars here\u0000"), csrf)
                .status)
        .isEqualTo(400);
    assertThat(
            agent.post("/api/auth/register", json(uniqueEmail("pw"), "a".repeat(15)), csrf).status)
        .isEqualTo(201);
    assertThat(
            agent.post(
                    "/api/auth/register",
                    json(uniqueEmail("pw"), "  padded with spaces 123 "),
                    csrf)
                .status)
        .isEqualTo(201);
  }

  // --- login ---

  @Test
  void loginSucceedsWithSafeUserAndFailsGenerically() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("login");
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(201);

    Resp ok = agent.post("/api/auth/login", json(email, PASSWORD), agent.csrf());
    assertThat(ok.status).isEqualTo(200);
    assertThat(ok.json().path("email").asText()).isEqualTo(email);
    assertThat(ok.json().path("id").asText()).isNotBlank();
    assertThat(ok.body).doesNotContain("passwordHash", "{bcrypt}", "$2a$", PASSWORD);

    Resp me = agent.get("/api/auth/me");
    assertThat(me.status).isEqualTo(200);
    assertThat(me.json().path("email").asText()).isEqualTo(email);

    Agent wrongPassword = new Agent();
    Resp badPassword =
        wrongPassword.post(
            "/api/auth/login", json(email, "wrong password here!"), wrongPassword.csrf());
    Agent unknownUser = new Agent();
    Resp unknown =
        unknownUser.post(
            "/api/auth/login",
            json(uniqueEmail("ghost"), "wrong password here!"),
            unknownUser.csrf());
    assertThat(badPassword.status).isEqualTo(401);
    assertThat(unknown.status).isEqualTo(401);
    // Unknown identifiers and wrong passwords are indistinguishable.
    assertThat(badPassword.json().path("code").asText()).isEqualTo("INVALID_CREDENTIALS");
    assertThat(unknown.json().path("code").asText()).isEqualTo("INVALID_CREDENTIALS");
    assertThat(badPassword.json().path("message").asText())
        .isEqualTo(unknown.json().path("message").asText());
    assertThat(badPassword.json().path("correlationId").asText()).isNotBlank();
    assertThat(badPassword.body + unknown.body)
        .doesNotContain("{bcrypt}", "$2a$", "passwordHash", "UsernameNotFound", "at com.housesync");
  }

  @Test
  void loginRejectsMalformedShapes() throws Exception {
    Agent agent = new Agent();
    String csrf = agent.csrf();
    assertThat(agent.post("/api/auth/login", json(uniqueEmail("shape"), ""), csrf).status)
        .isEqualTo(400);
    assertThat(
            agent.post("/api/auth/login", json(uniqueEmail("shape"), "a".repeat(73)), csrf).status)
        .isEqualTo(400);
    assertThat(agent.post("/api/auth/login", "{\"email\":null,\"password\":null}", csrf).status)
        .isEqualTo(400);
    // NUL is rejected at login exactly as at registration.
    Resp nul =
        agent.post(
            "/api/auth/login",
            "{\"email\":\""
                + uniqueEmail("shape")
                + "\",\"password\":\"fifteen chars here\\u0000\"}",
            csrf);
    assertThat(nul.status).isEqualTo(400);
    assertThat(nul.json().path("fieldErrors").path("password").asText()).isNotBlank();
    // Unknown fields are rejected rather than bound.
    Resp unknownField =
        agent.post(
            "/api/auth/login",
            "{\"email\":\""
                + uniqueEmail("shape")
                + "\",\"password\":\""
                + PASSWORD
                + "\",\"remember\":true}",
            csrf);
    assertThat(unknownField.status).isEqualTo(400);
    assertThat(unknownField.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
  }

  @Test
  void loginRejectsUnsupportedMediaType() throws Exception {
    Agent agent = new Agent();
    String csrf = agent.csrf();
    HttpRequest request =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/login"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "text/plain")
            .header("Cookie", "SESSION=" + agent.sessionCookie)
            .header("X-CSRF-TOKEN", csrf)
            .POST(HttpRequest.BodyPublishers.ofString("email=x"))
            .build();
    HttpResponse<String> rejected = client.send(request, HttpResponse.BodyHandlers.ofString());
    assertThat(rejected.statusCode()).isEqualTo(415);
    assertThat(rejected.body()).contains("correlationId").doesNotContain("at com.housesync");
  }

  // --- CSRF and sessions ---

  @Test
  void unsafeRequestsRequireCsrf() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("csrf");
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD), null).status).isEqualTo(403);
    assertThat(agent.post("/api/auth/login", json(email, PASSWORD), null).status).isEqualTo(403);
    assertThat(agent.post("/api/auth/logout", "{}", null).status).isEqualTo(403);

    Resp mismatch = agent.post("/api/auth/register", json(email, PASSWORD), "not-the-token");
    assertThat(mismatch.status).isEqualTo(403);
    assertThat(mismatch.json().path("code").asText()).isEqualTo("CSRF_INVALID");
  }

  @Test
  void loginRotatesSessionAndCsrfToken() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("rotation");
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(201);

    String anonymousSession = agent.sessionCookie;
    String anonymousCsrf = agent.csrfToken;
    Resp login = agent.post("/api/auth/login", json(email, PASSWORD), anonymousCsrf);
    assertThat(login.status).isEqualTo(200);
    // Session fixation protection: the session id changed.
    assertThat(agent.sessionCookie).isNotNull().isNotEqualTo(anonymousSession);
    // The pre-login session is dead.
    Agent stale = new Agent();
    stale.sessionCookie = anonymousSession;
    assertThat(stale.get("/api/auth/me").status).isEqualTo(401);
    // The pre-login CSRF token is rejected after rotation.
    Resp replay = agent.post("/api/auth/logout", "{}", anonymousCsrf);
    assertThat(replay.status).isEqualTo(403);
    assertThat(replay.json().path("code").asText()).isEqualTo("CSRF_INVALID");
    // A fresh bootstrap token works again.
    assertThat(agent.csrf()).isNotEqualTo(anonymousCsrf);
    assertThat(agent.post("/api/auth/logout", "{}", agent.csrfToken).status).isEqualTo(204);
  }

  @Test
  void securityContextPersistsAcrossRequestsInPostgres() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("persist");
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(201);
    assertThat(agent.post("/api/auth/login", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(200);
    assertThat(agent.get("/api/auth/me").json().path("email").asText()).isEqualTo(email);
    assertThat(agent.get("/api/auth/me").status).isEqualTo(200);

    String sessionId = sessionIdOf(agent.sessionCookie);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM spring_session WHERE session_id = ?",
                Integer.class,
                sessionId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT principal_name FROM spring_session WHERE session_id = ?",
                String.class,
                sessionId))
        .isEqualTo(email);

    // The persisted session must hold no password hash and no cleartext password.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM spring_session_attributes"
                    + " WHERE position('$2a$'::bytea IN attribute_bytes) > 0",
                Integer.class))
        .isEqualTo(0);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM spring_session_attributes"
                    + " WHERE position(? IN attribute_bytes) > 0",
                Integer.class,
                PASSWORD.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
        .isEqualTo(0);
  }

  @Test
  void sessionCookieHasExplicitSecureFlags() throws Exception {
    Agent agent = new Agent();
    agent.csrf();
    String setCookie =
        agent.lastSetCookies.stream()
            .filter(value -> value.startsWith("SESSION="))
            .findFirst()
            .orElseThrow(
                () -> new AssertionError("SESSION cookie missing: " + agent.lastSetCookies));
    assertThat(setCookie).contains("SESSION=").contains("Path=/").contains("HttpOnly");
    assertThat(setCookie).contains("SameSite=Lax").contains("Secure");
    assertThat(setCookie).doesNotContain("Domain=");
  }

  @Test
  void logoutInvalidatesSessionAndAnonymousRelogoutIsSafe() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("logout");
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(201);
    assertThat(agent.post("/api/auth/login", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(200);
    String sessionId = sessionIdOf(agent.sessionCookie);

    // The web client sends no body on logout; refresh the rotated token first.
    agent.csrf();
    Resp logout = agent.postEmpty("/api/auth/logout");
    assertThat(logout.status).isEqualTo(204);
    // The 204 carries an expired SESSION cookie (name/domain/path identity clears it;
    // Secure/HttpOnly/SameSite flags never take part in deletion matching).
    List<String> clearing =
        logout.setCookies.stream().filter(value -> value.startsWith("SESSION=")).toList();
    assertThat(clearing).isNotEmpty();
    assertThat(clearing.toString())
        .contains("Path=/")
        .satisfiesAnyOf(
            text -> assertThat(text).contains("Max-Age=0"),
            text -> assertThat(text).contains("1970"));
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM spring_session WHERE session_id = ?",
                Integer.class,
                sessionId))
        .isEqualTo(0);
    assertThat(agent.get("/api/auth/me").status).isEqualTo(401);

    // Anonymous session with a valid CSRF token logs out safely, also without a body.
    Agent anonymous = new Agent();
    anonymous.csrf();
    assertThat(anonymous.postEmpty("/api/auth/logout").status).isEqualTo(204);
  }

  @Test
  void expiredSessionIsRejected() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("expiry");
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(201);
    assertThat(agent.post("/api/auth/login", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(200);
    assertThat(agent.get("/api/auth/me").status).isEqualTo(200);

    jdbc.update(
        "DELETE FROM spring_session WHERE session_id = ?", sessionIdOf(agent.sessionCookie));
    Resp me = agent.get("/api/auth/me");
    assertThat(me.status).isEqualTo(401);
    assertThat(me.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");
  }

  @Test
  void unknownRoutesStayDenied() throws Exception {
    Agent anonymous = new Agent();
    assertThat(anonymous.get("/api/unknown").status).isEqualTo(401);

    Agent agent = new Agent();
    String email = uniqueEmail("denied");
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(201);
    assertThat(agent.post("/api/auth/login", json(email, PASSWORD), agent.csrf()).status)
        .isEqualTo(200);
    Resp denied = agent.get("/api/unknown");
    assertThat(denied.status).isEqualTo(403);
    assertThat(denied.json().path("code").asText()).isEqualTo("FORBIDDEN");
  }

  @Test
  void malformedJsonUnknownFieldsAndMediaTypesAreSafe() throws Exception {
    Agent agent = new Agent();
    String csrf = agent.csrf();
    Resp malformed = agent.post("/api/auth/register", "{not json", csrf);
    assertThat(malformed.status).isEqualTo(400);
    Resp unknownField =
        agent.post(
            "/api/auth/register",
            "{\"email\":\""
                + uniqueEmail("rej")
                + "\",\"password\":\""
                + PASSWORD
                + "\",\"role\":\"ADMIN\"}",
            csrf);
    assertThat(unknownField.status).isEqualTo(400);
    for (Resp rejected : List.of(malformed, unknownField)) {
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("correlationId").asText()).isNotBlank();
      assertThat(rejected.body)
          .doesNotContain("SQL", "Exception", "at com.housesync", PASSWORD, "passwordHash");
    }
    HttpRequest request =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/register"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "text/plain")
            .header("Cookie", "SESSION=" + agent.sessionCookie)
            .header("X-CSRF-TOKEN", csrf)
            .POST(HttpRequest.BodyPublishers.ofString("email=x"))
            .build();
    HttpResponse<String> media = client.send(request, HttpResponse.BodyHandlers.ofString());
    assertThat(media.statusCode()).isEqualTo(415);
    assertThat(media.body()).contains("correlationId").doesNotContain("at com.housesync");
  }

  // --- helpers ---

  private static String uniqueEmail(String tag) {
    return tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
  }

  private static String json(String email, String password) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + password + "\"}";
  }

  private static String sessionIdOf(String cookieValue) {
    return new String(Base64.getDecoder().decode(cookieValue));
  }

  /** Captures server-side log events (the HTTP server runs in this JVM) for PII assertions. */
  private static ListAppender<ILoggingEvent> captureLogs() {
    Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
    ListAppender<ILoggingEvent> appender = new ListAppender<>();
    appender.setContext(root.getLoggerContext());
    appender.start();
    root.addAppender(appender);
    return appender;
  }

  private static void detachLogs(ListAppender<ILoggingEvent> appender) {
    Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
    root.detachAppender(appender);
    appender.stop();
  }

  /** Fails when any captured message, argument, or attached exception carries the secret. */
  private static void assertNoLogContains(ListAppender<ILoggingEvent> appender, String secret) {
    for (ILoggingEvent event : appender.list) {
      assertThat(event.getFormattedMessage()).doesNotContain(secret);
      Object[] arguments = event.getArgumentArray();
      if (arguments != null) {
        for (Object argument : arguments) {
          if (argument != null) {
            assertThat(String.valueOf(argument)).doesNotContain(secret);
          }
        }
      }
      IThrowableProxy proxy = event.getThrowableProxy();
      while (proxy != null) {
        if (proxy.getMessage() != null) {
          assertThat(proxy.getMessage()).doesNotContain(secret);
        }
        proxy = proxy.getCause();
      }
    }
  }

  record Resp(int status, String body, List<String> setCookies, String retryAfter) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }
  }

  /** Minimal same-origin browser: manual SESSION jar plus in-memory CSRF token. */
  class Agent {
    String sessionCookie;
    String csrfToken;
    List<String> lastSetCookies = List.of();

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
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .header("Content-Type", "application/json")
              .header("Accept", "application/json")
              .POST(HttpRequest.BodyPublishers.ofString(json == null ? "{}" : json));
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

    /** Bodiless POST (no body, no content type), matching what the web client sends on logout. */
    Resp postEmpty(String path) throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .POST(HttpRequest.BodyPublishers.noBody());
      if (sessionCookie != null) {
        builder.header("Cookie", "SESSION=" + sessionCookie);
      }
      if (csrfToken != null) {
        builder.header("X-CSRF-TOKEN", csrfToken);
      }
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      return toResp(response);
    }

    private void rememberCookies(HttpResponse<String> response) {
      lastSetCookies = response.headers().allValues("Set-Cookie");
      for (String setCookie : lastSetCookies) {
        String pair = setCookie.split(";", 2)[0];
        int separator = pair.indexOf('=');
        if (separator > 0 && pair.substring(0, separator).equals("SESSION")) {
          String value = pair.substring(separator + 1);
          sessionCookie = value.isEmpty() ? null : value;
        }
      }
    }

    private Resp toResp(HttpResponse<String> response) {
      return new Resp(
          response.statusCode(),
          response.body(),
          response.headers().allValues("Set-Cookie"),
          response.headers().firstValue("Retry-After").orElse(null));
    }
  }
}
