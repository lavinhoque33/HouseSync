package com.housesync;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.housesync.identity.application.HouseSyncUserDetailsService;
import com.housesync.identity.application.IdentityService;
import com.housesync.identity.web.SafeUserResponse;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
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
  @MockitoBean private IdentityService identities;
  @MockitoBean private HouseSyncUserDetailsService userDetails;

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
    "GET, /api/auth/me",
    "POST, /actuator/health",
    "PUT, /actuator/health",
    "PATCH, /actuator/health",
    "DELETE, /actuator/health",
    "HEAD, /actuator/health",
    "OPTIONS, /actuator/health",
    "POST, /actuator/health/liveness",
    "POST, /actuator/health/readiness"
  })
  void anonymousRequestsToUnimplementedRoutesAreUnauthorized(String method, String path)
      throws Exception {
    // A valid CSRF token proves unsafe requests reach authorization (and the JSON entry point).
    mvc.perform(MockMvcRequestBuilders.request(HttpMethod.valueOf(method), path).with(csrf()))
        .andExpect(status().isUnauthorized())
        .andExpect(
            header()
                .string("Content-Type", org.hamcrest.Matchers.containsString("application/json")))
        .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"))
        .andExpect(jsonPath("$.correlationId").exists())
        .andExpect(jsonPath("$.message").exists());
  }

  @ParameterizedTest
  @CsvSource({
    "GET, /test/protected",
    "GET, /api/unknown",
    "POST, /actuator/health",
  })
  void authenticatedRequestsToUnimplementedRoutesAreForbidden(String method, String path)
      throws Exception {
    mvc.perform(
            MockMvcRequestBuilders.request(HttpMethod.valueOf(method), path)
                .with(user("test-user"))
                .with(csrf()))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("FORBIDDEN"))
        .andExpect(jsonPath("$.correlationId").exists());
  }

  @ParameterizedTest
  @ValueSource(strings = {"/api/auth/register", "/api/auth/login", "/api/auth/logout"})
  void unsafeAuthRequestsWithoutCsrfAreRejectedWithCsrfInvalid(String path) throws Exception {
    mvc.perform(
            post(path)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"email\":\"person@example.test\",\"password\":\"long-enough-password\"}"))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("CSRF_INVALID"))
        .andExpect(jsonPath("$.correlationId").exists());
  }

  @Test
  void anonymousLogoutWithValidCsrfIsSafe() throws Exception {
    mvc.perform(post("/api/auth/logout").with(csrf())).andExpect(status().isNoContent());
  }

  @Test
  void registerDelegatesToIdentityServiceAndReturnsSafeUser() throws Exception {
    UUID id = UUID.randomUUID();
    when(identities.register(any(), any()))
        .thenReturn(new SafeUserResponse(id, "person@example.test"));
    mvc.perform(
            post("/api/auth/register")
                .with(csrf())
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"email\":\"Person@Example.TEST\",\"password\":\"long-enough-password\"}"))
        .andExpect(status().isCreated())
        .andExpect(jsonPath("$.id").value(id.toString()))
        .andExpect(jsonPath("$.email").value("person@example.test"))
        .andExpect(jsonPath("$.password").doesNotExist())
        .andExpect(jsonPath("$.passwordHash").doesNotExist());
  }

  @RestController
  static class ProtectedController {

    @GetMapping("/test/protected")
    String protectedEndpoint() {
      return "must never be exposed";
    }
  }
}
