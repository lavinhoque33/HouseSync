package com.housesync.identity;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.ObjectMapper;

/**
 * Source-address throttle at production defaults (30 attempts/minute): invalid registration shapes
 * never reach password hashing, so the boundary is exercised quickly and deterministically.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class AuthIpRateLimitIT {

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
  void thirtiethFirstAttemptsPassAndThirtyFirstIsRateLimited() throws Exception {
    String session = bootstrap();
    String token = csrfToken(session);
    // Invalid shapes are counted before validation/password work: 30 fast 400s, then 429.
    for (int i = 0; i < 30; i++) {
      HttpResponse<String> response =
          register(session, token, "{\"email\":\"bad-" + i + "\",\"password\":\"x\"}");
      assertThat(response.statusCode()).as("attempt %d", i).isEqualTo(400);
    }
    HttpResponse<String> limited =
        register(session, token, "{\"email\":\"bad-final\",\"password\":\"x\"}");
    assertThat(limited.statusCode()).isEqualTo(429);
    String retryAfter = limited.headers().firstValue("Retry-After").orElseThrow();
    assertThat(Integer.parseInt(retryAfter)).isPositive();
    assertThat(mapper.readTree(limited.body()).path("code").asText()).isEqualTo("RATE_LIMITED");
    assertThat(mapper.readTree(limited.body()).path("correlationId").asText()).isNotBlank();
  }

  private String bootstrap() throws Exception {
    HttpResponse<String> response =
        client.send(
            HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/csrf"))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build(),
            HttpResponse.BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(200);
    return response.headers().allValues("Set-Cookie").stream()
        .filter(value -> value.startsWith("SESSION="))
        .map(value -> value.split(";", 2)[0].substring("SESSION=".length()))
        .findFirst()
        .orElseThrow();
  }

  private String csrfToken(String session) throws Exception {
    HttpResponse<String> response =
        client.send(
            HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/csrf"))
                .timeout(Duration.ofSeconds(10))
                .header("Cookie", "SESSION=" + session)
                .GET()
                .build(),
            HttpResponse.BodyHandlers.ofString());
    return mapper.readTree(response.body()).path("token").asText();
  }

  private HttpResponse<String> register(String session, String token, String json)
      throws Exception {
    return client.send(
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/register"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json")
            .header("Cookie", "SESSION=" + session)
            .header("X-CSRF-TOKEN", token)
            .POST(HttpRequest.BodyPublishers.ofString(json))
            .build(),
        HttpResponse.BodyHandlers.ofString());
  }
}
