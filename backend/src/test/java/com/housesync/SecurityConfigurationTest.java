package com.housesync;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootTest(
    properties = {
      "DB_PASSWORD=unit-test-only",
      "spring.autoconfigure.exclude="
          + "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration,"
          + "org.springframework.boot.hibernate.autoconfigure.HibernateJpaAutoConfiguration,"
          + "org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration",
      "management.endpoint.health.group.readiness.include=readinessState"
    })
@AutoConfigureMockMvc
@Import(SecurityConfigurationTest.ProtectedController.class)
class SecurityConfigurationTest {

  @Autowired private MockMvc mvc;

  @ParameterizedTest
  @ValueSource(
      strings = {"/actuator/health", "/actuator/health/liveness", "/actuator/health/readiness"})
  void healthIsPublicAndDoesNotExposeDetails(String path) throws Exception {
    mvc.perform(get(path))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("UP"))
        .andExpect(jsonPath("$.components").doesNotExist())
        .andExpect(jsonPath("$.details").doesNotExist());
  }

  @ParameterizedTest
  @CsvSource({
    "GET, /test/protected",
    "GET, /api/unknown",
    "GET, /actuator",
    "GET, /actuator/env",
    "GET, /actuator/health/db",
    "GET, /actuator/health/readiness/db",
    "GET, /login",
    "POST, /actuator/health",
    "PUT, /actuator/health",
    "PATCH, /actuator/health",
    "DELETE, /actuator/health",
    "HEAD, /actuator/health",
    "OPTIONS, /actuator/health",
    "POST, /actuator/health/liveness",
    "POST, /actuator/health/readiness"
  })
  void everythingElseIsForbidden(String method, String path) throws Exception {
    // A valid CSRF token proves unsafe requests are rejected by authorization as well.
    mvc.perform(request(HttpMethod.valueOf(method), path).with(csrf()))
        .andExpect(status().isForbidden());
  }

  @Test
  void evenAnAuthenticatedUserCannotAccessProtectedEndpoints() throws Exception {
    mvc.perform(get("/test/protected").with(user("test-user"))).andExpect(status().isForbidden());
  }

  @RestController
  static class ProtectedController {

    @GetMapping("/test/protected")
    String protectedEndpoint() {
      return "must never be exposed";
    }
  }
}
