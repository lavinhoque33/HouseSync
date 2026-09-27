package com.housesync.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import com.housesync.identity.application.IdentityGrants;
import com.housesync.identity.application.IdentityService;
import com.housesync.identity.domain.EmailPolicy;
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
import java.util.concurrent.ConcurrentHashMap;
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
  @Autowired private IdentityGrants grants;
  private final ConcurrentHashMap<String, String> enrollmentCodes = new ConcurrentHashMap<>();
  @Autowired private IdentityService identities;
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
    assertThat(conflict.status).isEqualTo(403);
    assertThat(conflict.json().path("code").asText()).isEqualTo("ENROLLMENT_INVALID");
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
        .isEqualTo(403);
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
      assertThat(statuses).filteredOn(status -> status == 403).hasSize(racers - 1);
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

  @Test
  void enrollmentIsRecipientBoundExpiringSingleUseAndCsrfProtected() throws Exception {
    Agent agent = new Agent();
    String email = uniqueEmail("grant");
    String other = uniqueEmail("other");
    String code = grants.issue("ENROLLMENT", email).code();
    String recipient = json(email, PASSWORD).replace("}", ",\"enrollmentCode\":\"" + code + "\"}");
    String mismatch = json(other, PASSWORD).replace("}", ",\"enrollmentCode\":\"" + code + "\"}");
    String csrf = agent.csrf();
    assertThat(agent.postRaw("/api/auth/register", recipient, null).json().path("code").asText())
        .isEqualTo("CSRF_INVALID");
    assertThat(agent.postRaw("/api/auth/register", mismatch, csrf).json().path("code").asText())
        .isEqualTo("ENROLLMENT_INVALID");
    assertThat(agent.postRaw("/api/auth/register", recipient, csrf).status).isEqualTo(201);
    Resp replay = agent.postRaw("/api/auth/register", recipient, csrf);
    assertThat(replay.status).isEqualTo(403);
    assertThat(replay.json().path("code").asText()).isEqualTo("ENROLLMENT_INVALID");
    String expired = grants.issue("ENROLLMENT", other).code();
    jdbc.update(
        "UPDATE identity_grants SET issued_at = now() - interval '2 days',"
            + " expires_at = now() - interval '1 day' WHERE recipient_email = ?",
        other);
    Resp expiry =
        agent.postRaw(
            "/api/auth/register",
            json(other, PASSWORD).replace("}", ",\"enrollmentCode\":\"" + expired + "\"}"),
            csrf);
    assertThat(expiry.status).isEqualTo(403);
    assertThat(expiry.json().path("code").asText()).isEqualTo("ENROLLMENT_INVALID");
    String revokedEmail = uniqueEmail("revoked");
    IdentityGrants.Issued revokedGrant = grants.issue("ENROLLMENT", revokedEmail);
    assertThat(grants.revoke(revokedGrant.id())).isTrue();
    assertThat(
            agent
                .postRaw(
                    "/api/auth/register",
                    json(revokedEmail, PASSWORD)
                        .replace("}", ",\"enrollmentCode\":\"" + revokedGrant.code() + "\"}"),
                    csrf)
                .json()
                .path("code")
                .asText())
        .isEqualTo("ENROLLMENT_INVALID");
    assertThat(
            jdbc.queryForObject(
                "SELECT octet_length(token_digest) FROM identity_grants WHERE id = ?",
                Integer.class,
                revokedGrant.id()))
        .isEqualTo(32);
    assertThat(
            jdbc.queryForList(
                "SELECT action FROM identity_grant_audit WHERE grant_id = ?",
                String.class,
                revokedGrant.id()))
        .containsExactlyInAnyOrder("ISSUED", "REVOKED");
  }

  @Test
  void recoveryResetsPasswordRevokesEverySessionAndErrorsStayGeneric() throws Exception {
    String email = uniqueEmail("recover");
    Agent first = new Agent();
    assertThat(first.post("/api/auth/register", json(email, PASSWORD), first.csrf()).status)
        .isEqualTo(201);
    assertThat(first.post("/api/auth/login", json(email, PASSWORD), first.csrf()).status)
        .isEqualTo(200);
    Agent second = new Agent();
    assertThat(second.post("/api/auth/login", json(email, PASSWORD), second.csrf()).status)
        .isEqualTo(200);
    String code = grants.issue("RECOVERY", email).code();
    String nextPassword = "replacement password long 123";
    String body =
        "{\"email\":\""
            + email
            + "\",\"recoveryCode\":\""
            + code
            + "\",\"newPassword\":\""
            + nextPassword
            + "\"}";
    Agent recovery = new Agent();
    String csrf = recovery.csrf();
    assertThat(recovery.postRaw("/api/auth/recover", body, null).json().path("code").asText())
        .isEqualTo("CSRF_INVALID");
    Resp mismatch =
        recovery.postRaw("/api/auth/recover", body.replace(email, uniqueEmail("wrong")), csrf);
    assertThat(mismatch.status).isEqualTo(403);
    assertThat(mismatch.json().path("code").asText()).isEqualTo("RECOVERY_INVALID");
    assertThat(recovery.postRaw("/api/auth/recover", body, csrf).status).isEqualTo(204);
    assertThat(first.get("/api/auth/me").status).isEqualTo(401);
    assertThat(second.get("/api/auth/me").status).isEqualTo(401);
    Resp replay = recovery.postRaw("/api/auth/recover", body, csrf);
    assertThat(replay.status).isEqualTo(403);
    assertThat(replay.json().path("code").asText())
        .isEqualTo(mismatch.json().path("code").asText());
    IdentityGrants.Issued expired = grants.issue("RECOVERY", email);
    jdbc.update(
        "UPDATE identity_grants SET issued_at = now() - interval '2 days',"
            + " expires_at = now() - interval '1 day' WHERE id = ?",
        expired.id());
    Resp expiredAttempt =
        recovery.postRaw("/api/auth/recover", body.replace(code, expired.code()), csrf);
    assertThat(expiredAttempt.status).isEqualTo(403);
    assertThat(expiredAttempt.json().path("code").asText())
        .isEqualTo(mismatch.json().path("code").asText());
    Resp absent =
        recovery.postRaw(
            "/api/auth/recover",
            "{\"email\":\"" + email + "\",\"newPassword\":\"" + nextPassword + "\"}",
            csrf);
    assertThat(absent.status).isEqualTo(403);
    assertThat(absent.json().path("code").asText())
        .isEqualTo(mismatch.json().path("code").asText());
    Agent signIn = new Agent();
    assertThat(signIn.post("/api/auth/login", json(email, PASSWORD), signIn.csrf()).status)
        .isEqualTo(401);
    assertThat(signIn.post("/api/auth/login", json(email, nextPassword), signIn.csrf()).status)
        .isEqualTo(200);
  }

  @Test
  void passwordChangeExplicitRevocationAndAbsoluteLifetimeEndAccess() throws Exception {
    String email = uniqueEmail("account");
    Agent first = new Agent();
    assertThat(first.post("/api/auth/register", json(email, PASSWORD), first.csrf()).status)
        .isEqualTo(201);
    assertThat(first.post("/api/auth/login", json(email, PASSWORD), first.csrf()).status)
        .isEqualTo(200);
    Agent second = new Agent();
    assertThat(second.post("/api/auth/login", json(email, PASSWORD), second.csrf()).status)
        .isEqualTo(200);
    String nextPassword = "new password for account 123";
    String change =
        "{\"currentPassword\":\"" + PASSWORD + "\",\"newPassword\":\"" + nextPassword + "\"}";
    assertThat(first.post("/api/auth/password", change, null).json().path("code").asText())
        .isEqualTo("CSRF_INVALID");
    assertThat(
            first
                .post("/api/auth/password", change.replace(PASSWORD, "wrong"), first.csrf())
                .json()
                .path("code")
                .asText())
        .isEqualTo("INVALID_CREDENTIALS");
    assertThat(first.post("/api/auth/password", change, first.csrf()).status).isEqualTo(204);
    assertThat(first.get("/api/auth/me").status).isEqualTo(401);
    assertThat(second.get("/api/auth/me").status).isEqualTo(401);
    Agent third = new Agent();
    assertThat(third.post("/api/auth/login", json(email, nextPassword), third.csrf()).status)
        .isEqualTo(200);
    String oldSession = third.sessionCookie;
    jdbc.update(
        "UPDATE spring_session SET creation_time = ? WHERE session_id = ?",
        Instant.now().minus(Duration.ofDays(31)).toEpochMilli(),
        sessionIdOf(oldSession));
    assertThat(third.get("/api/auth/me").status).isEqualTo(401);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM spring_session WHERE session_id = ?",
                Integer.class,
                sessionIdOf(oldSession)))
        .isZero();
    Agent fourth = new Agent();
    assertThat(fourth.post("/api/auth/login", json(email, nextPassword), fourth.csrf()).status)
        .isEqualTo(200);
    Agent fifth = new Agent();
    assertThat(fifth.post("/api/auth/login", json(email, nextPassword), fifth.csrf()).status)
        .isEqualTo(200);
    fourth.csrf();
    assertThat(fourth.postEmpty("/api/auth/sessions/revoke").status).isEqualTo(204);
    assertThat(fourth.get("/api/auth/me").status).isEqualTo(401);
    assertThat(fifth.get("/api/auth/me").status).isEqualTo(401);
  }

  @Test
  void departureDisablesLoginAndSessionsWithoutDeletingAccountHistory() throws Exception {
    String email = uniqueEmail("departure");
    Agent account = new Agent();
    Resp created = account.post("/api/auth/register", json(email, PASSWORD), account.csrf());
    assertThat(created.status).isEqualTo(201);
    UUID id = UUID.fromString(created.json().path("id").asText());
    assertThat(account.post("/api/auth/login", json(email, PASSWORD), account.csrf()).status)
        .isEqualTo(200);
    String departedCookie = account.sessionCookie;
    String departedSessionId = sessionIdOf(departedCookie);
    byte[] departedContext =
        jdbc.queryForObject(
            "SELECT a.attribute_bytes FROM spring_session_attributes a"
                + " JOIN spring_session s ON s.primary_id = a.session_primary_id"
                + " WHERE s.session_id = ? AND a.attribute_name = 'SPRING_SECURITY_CONTEXT'",
            byte[].class,
            departedSessionId);
    String pendingCode = grants.issue("RECOVERY", email).code();
    int usersBefore =
        jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE id = ?", Integer.class, id);
    UUID household = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO households (id, name) VALUES (?, ?)", household, "Departure retention");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'OWNER')",
        household,
        id);
    assertThatThrownBy(() -> identities.disableAccess(email))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("memberships");
    UUID successor = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
        successor,
        uniqueEmail("successor"),
        passwordEncoder.encode(PASSWORD),
        Instant.now().atOffset(java.time.ZoneOffset.UTC));
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'OWNER')",
        household,
        successor);
    jdbc.update(
        "UPDATE household_members SET role = 'MEMBER' WHERE household_id = ? AND user_id = ?",
        household,
        id);
    assertThatThrownBy(() -> identities.disableAccess(email))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("memberships");
    assertThat(
            jdbc.queryForObject(
                "SELECT access_disabled FROM users WHERE id = ?", Boolean.class, id))
        .isFalse();
    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ? AND user_id = ?", household, id);
    identities.disableAccess(email);
    assertThat(account.get("/api/auth/me").status).isEqualTo(401);
    restoreLateSession(email, departedSessionId, departedContext);
    account.sessionCookie = departedCookie;
    assertThat(account.get("/api/households").status).isEqualTo(401);
    Agent fresh = new Agent();
    assertThat(fresh.post("/api/auth/login", json(email, PASSWORD), fresh.csrf()).status)
        .isEqualTo(401);
    Resp recovery =
        fresh.post(
            "/api/auth/recover",
            "{\"email\":\""
                + email
                + "\",\"recoveryCode\":\""
                + pendingCode
                + "\",\"newPassword\":\"replacement password 123\"}",
            fresh.csrf());
    assertThat(recovery.json().path("code").asText()).isEqualTo("RECOVERY_INVALID");
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE id = ?", Integer.class, id))
        .isEqualTo(usersBefore);
    assertThat(
            jdbc.queryForObject(
                "SELECT access_disabled FROM users WHERE id = ?", Boolean.class, id))
        .isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM spring_session WHERE principal_name = ?",
                Integer.class,
                email))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND user_id = ?",
                Integer.class,
                household,
                id))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM households WHERE id = ?", Integer.class, household))
        .isEqualTo(1);
  }

  @Test
  void latePersistedPreRevocationLoginCannotReachHouseholdOrFinance() throws Exception {
    String email = uniqueEmail("late");
    Agent account = new Agent();
    Resp registered = account.post("/api/auth/register", json(email, PASSWORD), account.csrf());
    UUID id = UUID.fromString(registered.json().path("id").asText());
    assertThat(account.post("/api/auth/login", json(email, PASSWORD), account.csrf()).status)
        .isEqualTo(200);
    String cookie = account.sessionCookie;
    String sessionId = sessionIdOf(cookie);
    byte[] authenticatedContext =
        jdbc.queryForObject(
            "SELECT a.attribute_bytes FROM spring_session_attributes a"
                + " JOIN spring_session s ON s.primary_id = a.session_primary_id"
                + " WHERE s.session_id = ? AND a.attribute_name = 'SPRING_SECURITY_CONTEXT'",
            byte[].class,
            sessionId);
    Resp household =
        account.post("/api/households", "{\"name\":\"Late login home\"}", account.csrf());
    assertThat(household.status).isEqualTo(201);
    String householdPath = "/api/households/" + household.json().path("id").asText();
    assertThat(account.get(householdPath).status).isEqualTo(200);

    identities.revokeSessions(id);
    assertThat(
            jdbc.queryForObject(
                "SELECT session_generation FROM users WHERE id = ?", Long.class, id))
        .isEqualTo(1L);
    // Reinsert the pre-revoke serialized principal after the DELETE, as an in-flight login's
    // Spring Session save would do. Its cookie is valid, but its generation is not.
    restoreLateSession(email, sessionId, authenticatedContext);
    account.sessionCookie = cookie;
    assertThat(account.get(householdPath).status).isEqualTo(401);
    restoreLateSession(email, sessionId, authenticatedContext);
    account.sessionCookie = cookie;
    assertThat(account.get(householdPath + "/transactions").status).isEqualTo(401);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM spring_session WHERE session_id = ?",
                Integer.class,
                sessionId))
        .isZero();
  }

  @Test
  void disabledMemberCannotBePromotedToSoleOwner() throws Exception {
    String ownerEmail = uniqueEmail("owner");
    Agent owner = new Agent();
    owner.post("/api/auth/register", json(ownerEmail, PASSWORD), owner.csrf());
    assertThat(owner.post("/api/auth/login", json(ownerEmail, PASSWORD), owner.csrf()).status)
        .isEqualTo(200);
    Resp created = owner.post("/api/households", "{\"name\":\"Safe owner home\"}", owner.csrf());
    assertThat(created.status).isEqualTo(201);
    UUID householdId = UUID.fromString(created.json().path("id").asText());
    String memberEmail = uniqueEmail("member");
    Agent member = new Agent();
    UUID memberId =
        UUID.fromString(
            member
                .post("/api/auth/register", json(memberEmail, PASSWORD), member.csrf())
                .json()
                .path("id")
                .asText());
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'MEMBER')",
        householdId,
        memberId);
    assertThatThrownBy(() -> identities.disableAccess(memberEmail))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("memberships");
    // Model a disabled retained member left by the old operator workflow.
    jdbc.update("UPDATE users SET access_disabled = TRUE WHERE id = ?", memberId);
    HttpRequest promote =
        HttpRequest.newBuilder(
                URI.create(
                    "http://localhost:"
                        + port
                        + "/api/households/"
                        + householdId
                        + "/members/"
                        + memberId))
            .header("Cookie", "SESSION=" + owner.sessionCookie)
            .header("Content-Type", "application/json")
            .header("X-CSRF-TOKEN", owner.csrf())
            .method("PATCH", HttpRequest.BodyPublishers.ofString("{\"role\":\"OWNER\"}"))
            .build();
    assertThat(client.send(promote, HttpResponse.BodyHandlers.ofString()).statusCode())
        .isEqualTo(403);
    assertThat(owner.postEmpty("/api/households/" + householdId + "/leave").status).isEqualTo(409);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ? AND role = 'OWNER'",
                Integer.class,
                householdId))
        .isEqualTo(1);
  }

  private void restoreLateSession(String email, String sessionId, byte[] authenticatedContext) {
    String primaryId = UUID.randomUUID().toString();
    long now = Instant.now().toEpochMilli();
    jdbc.update(
        "INSERT INTO spring_session (primary_id, session_id, creation_time, last_access_time,"
            + " max_inactive_interval, expiry_time, principal_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
        primaryId,
        sessionId,
        now,
        now,
        1800,
        now + 1_800_000,
        email);
    jdbc.update(
        "INSERT INTO spring_session_attributes (session_primary_id, attribute_name, attribute_bytes)"
            + " VALUES (?, 'SPRING_SECURITY_CONTEXT', ?)",
        primaryId,
        authenticatedContext);
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

    private String withEnrollment(String path, String json) {
      if (!path.equals("/api/auth/register") || json == null || !json.endsWith("}")) return json;
      try {
        String rawEmail = mapper.readTree(json).path("email").asText();
        if (EmailPolicy.violation(rawEmail).isPresent()) return json;
        String canonical = EmailPolicy.normalize(rawEmail);
        String code =
            enrollmentCodes.computeIfAbsent(
                canonical, key -> grants.issue("ENROLLMENT", key).code());
        return json.substring(0, json.length() - 1) + ",\"enrollmentCode\":\"" + code + "\"}";
      } catch (tools.jackson.core.JacksonException invalidJson) {
        return json;
      }
    }

    Resp post(String path, String json, String csrf) throws Exception {
      return postInternal(path, json, csrf, true);
    }

    Resp postRaw(String path, String json, String csrf) throws Exception {
      return postInternal(path, json, csrf, false);
    }

    private Resp postInternal(String path, String json, String csrf, boolean autoEnroll)
        throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .header("Content-Type", "application/json")
              .header("Accept", "application/json")
              .POST(
                  HttpRequest.BodyPublishers.ofString(
                      autoEnroll ? withEnrollment(path, json == null ? "{}" : json) : json));
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
