package com.housesync.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.identity.application.IdentityGrants;
import com.housesync.identity.application.IdentityService;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
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
import tools.jackson.databind.ObjectMapper;

/**
 * Per-source budget for creating new anonymous sessions. The budget is lowered to 5 so the boundary
 * is cheap to reach; sources are distinguished through {@code X-Forwarded-For} from the loopback
 * peer, a configured internal proxy.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.session-max-creations=5", "app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class SessionCreationRateLimitIT {

  private static final String PASSWORD = "correct horse battery staple 123!";

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

  @LocalServerPort private int port;
  @Autowired private JdbcTemplate jdbc;
  @Autowired private IdentityGrants grants;
  @Autowired private IdentityService identities;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void sourceOverBudgetGetsRateLimitedWithoutNewSessionRows() throws Exception {
    String source = "198.51.100.10";
    for (int i = 0; i < 5; i++) {
      assertThat(send("GET", "/api/auth/csrf", source, null, null).statusCode())
          .as("session %d", i)
          .isEqualTo(200);
    }
    long rows = sessionRows();

    HttpResponse<String> limited = send("GET", "/api/auth/csrf", source, null, null);
    assertThat(limited.statusCode()).isEqualTo(429);
    assertThat(Integer.parseInt(limited.headers().firstValue("Retry-After").orElseThrow()))
        .isPositive();
    assertThat(limited.headers().firstValue("Cache-Control").orElseThrow()).contains("no-store");
    assertThat(limited.headers().allValues("Set-Cookie")).isEmpty();
    assertThat(mapper.readTree(limited.body()).path("code").asText()).isEqualTo("RATE_LIMITED");
    assertThat(mapper.readTree(limited.body()).path("correlationId").asText()).isNotBlank();

    // A bogus cookie is not a valid session, and a CSRF-rejected write would also mint one.
    assertThat(send("GET", "/api/auth/csrf", source, "SESSION=bogus", null).statusCode())
        .isEqualTo(429);
    assertThat(send("POST", "/api/auth/login", source, null, "{}").statusCode()).isEqualTo(429);
    assertThat(send("POST", "/api/auth/logout", source, null, null).statusCode()).isEqualTo(429);
    assertThat(sessionRows()).isEqualTo(rows);

    // Anonymous requests that never create a session are not throttled by this budget.
    assertThat(send("GET", "/api/auth/me", source, null, null).statusCode()).isEqualTo(401);
    assertThat(send("GET", "/actuator/health", source, null, null).statusCode()).isEqualTo(200);

    // A different source is unaffected.
    assertThat(send("GET", "/api/auth/csrf", "198.51.100.11", null, null).statusCode())
        .isEqualTo(200);
    assertThat(sessionRows()).isEqualTo(rows + 1);
  }

  @Test
  void validSessionIsNeverLimitedEvenWhenSourceIsExhausted() throws Exception {
    String source = "198.51.100.20";
    HttpResponse<String> first = send("GET", "/api/auth/csrf", source, null, null);
    String cookie = sessionCookie(first);
    for (int i = 0; i < 4; i++) {
      assertThat(send("GET", "/api/auth/csrf", source, null, null).statusCode()).isEqualTo(200);
    }
    assertThat(send("GET", "/api/auth/csrf", source, null, null).statusCode()).isEqualTo(429);

    long rows = sessionRows();
    for (int i = 0; i < 20; i++) {
      HttpResponse<String> again = send("GET", "/api/auth/csrf", source, cookie, null);
      assertThat(again.statusCode()).as("reuse %d", i).isEqualTo(200);
    }
    assertThat(sessionRows()).isEqualTo(rows);
  }

  @Test
  void signInFlowKeepsWorkingWithinBudget() throws Exception {
    String source = "198.51.100.30";
    String email = "flow-" + UUID.randomUUID() + "@example.test";
    identities.register(email, PASSWORD, grants.issue("ENROLLMENT", email).code());

    HttpResponse<String> boot = send("GET", "/api/auth/csrf", source, null, null);
    String cookie = sessionCookie(boot);
    String token = mapper.readTree(boot.body()).path("token").asText();

    HttpResponse<String> login =
        send(
            "POST",
            "/api/auth/login",
            source,
            cookie,
            "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}",
            token);
    assertThat(login.statusCode()).isEqualTo(200);
    String authed = sessionCookie(login);

    HttpResponse<String> next = send("GET", "/api/auth/csrf", source, authed, null);
    assertThat(next.statusCode()).isEqualTo(200);
    HttpResponse<String> me = send("GET", "/api/auth/me", source, authed, null);
    assertThat(me.statusCode()).isEqualTo(200);
    assertThat(mapper.readTree(me.body()).path("email").asText()).isEqualTo(email);
  }

  private long sessionRows() {
    Long count = jdbc.queryForObject("SELECT count(*) FROM spring_session", Long.class);
    return count == null ? 0 : count;
  }

  private static String sessionCookie(HttpResponse<String> response) {
    return response.headers().allValues("Set-Cookie").stream()
        .filter(value -> value.startsWith("SESSION="))
        .map(value -> value.split(";", 2)[0])
        .findFirst()
        .orElseThrow();
  }

  private HttpResponse<String> send(
      String method, String path, String source, String cookie, String json) throws Exception {
    return send(method, path, source, cookie, json, null);
  }

  private HttpResponse<String> send(
      String method, String path, String source, String cookie, String json, String csrf)
      throws Exception {
    HttpRequest.Builder builder =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
            .timeout(Duration.ofSeconds(10))
            .header("X-Forwarded-For", source)
            .method(
                method,
                json == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(json));
    if (json != null) {
      builder.header("Content-Type", "application/json");
    }
    if (cookie != null) {
      builder.header("Cookie", cookie);
    }
    if (csrf != null) {
      builder.header("X-CSRF-TOKEN", csrf);
    }
    return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
  }
}
