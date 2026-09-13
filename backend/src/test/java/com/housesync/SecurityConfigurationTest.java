package com.housesync;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.invitation.application.InvitationService;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationServiceException;
import com.housesync.household.web.HouseholdResponse;
import com.housesync.identity.application.HouseSyncUserDetails;
import com.housesync.identity.application.HouseSyncUserDetailsService;
import com.housesync.identity.application.IdentityService;
import com.housesync.identity.web.SafeUserResponse;
import java.time.Instant;
import java.util.List;
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
  @MockitoBean private HouseholdService households;
  @MockitoBean private InvitationService invitations;

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
    "POST, /api/households",
    "GET, /api/households",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "GET, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "DELETE,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/invitations/123e4567-e89b-12d3-a456-426614174001",
    "POST, /api/invitations/preview",
    "POST, /api/invitations/accept",
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
    "PUT, /api/households",
    "PATCH, /api/households",
    "DELETE, /api/households",
    "POST, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000",
    "PUT, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "DELETE, /api/households/123e4567-e89b-12d3-a456-426614174000/invitations",
    "POST,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/invitations/123e4567-e89b-12d3-a456-426614174001",
    "GET,"
        + " /api/households/123e4567-e89b-12d3-a456-426614174000/invitations/123e4567-e89b-12d3-a456-426614174001",
    "GET, /api/invitations",
    "POST, /api/invitations",
    "GET, /api/invitations/preview",
    "PUT, /api/invitations/preview",
    "DELETE, /api/invitations/preview",
    "GET, /api/invitations/accept",
    "PUT, /api/invitations/accept",
    "GET, /api/households/a/b",
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
  void authenticatedHouseholdReadsUseMembershipScopedService() throws Exception {
    UUID actorId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    Instant createdAt = Instant.parse("2026-09-13T01:30:00Z");
    HouseholdResponse household =
        new HouseholdResponse(householdId, "Elm Street home", "OWNER", createdAt);
    when(households.list(eq(actorId))).thenReturn(List.of(household));
    when(households.get(eq(householdId), eq(actorId))).thenReturn(household);

    mvc.perform(get("/api/households").with(signedInAs(actorId)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.households[0].id").value(householdId.toString()))
        .andExpect(jsonPath("$.households[0].name").value("Elm Street home"))
        .andExpect(jsonPath("$.households[0].role").value("OWNER"))
        .andExpect(jsonPath("$.households[0].createdAt").value("2026-09-13T01:30:00Z"));

    mvc.perform(get("/api/households/" + householdId).with(signedInAs(actorId)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.id").value(householdId.toString()))
        .andExpect(jsonPath("$.role").value("OWNER"));
  }

  @Test
  void authenticatedHouseholdCreateReturnsCreatedHousehold() throws Exception {
    UUID actorId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    when(households.create(eq("Elm Street home"), eq(actorId)))
        .thenReturn(
            new HouseholdResponse(
                householdId, "Elm Street home", "OWNER", Instant.parse("2026-09-13T01:30:00Z")));
    mvc.perform(
            post("/api/households")
                .with(signedInAs(actorId))
                .with(csrf())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Elm Street home\"}"))
        .andExpect(status().isCreated())
        .andExpect(
            header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
        .andExpect(jsonPath("$.id").value(householdId.toString()))
        .andExpect(jsonPath("$.role").value("OWNER"));
  }

  @Test
  void unsafeHouseholdCreateWithoutCsrfIsRejectedWithCsrfInvalid() throws Exception {
    mvc.perform(
            post("/api/households")
                .with(signedInAs(UUID.randomUUID()))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Elm Street home\"}"))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("CSRF_INVALID"))
        .andExpect(jsonPath("$.correlationId").exists());
  }

  @Test
  void invitationServiceFailureIsSafeInternalError() throws Exception {
    UUID actorId = UUID.randomUUID();
    UUID householdId = UUID.randomUUID();
    when(invitations.create(eq(householdId), eq(actorId)))
        .thenThrow(new InvitationServiceException());
    mvc.perform(
            post("/api/households/" + householdId + "/invitations")
                .with(signedInAs(actorId))
                .with(csrf()))
        .andExpect(status().isInternalServerError())
        .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
        .andExpect(jsonPath("$.correlationId").exists())
        .andExpect(jsonPath("$.message").exists())
        .andExpect(
            header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
        .andExpect(
            content()
                .string(
                    org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.not(
                            org.hamcrest.Matchers.containsString("secret_hash")),
                        org.hamcrest.Matchers.not(
                            org.hamcrest.Matchers.containsString("household_invitations")),
                        org.hamcrest.Matchers.not(
                            org.hamcrest.Matchers.containsString("at com.housesync")))));
  }

  private static org.springframework.test.web.servlet.request.RequestPostProcessor signedInAs(
      UUID actorId) {
    HouseSyncUserDetails principal = new HouseSyncUserDetails(actorId, "person@example.test", null);
    return authentication(
        new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
            principal, null, List.of()));
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
