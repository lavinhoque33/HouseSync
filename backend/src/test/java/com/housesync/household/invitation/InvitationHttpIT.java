package com.housesync.household.invitation;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Invitation HTTP behavior against real PostgreSQL over HTTP with real
 * registration/login/session/CSRF flows: owner create/list/revoke, member/outsider denial, forged
 * capability fields, authenticated preview, exactly-once acceptance, existing-member acceptance,
 * same-actor replay, expiry, revocation, wrong secrets, safe errors/DTOs, and no-cache responses.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class InvitationHttpIT {

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
  void ownerCreateReturnsOneTimeCapabilityWithDigestOnlyStorage() throws Exception {
    Agent owner = signedInAgent("inv-owner");
    String householdId = createHousehold(owner, "Elm Street home");

    Resp created = owner.post(invitationPath(householdId), null, owner.csrfToken);
    assertThat(created.status).isEqualTo(201);
    JsonNode body = created.json();
    assertThat(body.propertyNames())
        .containsExactlyInAnyOrder("id", "secret", "createdAt", "expiresAt");
    String invitationId = body.path("id").asText();
    UUID.fromString(invitationId);
    String secret = body.path("secret").asText();
    assertThat(secret).matches("^[A-Za-z0-9_-]{43}$");
    Instant createdAt = Instant.parse(body.path("createdAt").asText());
    Instant expiresAt = Instant.parse(body.path("expiresAt").asText());
    assertThat(Duration.between(createdAt, expiresAt)).isEqualTo(Duration.ofHours(168));
    assertThat(created.cacheControl()).contains("no-store");
    assertThat(created.body).doesNotContain("passwordHash", "householdId", "acceptedBy");

    // Only the digest is persisted: SHA-256 of the decoded secret matches, the secret does not.
    byte[] raw = Base64.getUrlDecoder().decode(secret);
    assertThat(raw).hasSize(32);
    byte[] expected = MessageDigest.getInstance("SHA-256").digest(raw);
    byte[] stored =
        jdbc.queryForObject(
            "SELECT secret_hash FROM household_invitations WHERE id = ?::uuid",
            byte[].class,
            invitationId);
    assertThat(stored).isEqualTo(expected);
    assertThat(Base64.getEncoder().encodeToString(stored)).isNotEqualTo(secret);

    // Duplicate creates are independent invitations.
    Resp second = owner.post(invitationPath(householdId), null, owner.csrf());
    assertThat(second.status).isEqualTo(201);
    assertThat(second.json().path("id").asText()).isNotEqualTo(invitationId);
    assertThat(second.json().path("secret").asText()).isNotEqualTo(secret);
  }

  @Test
  void activeListIsOrderedAndExcludesTerminalRows() throws Exception {
    Agent owner = signedInAgent("inv-list");
    String householdId = createHousehold(owner, "Elm Street home");

    List<String> ids = new ArrayList<>();
    List<String> secrets = new ArrayList<>();
    for (int i = 0; i < 3; i++) {
      Resp created = owner.post(invitationPath(householdId), null, owner.csrf());
      assertThat(created.status).isEqualTo(201);
      ids.add(created.json().path("id").asText());
      secrets.add(created.json().path("secret").asText());
    }

    Resp listed = owner.get(invitationPath(householdId));
    assertThat(listed.status).isEqualTo(200);
    assertThat(listed.json().propertyNames()).containsExactly("invitations");
    assertThat(listed.json().path("invitations").size()).isEqualTo(3);
    for (JsonNode node : listed.json().path("invitations")) {
      assertThat(node.propertyNames()).containsExactlyInAnyOrder("id", "createdAt", "expiresAt");
      assertThat(node.toString()).doesNotContain("secret");
    }
    // Server ordering is createdAt then id: the response must already be sorted, including the
    // database UUID tie-break.
    List<UUID> actualOrder = new ArrayList<>();
    for (JsonNode node : listed.json().path("invitations")) {
      actualOrder.add(UUID.fromString(node.path("id").asText()));
    }
    List<UUID> expectedOrder =
        jdbc.queryForList(
            "SELECT id FROM household_invitations WHERE household_id = ?::uuid"
                + " AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()"
                + " ORDER BY created_at ASC, id ASC",
            UUID.class,
            householdId);
    assertThat(actualOrder).containsExactlyElementsOf(expectedOrder);
    assertThat(listed.cacheControl()).contains("no-store");

    // Expire the first, revoke the second, accept the third: only terminal-free rows remain,
    // and here none remain.
    expireInvitation(ids.get(0));
    Agent recipient = signedInAgent("inv-list-join");
    assertThat(
            owner.request(
                "DELETE", invitationPath(householdId) + "/" + ids.get(1), null, owner.csrfToken))
        .extracting(response -> response.status)
        .isEqualTo(204);
    assertThat(
            recipient.post(
                    "/api/invitations/accept",
                    capability(ids.get(2), secrets.get(2)),
                    recipient.csrfToken)
                .status)
        .isEqualTo(200);

    JsonNode relisted = owner.get(invitationPath(householdId)).json();
    assertThat(relisted.path("invitations").size()).isZero();
  }

  @Test
  void memberIsForbiddenWhileOutsiderSeesIndistinguishableHouseholdNotFound() throws Exception {
    Agent owner = signedInAgent("inv-owner-authz");
    String householdId = createHousehold(owner, "Elm Street home");
    Agent member = signedInAgent("inv-member-authz");
    String memberId = member.me().json().path("id").asText();
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid,"
            + " 'MEMBER')",
        householdId,
        memberId);
    Agent stranger = signedInAgent("inv-stranger-authz");

    // A current member knows the household but lacks owner powers: 403 FORBIDDEN everywhere.
    for (Resp denied :
        List.of(
            member.post(invitationPath(householdId), null, member.csrfToken),
            member.get(invitationPath(householdId)),
            member.request(
                "DELETE",
                invitationPath(householdId) + "/" + UUID.randomUUID(),
                null,
                member.csrfToken))) {
      assertThat(denied.status).isEqualTo(403);
      assertThat(denied.json().path("code").asText()).isEqualTo("FORBIDDEN");
      assertThat(denied.json().path("correlationId").asText()).isNotBlank();
      assertThat(denied.cacheControl()).contains("no-store");
    }

    // Missing and non-member households share one indistinguishable 404.
    String missingHousehold = UUID.randomUUID().toString();
    List<Resp> notFound =
        List.of(
            stranger.post(invitationPath(householdId), null, stranger.csrfToken),
            stranger.get(invitationPath(householdId)),
            stranger.post(invitationPath(missingHousehold), null, stranger.csrf()),
            stranger.get(invitationPath(missingHousehold)));
    for (Resp denied : notFound) {
      assertThat(denied.status).isEqualTo(404);
      assertThat(denied.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
      assertThat(denied.json().path("correlationId").asText()).isNotBlank();
    }
    assertThat(notFound.get(0).json().path("message").asText())
        .isEqualTo(notFound.get(2).json().path("message").asText());
    assertThat(notFound.get(0).body).doesNotContain(householdId);
    assertThat(notFound.get(0).body).doesNotContain("SQL", "at com.housesync");
  }

  @Test
  void revokeIsIdempotentNoOpWhileTerminalStatesAreGenericNotFound() throws Exception {
    Agent owner = signedInAgent("inv-revoke");
    String householdId = createHousehold(owner, "Elm Street home");
    String invitationId =
        owner.post(invitationPath(householdId), null, owner.csrfToken).json().path("id").asText();

    Resp revoked =
        owner.request(
            "DELETE", invitationPath(householdId) + "/" + invitationId, null, owner.csrf());
    assertThat(revoked.status).isEqualTo(204);
    assertThat(revoked.body).isEmpty();
    assertThat(revoked.cacheControl()).contains("no-store");

    // Repeating the revoke of the same revoked row is a successful no-op.
    Resp repeated =
        owner.request(
            "DELETE", invitationPath(householdId) + "/" + invitationId, null, owner.csrf());
    assertThat(repeated.status).isEqualTo(204);
    assertThat(repeated.cacheControl()).contains("no-store");

    // Accepted, expired, missing, and wrong-household IDs share one generic 404.
    Agent recipient = signedInAgent("inv-revoke-join");
    Resp accepted = owner.post(invitationPath(householdId), null, owner.csrf());
    String acceptedId = accepted.json().path("id").asText();
    assertThat(
            recipient.post(
                    "/api/invitations/accept",
                    capability(acceptedId, accepted.json().path("secret").asText()),
                    recipient.csrfToken)
                .status)
        .isEqualTo(200);
    Resp expired = owner.post(invitationPath(householdId), null, owner.csrf());
    String expiredId = expired.json().path("id").asText();
    expireInvitation(expiredId);
    String otherHousehold = createHousehold(owner, "Second home");
    String missingId = UUID.randomUUID().toString();

    List<Resp> terminal =
        List.of(
            owner.request(
                "DELETE", invitationPath(householdId) + "/" + acceptedId, null, owner.csrf()),
            owner.request(
                "DELETE", invitationPath(householdId) + "/" + expiredId, null, owner.csrf()),
            owner.request(
                "DELETE", invitationPath(householdId) + "/" + missingId, null, owner.csrf()),
            owner.request(
                "DELETE", invitationPath(otherHousehold) + "/" + invitationId, null, owner.csrf()));
    for (Resp denied : terminal) {
      assertThat(denied.status).isEqualTo(404);
      assertThat(denied.json().path("code").asText()).isEqualTo("INVITATION_NOT_FOUND");
      assertThat(denied.json().path("correlationId").asText()).isNotBlank();
      assertThat(denied.cacheControl()).contains("no-store");
    }
    assertThat(terminal.stream().map(response -> response.jsonUnchecked().path("message").asText()))
        .containsOnly(terminal.get(0).jsonUnchecked().path("message").asText());
    assertThat(terminal.get(0).body).doesNotContain(invitationId, "SQL", "at com.housesync");

    // Unsafe revoke without CSRF is rejected distinctly.
    Resp csrfDenied =
        owner.request("DELETE", invitationPath(householdId) + "/" + expiredId, null, null);
    assertThat(csrfDenied.status).isEqualTo(403);
    assertThat(csrfDenied.json().path("code").asText()).isEqualTo("CSRF_INVALID");
  }

  @Test
  void previewRevealsMinimalDtoAndHidesEveryTerminalState() throws Exception {
    Agent owner = signedInAgent("inv-preview");
    String householdId = createHousehold(owner, "Elm Street home");
    Resp created = owner.post(invitationPath(householdId), null, owner.csrfToken);
    String invitationId = created.json().path("id").asText();
    String secret = created.json().path("secret").asText();
    String expiresAt = created.json().path("expiresAt").asText();
    Agent recipient = signedInAgent("inv-preview-join");

    Resp preview =
        recipient.post(
            "/api/invitations/preview", capability(invitationId, secret), recipient.csrfToken);
    assertThat(preview.status).isEqualTo(200);
    assertThat(preview.json().propertyNames())
        .containsExactlyInAnyOrder("householdName", "role", "expiresAt");
    assertThat(preview.json().path("householdName").asText()).isEqualTo("Elm Street home");
    assertThat(preview.json().path("role").asText()).isEqualTo("MEMBER");
    assertThat(preview.json().path("expiresAt").asText()).isEqualTo(expiresAt);
    assertThat(preview.cacheControl()).contains("no-store");
    assertThat(preview.body).doesNotContain(invitationId, secret, householdId);

    // Wrong secret, missing record, expiry, revocation, and consumption by another actor share
    // one generic message that reveals no household metadata.
    assertThat(
            recipient.post(
                    "/api/invitations/accept",
                    capability(invitationId, secret),
                    recipient.csrfToken)
                .status)
        .isEqualTo(200);
    Agent outsider = signedInAgent("inv-preview-out");
    // A correctly shaped but unrelated secret is a capability miss, never a validation failure.
    String wrongSecret = InvitationSecretsForTest.valid();
    assertThat(wrongSecret).isNotEqualTo(secret);
    Resp expiredRow = owner.post(invitationPath(householdId), null, owner.csrf());
    String expiredId = expiredRow.json().path("id").asText();
    expireInvitation(expiredId);
    Resp revokedRow = owner.post(invitationPath(householdId), null, owner.csrf());
    String revokedId = revokedRow.json().path("id").asText();
    assertThat(
            owner.request(
                    "DELETE", invitationPath(householdId) + "/" + revokedId, null, owner.csrfToken)
                .status)
        .isEqualTo(204);

    List<Resp> misses =
        List.of(
            outsider.post(
                "/api/invitations/preview",
                capability(invitationId, wrongSecret),
                outsider.csrfToken),
            outsider.post(
                "/api/invitations/preview",
                capability(UUID.randomUUID().toString(), secret),
                outsider.csrf()),
            outsider.post(
                "/api/invitations/preview",
                capability(expiredId, expiredRow.json().path("secret").asText()),
                outsider.csrf()),
            outsider.post(
                "/api/invitations/preview",
                capability(revokedId, revokedRow.json().path("secret").asText()),
                outsider.csrf()),
            outsider.post(
                "/api/invitations/preview", capability(invitationId, secret), outsider.csrf()));
    for (Resp miss : misses) {
      assertThat(miss.status).isEqualTo(404);
      assertThat(miss.json().path("code").asText()).isEqualTo("INVITATION_NOT_FOUND");
      assertThat(miss.json().path("correlationId").asText()).isNotBlank();
      assertThat(miss.cacheControl()).contains("no-store");
    }
    assertThat(misses.stream().map(response -> response.jsonUnchecked().path("message").asText()))
        .containsOnly(misses.get(0).jsonUnchecked().path("message").asText());
    for (Resp miss : misses) {
      assertThat(miss.body)
          .doesNotContain("Elm Street home", householdId, invitationId, secret, "SQL");
    }
    // The consumed invitation also rejects acceptance by any other actor.
    Resp otherAccept =
        outsider.post("/api/invitations/accept", capability(invitationId, secret), outsider.csrf());
    assertThat(otherAccept.status).isEqualTo(404);
    assertThat(otherAccept.json().path("code").asText()).isEqualTo("INVITATION_NOT_FOUND");
  }

  @Test
  void acceptGrantsMemberExactlyOnce() throws Exception {
    Agent owner = signedInAgent("inv-accept");
    String householdId = createHousehold(owner, "Elm Street home");
    Resp created = owner.post(invitationPath(householdId), null, owner.csrfToken);
    String invitationId = created.json().path("id").asText();
    String secret = created.json().path("secret").asText();
    Agent recipient = signedInAgent("inv-accept-join");
    String recipientId = recipient.me().json().path("id").asText();

    Resp accepted =
        recipient.post(
            "/api/invitations/accept", capability(invitationId, secret), recipient.csrfToken);
    assertThat(accepted.status).isEqualTo(200);
    assertThat(accepted.json().propertyNames())
        .containsExactlyInAnyOrder("id", "name", "role", "createdAt");
    assertThat(accepted.json().path("id").asText()).isEqualTo(householdId);
    assertThat(accepted.json().path("name").asText()).isEqualTo("Elm Street home");
    assertThat(accepted.json().path("role").asText()).isEqualTo("MEMBER");
    assertThat(accepted.cacheControl()).contains("no-store");
    assertThat(accepted.body).doesNotContain(secret, invitationId);

    // Exactly one membership row exists for the new member.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid"
                    + " AND user_id = ?::uuid AND role = 'MEMBER'",
                Integer.class,
                householdId,
                recipientId))
        .isEqualTo(1);
    // The recipient's own collection now contains the joined household.
    assertThat(recipient.get("/api/households").json().path("households").size()).isEqualTo(1);

    // The capability is consumed: preview and further acceptance fail for everyone.
    assertThat(
            recipient.post(
                    "/api/invitations/preview", capability(invitationId, secret), recipient.csrf())
                .status)
        .isEqualTo(404);
    Agent outsider = signedInAgent("inv-accept-out");
    assertThat(
            outsider.post(
                    "/api/invitations/accept", capability(invitationId, secret), outsider.csrfToken)
                .status)
        .isEqualTo(404);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(2);
  }

  @Test
  void existingMemberAcceptConsumesAndReportsCurrentRole() throws Exception {
    Agent owner = signedInAgent("inv-existing");
    String householdId = createHousehold(owner, "Elm Street home");
    Resp created = owner.post(invitationPath(householdId), null, owner.csrfToken);
    String invitationId = created.json().path("id").asText();
    String secret = created.json().path("secret").asText();

    // The creating owner is already a member: acceptance still consumes and reports OWNER.
    Resp accepted =
        owner.post("/api/invitations/accept", capability(invitationId, secret), owner.csrf());
    assertThat(accepted.status).isEqualTo(200);
    assertThat(accepted.json().path("id").asText()).isEqualTo(householdId);
    assertThat(accepted.json().path("role").asText()).isEqualTo("OWNER");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(1);

    // The consumed invitation is gone for the owner too, and the owner list no longer shows it.
    assertThat(
            owner.post("/api/invitations/preview", capability(invitationId, secret), owner.csrf())
                .status)
        .isEqualTo(404);
    assertThat(owner.get(invitationPath(householdId)).json().path("invitations").size()).isZero();
  }

  @Test
  void sameActorReplaySucceedsWhileMemberAndNeverResurrectsRemoval() throws Exception {
    Agent owner = signedInAgent("inv-replay");
    String householdId = createHousehold(owner, "Elm Street home");
    Resp created = owner.post(invitationPath(householdId), null, owner.csrfToken);
    String invitationId = created.json().path("id").asText();
    String secret = created.json().path("secret").asText();
    Agent recipient = signedInAgent("inv-replay-join");
    String recipientId = recipient.me().json().path("id").asText();

    assertThat(
            recipient.post(
                    "/api/invitations/accept",
                    capability(invitationId, secret),
                    recipient.csrfToken)
                .status)
        .isEqualTo(200);
    // Same-actor replay returns the current membership-scoped household.
    Resp replay =
        recipient.post(
            "/api/invitations/accept", capability(invitationId, secret), recipient.csrf());
    assertThat(replay.status).isEqualTo(200);
    assertThat(replay.json().path("id").asText()).isEqualTo(householdId);
    assertThat(replay.json().path("role").asText()).isEqualTo("MEMBER");

    // After removal the replay is a 404 and never recreates membership.
    assertThat(
            jdbc.update(
                "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
                householdId,
                recipientId))
        .isEqualTo(1);
    Resp removed =
        recipient.post(
            "/api/invitations/accept", capability(invitationId, secret), recipient.csrf());
    assertThat(removed.status).isEqualTo(404);
    assertThat(removed.json().path("code").asText()).isEqualTo("INVITATION_NOT_FOUND");
    assertThat(removed.body).doesNotContain("Elm Street home", householdId);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid"
                    + " AND user_id = ?::uuid",
                Integer.class,
                householdId,
                recipientId))
        .isZero();
  }

  @Test
  void capabilityShapeValidationIsSafe() throws Exception {
    Agent recipient = signedInAgent("inv shapes");
    String csrf = recipient.csrfToken;

    // Malformed UUIDs are validation failures keyed on invitationId.
    Resp malformed =
        recipient.post(
            "/api/invitations/preview",
            "{\"invitationId\":\"not-a-uuid\",\"secret\":\""
                + InvitationSecretsForTest.valid()
                + "\"}",
            csrf);
    assertThat(malformed.status).isEqualTo(400);
    assertThat(malformed.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(malformed.json().path("fieldErrors").path("invitationId").asText()).isNotBlank();
    assertThat(malformed.body).doesNotContain("not-a-uuid", "SQL");

    // Non-canonical secrets (padded, short, wrong alphabet, wrong byte length) are validation
    // failures keyed on secret.
    String validId = UUID.randomUUID().toString();
    for (String badSecret :
        List.of(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+/",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA A",
            "",
            "null")) {
      String payload = "{\"invitationId\":\"" + validId + "\",\"secret\":\"" + badSecret + "\"}";
      Resp rejected = recipient.post("/api/invitations/preview", payload, recipient.csrf());
      assertThat(rejected.status).as("secret %s", badSecret).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("fieldErrors").path("secret").asText()).isNotBlank();
      assertThat(rejected.body).doesNotContain("SQL", "at com.housesync");
      Resp acceptRejected = recipient.post("/api/invitations/accept", payload, recipient.csrf());
      assertThat(acceptRejected.status).isEqualTo(400);
      assertThat(acceptRejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    // Missing values fail validation with safe field errors.
    for (String payload : List.of("{}", "{\"invitationId\":null,\"secret\":null}")) {
      Resp rejected = recipient.post("/api/invitations/preview", payload, recipient.csrf());
      assertThat(rejected.status).as("payload %s", payload).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    }
    Resp missingSecret =
        recipient.post(
            "/api/invitations/preview", "{\"invitationId\":\"" + validId + "\"}", recipient.csrf());
    assertThat(missingSecret.status).isEqualTo(400);
    assertThat(missingSecret.json().path("fieldErrors").path("secret").asText()).isNotBlank();

    // Forged household/user/role/owner/expiry/status fields are rejected, never bound.
    String forgedBase =
        "{\"invitationId\":\""
            + validId
            + "\",\"secret\":\""
            + InvitationSecretsForTest.valid()
            + "\"";
    for (String payload :
        List.of(
            forgedBase + ",\"householdId\":\"" + UUID.randomUUID() + "\"}",
            forgedBase + ",\"userId\":\"" + UUID.randomUUID() + "\"}",
            forgedBase + ",\"email\":\"other@example.test\"}",
            forgedBase + ",\"role\":\"OWNER\"}",
            forgedBase + ",\"role\":\"MEMBER\"}",
            forgedBase + ",\"ownerId\":\"" + UUID.randomUUID() + "\"}",
            forgedBase + ",\"expiresAt\":\"2026-09-20T04:00:00Z\"}",
            forgedBase + ",\"status\":\"ACTIVE\"}")) {
      Resp rejected = recipient.post("/api/invitations/preview", payload, recipient.csrf());
      assertThat(rejected.status).as("payload %s", payload).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    // Malformed JSON and unsupported media types stay safe.
    Resp malformedJson = recipient.post("/api/invitations/preview", "{not json", recipient.csrf());
    assertThat(malformedJson.status).isEqualTo(400);
    assertThat(malformedJson.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    HttpRequest mediaRequest =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/invitations/preview"))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "text/plain")
            .header("Cookie", "SESSION=" + recipient.sessionCookie)
            .header("X-CSRF-TOKEN", recipient.csrf())
            .POST(HttpRequest.BodyPublishers.ofString("invitationId=x"))
            .build();
    HttpResponse<String> media = client.send(mediaRequest, HttpResponse.BodyHandlers.ofString());
    assertThat(media.statusCode()).isEqualTo(415);

    // Malformed path UUIDs are safe 400s.
    Resp malformedPath = recipient.get("/api/households/not-a-uuid/invitations");
    assertThat(malformedPath.status).isEqualTo(400);
    assertThat(malformedPath.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(malformedPath.body).doesNotContain("not-a-uuid", "SQL");
  }

  @Test
  void anonymousAndCsrfDeniedInvitationAccess() throws Exception {
    Agent owner = signedInAgent("inv-denied");
    String householdId = createHousehold(owner, "Elm Street home");
    String invitationId =
        owner.post(invitationPath(householdId), null, owner.csrfToken).json().path("id").asText();

    Agent anonymous = new Agent();
    assertThat(anonymous.get(invitationPath(householdId)).status).isEqualTo(401);
    Resp anonymousCreate = anonymous.post(invitationPath(householdId), null, anonymous.csrf());
    assertThat(anonymousCreate.status).isEqualTo(401);
    assertThat(anonymousCreate.cacheControl()).contains("no-store");
    String payload =
        "{\"invitationId\":\""
            + invitationId
            + "\",\"secret\":\""
            + InvitationSecretsForTest.valid()
            + "\"}";
    Resp anonymousPreview = anonymous.post("/api/invitations/preview", payload, anonymous.csrf());
    assertThat(anonymousPreview.status).isEqualTo(401);
    assertThat(anonymousPreview.cacheControl()).contains("no-store");
    assertThat(
            anonymous
                .post("/api/invitations/preview", payload, anonymous.csrf())
                .json()
                .path("code")
                .asText())
        .isEqualTo("UNAUTHENTICATED");

    // Authenticated unsafe requests without CSRF are rejected distinctly.
    Agent recipient = signedInAgent("inv-denied-join");
    assertThat(owner.post(invitationPath(householdId), null, null).status).isEqualTo(403);
    assertThat(owner.post(invitationPath(householdId), null, null).json().path("code").asText())
        .isEqualTo("CSRF_INVALID");
    Resp csrfDeniedPreview = recipient.post("/api/invitations/preview", payload, null);
    assertThat(csrfDeniedPreview.json().path("code").asText()).isEqualTo("CSRF_INVALID");
    assertThat(csrfDeniedPreview.cacheControl()).contains("no-store");
    Resp csrfDeniedRevoke =
        owner.request("DELETE", invitationPath(householdId) + "/" + invitationId, null, null);
    assertThat(csrfDeniedRevoke.status).isEqualTo(403);
    assertThat(csrfDeniedRevoke.json().path("code").asText()).isEqualTo("CSRF_INVALID");
    assertThat(csrfDeniedRevoke.cacheControl()).contains("no-store");
    assertThat(recipient.post("/api/invitations/accept", payload, "not-the-token").status)
        .isEqualTo(403);
  }

  // --- helpers ---

  private static String invitationPath(String householdId) {
    return "/api/households/" + householdId + "/invitations";
  }

  private static String capability(String invitationId, String secret) {
    return "{\"invitationId\":\"" + invitationId + "\",\"secret\":\"" + secret + "\"}";
  }

  /**
   * Backdates an invitation into the expired state while preserving the {@code expires_at >
   * created_at} table check.
   */
  private void expireInvitation(String invitationId) {
    jdbc.update(
        "UPDATE household_invitations SET created_at = ?, expires_at = ? WHERE id = ?::uuid",
        Timestamp.from(Instant.now().minusSeconds(8 * 24 * 3600)),
        Timestamp.from(Instant.now().minusSeconds(60)),
        invitationId);
  }

  private String createHousehold(Agent owner, String name) throws Exception {
    Resp created = owner.post("/api/households", "{\"name\":\"" + name + "\"}", owner.csrfToken);
    assertThat(created.status).isEqualTo(201);
    return created.json().path("id").asText();
  }

  private Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String cleanTag = tag.replace(" ", "-");
    String email =
        cleanTag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    assertThat(agent.post("/api/auth/register", json(email), agent.csrf()).status).isEqualTo(201);
    assertThat(agent.post("/api/auth/login", json(email), agent.csrf()).status).isEqualTo(200);
    agent.csrf();
    return agent;
  }

  private static String json(String email) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
  }

  /** Generates real 43-character secrets without importing main-code helpers into assertions. */
  static final class InvitationSecretsForTest {
    static String valid() {
      byte[] raw = new byte[32];
      new java.security.SecureRandom().nextBytes(raw);
      return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }
  }

  record Resp(int status, String body, java.net.http.HttpHeaders headers) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }

    JsonNode jsonUnchecked() {
      try {
        return new ObjectMapper().readTree(body);
      } catch (Exception failure) {
        throw new IllegalStateException(failure);
      }
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
      return request("POST", path, json, csrf);
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
