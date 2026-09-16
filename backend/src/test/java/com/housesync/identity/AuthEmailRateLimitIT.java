package com.housesync.identity;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.ObjectMapper;

/**
 * Per-email login throttle: a narrowed window (3 attempts) keeps the HTTP boundary fast while the
 * production 10-attempt/10-minute values stay covered by configuration defaults and {@code
 * AuthRateLimiterTest}. Attempts are counted before password hashing.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      "app.auth.ip-max-attempts=1000",
      "app.auth.login-email-max-attempts=3",
      "app.auth.login-email-window-seconds=600"
    })
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class AuthEmailRateLimitIT {

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

  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void loginEmailBudgetReturnsRetryAfterBeforePasswordWork() throws Exception {
    String email =
        "limited"
            + UUID.randomUUID().toString().replace("-", "").substring(0, 12)
            + "@example.test";
    Agent agent = new Agent();
    assertThat(agent.post("/api/auth/register", json(email, PASSWORD)).status).isEqualTo(201);

    for (int i = 0; i < 3; i++) {
      Agent attempt = new Agent();
      int denied = attempt.post("/api/auth/login", json(email, "wrong password here!")).status;
      assertThat(denied).as("attempt %d", i).isEqualTo(401);
    }
    Agent throttled = new Agent();
    FullResp limited = throttled.post("/api/auth/login", json(email, "wrong password here!"));
    assertThat(limited.status).isEqualTo(429);
    assertThat(Integer.parseInt(limited.retryAfter)).isPositive();
    assertThat(mapper.readTree(limited.body).path("code").asText()).isEqualTo("RATE_LIMITED");

    // A different identifier still authenticates attempts normally.
    Agent other = new Agent();
    FullResp unknown =
        other.post(
            "/api/auth/login",
            json(
                "ghost"
                    + UUID.randomUUID().toString().replace("-", "").substring(0, 12)
                    + "@example.test",
                "wrong password here!"));
    assertThat(unknown.status).isEqualTo(401);
  }

  private static String json(String email, String password) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + password + "\"}";
  }

  record FullResp(int status, String body, String retryAfter) {}

  /** Local browser: own SESSION jar plus in-memory CSRF token. */
  class Agent {
    String sessionCookie;
    String csrfToken;

    FullResp post(String path, String json) throws Exception {
      if (csrfToken == null) {
        HttpResponse<String> bootstrap =
            client.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/csrf"))
                    .timeout(Duration.ofSeconds(10))
                    .GET()
                    .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(bootstrap.statusCode()).isEqualTo(200);
        remember(bootstrap);
        csrfToken = mapper.readTree(bootstrap.body()).path("token").asText();
      }
      HttpResponse<String> response =
          client.send(
              HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                  .timeout(Duration.ofSeconds(10))
                  .header("Content-Type", "application/json")
                  .header("Cookie", "SESSION=" + sessionCookie)
                  .header("X-CSRF-TOKEN", csrfToken)
                  .POST(HttpRequest.BodyPublishers.ofString(json))
                  .build(),
              HttpResponse.BodyHandlers.ofString());
      remember(response);
      return new FullResp(
          response.statusCode(),
          response.body(),
          response.headers().firstValue("Retry-After").orElse(null));
    }

    private void remember(HttpResponse<String> response) {
      for (String setCookie : response.headers().allValues("Set-Cookie")) {
        String pair = setCookie.split(";", 2)[0];
        if (pair.startsWith("SESSION=")) {
          sessionCookie = pair.substring("SESSION=".length());
        }
      }
    }
  }
}
