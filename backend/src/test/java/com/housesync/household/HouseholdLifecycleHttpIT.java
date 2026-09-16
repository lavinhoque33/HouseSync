package com.housesync.household;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
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
 * Membership lifecycle over HTTP with real registration/login/session/CSRF flows against real
 * PostgreSQL: minimal roster visibility, strict role patch contract, owner removal, leave,
 * self-target rejection, missing/non-member equivalence, last-owner conflict, immediate stale
 * access denial, and invitation-write authority after role and membership changes.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class HouseholdLifecycleHttpIT {

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
  void rosterIsVisibleToEveryCurrentMemberWithMinimalOrderedShape() throws Exception {
    Agent owner = signedInAgent("lifowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("lifmember", owner, householdId);

    Resp ownerRoster = owner.get("/api/households/" + householdId + "/members");
    Resp memberRoster = member.get("/api/households/" + householdId + "/members");
    for (Resp roster : List.of(ownerRoster, memberRoster)) {
      assertThat(roster.status).isEqualTo(200);
      assertThat(roster.cacheControl()).contains("no-store");
      JsonNode body = roster.json();
      assertThat(body.propertyNames()).containsExactly("members");
      assertThat(body.path("members").size()).isEqualTo(2);
      for (JsonNode entry : body.path("members")) {
        assertThat(entry.propertyNames()).containsExactly("userId", "email", "role");
        assertThat(entry.path("role").asText()).isIn("OWNER", "MEMBER");
        UUID.fromString(entry.path("userId").asText());
        assertThat(entry.path("email").asText()).endsWith("@example.test");
      }
      assertThat(roster.body).doesNotContain(householdId, PASSWORD);
    }
    assertThat(memberRoster.json().path("members").size()).isEqualTo(2);

    // Ordered by email then user UUID: the response is already sorted.
    JsonNode members = ownerRoster.json().path("members");
    for (int index = 1; index < members.size(); index++) {
      String previousEmail = members.get(index - 1).path("email").asText();
      String currentEmail = members.get(index).path("email").asText();
      int emailOrder = previousEmail.compareTo(currentEmail);
      assertThat(emailOrder).isLessThanOrEqualTo(0);
      if (emailOrder == 0) {
        assertThat(
                UUID.fromString(members.get(index - 1).path("userId").asText())
                    .compareTo(UUID.fromString(members.get(index).path("userId").asText())))
            .isLessThan(0);
      }
    }
  }

  @Test
  void rosterDeniesAnonymousNonMemberAndMissingHouseholdIdentically() throws Exception {
    Agent owner = signedInAgent("rosterowner");
    String householdId = createdHousehold(owner, "Elm Street home");

    Resp anonymous = new Agent().get("/api/households/" + householdId + "/members");
    assertThat(anonymous.status).isEqualTo(401);
    assertThat(anonymous.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");

    Agent stranger = signedInAgent("rosterstranger");
    Resp nonMember = stranger.get("/api/households/" + householdId + "/members");
    Resp missing = stranger.get("/api/households/" + UUID.randomUUID() + "/members");
    for (Resp denied : List.of(nonMember, missing)) {
      assertThat(denied.status).isEqualTo(404);
      assertThat(denied.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
      assertThat(denied.json().path("correlationId").asText()).isNotBlank();
      assertThat(denied.cacheControl()).contains("no-store");
    }
    assertThat(nonMember.json().path("message").asText())
        .isEqualTo(missing.json().path("message").asText());
    assertThat(nonMember.body).doesNotContain(householdId);
    assertThat(missing.body).doesNotContain("SQL", "at com.housesync");
  }

  @Test
  void rolePatchRejectsMalformedShapesAndSelfTargeting() throws Exception {
    Agent owner = signedInAgent("patchowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("patchmember", owner, householdId);
    String memberId = member.me().json().path("id").asText();
    String path = "/api/households/" + householdId + "/members/" + memberId;

    // Only role may appear as a lifecycle field error, and only canonical names bind.
    for (String payload :
        List.of(
            "{}",
            "{\"role\":null}",
            "{\"role\":\"owner\"}",
            "{\"role\":\"ADMIN\"}",
            "{\"role\":\" OWNER\"}")) {
      Resp rejected = owner.request("PATCH", path, payload, owner.csrfToken);
      assertThat(rejected.status).as("payload %s", payload).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("fieldErrors").propertyNames()).containsExactly("role");
      assertThat(rejected.json().path("correlationId").asText()).isNotBlank();
    }

    // Unknown fields are rejected before any binding reaches the service.
    Resp forged =
        owner.request(
            "PATCH",
            path,
            "{\"role\":\"OWNER\",\"userId\":\"" + UUID.randomUUID() + "\"}",
            owner.csrfToken);
    assertThat(forged.status).isEqualTo(400);
    assertThat(forged.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    Resp malformed = owner.request("PATCH", path, "{not json", owner.csrfToken);
    assertThat(malformed.status).isEqualTo(400);
    assertThat(malformed.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(malformed.body).doesNotContain("SQL", "at com.housesync");

    // A missing PATCH body is the role validation error, never a 500.
    Resp missingBody = owner.request("PATCH", path, null, owner.csrfToken);
    assertThat(missingBody.status).isEqualTo(400);
    assertThat(missingBody.json().path("fieldErrors").path("role").asText()).isNotBlank();

    // Owner self-target mutation is a safe 400 that never echoes the requested ID.
    Resp selfPatch =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + owner.me().json().path("id").asText(),
            "{\"role\":\"MEMBER\"}",
            owner.csrfToken);
    assertThat(selfPatch.status).isEqualTo(400);
    assertThat(selfPatch.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(selfPatch.json().has("fieldErrors")).isFalse();
    assertThat(selfPatch.body).doesNotContain(owner.me().json().path("id").asText());

    // Unsupported media types stay safe 415 validation errors.
    HttpRequest media =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "text/plain")
            .header("Cookie", "SESSION=" + owner.sessionCookie)
            .header("X-CSRF-TOKEN", owner.csrfToken)
            .method("PATCH", HttpRequest.BodyPublishers.ofString("role=OWNER"))
            .build();
    HttpResponse<String> unsupported = client.send(media, HttpResponse.BodyHandlers.ofString());
    assertThat(unsupported.statusCode()).isEqualTo(415);
    assertThat(unsupported.body()).contains("correlationId").doesNotContain("at com.housesync");

    // A current member without owner authority gets 403, and nothing changes.
    Resp forbidden = member.request("PATCH", path, "{\"role\":\"OWNER\"}", member.csrfToken);
    assertThat(forbidden.status).isEqualTo(403);
    assertThat(forbidden.json().path("code").asText()).isEqualTo("FORBIDDEN");
    assertThat(
            jdbc.queryForObject(
                "SELECT role FROM household_members WHERE household_id = ?::uuid"
                    + " AND user_id = ?::uuid",
                String.class,
                householdId,
                memberId))
        .isEqualTo("MEMBER");

    // Malformed path UUIDs are safe 400s on the lifecycle routes.
    Resp malformedTarget =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/members/not-a-uuid",
            "{\"role\":\"OWNER\"}",
            owner.csrfToken);
    assertThat(malformedTarget.status).isEqualTo(400);
    assertThat(malformedTarget.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    Resp malformedRoster =
        owner.request("GET", "/api/households/not-a-uuid/members", null, owner.csrfToken);
    assertThat(malformedRoster.status).isEqualTo(400);
  }

  @Test
  void rolePatchPromotesDemotesAndReassignsIdempotently() throws Exception {
    Agent owner = signedInAgent("promoteowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("promotemember", owner, householdId);
    String memberId = member.me().json().path("id").asText();
    String memberEmail = member.me().json().path("email").asText();

    Resp promoted =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + memberId,
            "{\"role\":\"OWNER\"}",
            owner.csrfToken);
    assertThat(promoted.status).isEqualTo(200);
    assertThat(promoted.json().propertyNames()).containsExactly("userId", "email", "role");
    assertThat(promoted.json().path("role").asText()).isEqualTo("OWNER");
    assertThat(promoted.json().path("email").asText()).isEqualTo(memberEmail);
    assertThat(promoted.cacheControl()).contains("no-store");

    // Assigning the current role again is idempotent: the owner repeats the promotion.
    Resp repeated =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + memberId,
            "{\"role\":\"OWNER\"}",
            owner.csrfToken);
    assertThat(repeated.status).isEqualTo(200);
    assertThat(repeated.json().path("role").asText()).isEqualTo("OWNER");

    // Missing households and unknown targets are distinguished 404s while the actor is owner.
    Resp missingHousehold =
        owner.request(
            "PATCH",
            "/api/households/" + UUID.randomUUID() + "/members/" + memberId,
            "{\"role\":\"OWNER\"}",
            owner.csrfToken);
    assertThat(missingHousehold.status).isEqualTo(404);
    assertThat(missingHousehold.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp missingTarget =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + UUID.randomUUID(),
            "{\"role\":\"MEMBER\"}",
            owner.csrfToken);
    assertThat(missingTarget.status).isEqualTo(404);
    assertThat(missingTarget.json().path("code").asText()).isEqualTo("MEMBERSHIP_NOT_FOUND");
    assertThat(missingTarget.body).doesNotContain("SQL", "at com.housesync");

    // The promoted co-owner has equal authority and can demote the original owner.
    Resp demotedOwner =
        member.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + owner.me().json().path("id").asText(),
            "{\"role\":\"MEMBER\"}",
            member.csrfToken);
    assertThat(demotedOwner.status).isEqualTo(200);
    assertThat(demotedOwner.json().path("role").asText()).isEqualTo("MEMBER");

    // The demoted actor cannot restore another owner role without owner authority.
    Resp forbidden =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + memberId,
            "{\"role\":\"OWNER\"}",
            owner.csrf());
    assertThat(forbidden.status).isEqualTo(403);
    assertThat(forbidden.json().path("code").asText()).isEqualTo("FORBIDDEN");
  }

  @Test
  void deleteRemovesOnlyTheTargetAndRevokesTheirAccessImmediately() throws Exception {
    Agent owner = signedInAgent("delowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("delmember", owner, householdId);
    Agent other = joinedMember("delother", owner, householdId);
    String memberId = member.me().json().path("id").asText();
    String otherId = other.me().json().path("id").asText();

    Resp removed =
        owner.request(
            "DELETE",
            "/api/households/" + householdId + "/members/" + memberId,
            null,
            owner.csrfToken);
    assertThat(removed.status).isEqualTo(204);
    assertThat(removed.body).isEmpty();
    assertThat(removed.cacheControl()).contains("no-store");
    assertThat(removed.body).doesNotContain(memberId);

    // The removed member loses household, roster, and mutation access at once.
    assertThat(member.get("/api/households/" + householdId).status).isEqualTo(404);
    assertThat(member.get("/api/households/" + householdId + "/members").status).isEqualTo(404);

    // Removing a missing target is the generic membership 404; self-target is a safe 400.
    Resp missingTarget =
        owner.request(
            "DELETE",
            "/api/households/" + householdId + "/members/" + UUID.randomUUID(),
            null,
            owner.csrfToken);
    assertThat(missingTarget.status).isEqualTo(404);
    assertThat(missingTarget.json().path("code").asText()).isEqualTo("MEMBERSHIP_NOT_FOUND");
    Resp selfDelete =
        owner.request(
            "DELETE",
            "/api/households/" + householdId + "/members/" + owner.me().json().path("id").asText(),
            null,
            owner.csrfToken);
    assertThat(selfDelete.status).isEqualTo(400);
    assertThat(selfDelete.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    // The remaining roster is untouched and the owner keeps their own row.
    JsonNode roster =
        owner.get("/api/households/" + householdId + "/members").json().path("members");
    assertThat(roster.size()).isEqualTo(2);

    // A current member without owner authority cannot remove anyone.
    Resp forbidden =
        other.request(
            "DELETE",
            "/api/households/" + householdId + "/members/" + otherId,
            null,
            other.csrfToken);
    assertThat(forbidden.status).isEqualTo(403);
    assertThat(forbidden.json().path("code").asText()).isEqualTo("FORBIDDEN");
  }

  @Test
  void ownerRemovesACoOwnerWhileAnotherOwnerRemains() throws Exception {
    Agent firstOwner = signedInAgent("coownerfirst");
    String householdId = createdHousehold(firstOwner, "Elm Street home");
    Agent coOwner = joinedMember("coownerleave", firstOwner, householdId);
    Agent remainingOwner = joinedMember("coownernext", firstOwner, householdId);
    String coOwnerId = coOwner.me().json().path("id").asText();
    for (Agent promote : List.of(coOwner, remainingOwner)) {
      Resp promoted =
          firstOwner.request(
              "PATCH",
              "/api/households/"
                  + householdId
                  + "/members/"
                  + promote.me().json().path("id").asText(),
              "{\"role\":\"OWNER\"}",
              firstOwner.csrfToken);
      assertThat(promoted.status).isEqualTo(200);
    }

    Resp removed =
        firstOwner.request(
            "DELETE",
            "/api/households/" + householdId + "/members/" + coOwnerId,
            null,
            firstOwner.csrfToken);
    assertThat(removed.status).isEqualTo(204);
    assertThat(removed.body).isEmpty();
    assertThat(removed.cacheControl()).contains("no-store");

    // The removed co-owner loses household, roster, and invitation authority immediately.
    assertThat(coOwner.get("/api/households/" + householdId).status).isEqualTo(404);
    assertThat(coOwner.get("/api/households/" + householdId + "/members").status).isEqualTo(404);
    Resp deniedInvitation =
        coOwner.post("/api/households/" + householdId + "/invitations", "{}", coOwner.csrfToken);
    assertThat(deniedInvitation.status).isEqualTo(404);
    assertThat(deniedInvitation.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    // The two remaining owners keep the household: exactly two owner rows on the roster.
    JsonNode roster =
        remainingOwner.get("/api/households/" + householdId + "/members").json().path("members");
    assertThat(roster.size()).isEqualTo(2);
    int ownerRows = 0;
    for (int index = 0; index < roster.size(); index++) {
      if (roster.get(index).path("role").asText().equals("OWNER")) {
        ownerRows++;
      }
    }
    assertThat(ownerRows).isEqualTo(2);
  }

  @Test
  void leaveRemovesTheActorAndBlocksTheLastOwner() throws Exception {
    Agent owner = signedInAgent("leaveowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("leavemember", owner, householdId);

    Resp left = member.post("/api/households/" + householdId + "/leave", null, member.csrfToken);
    assertThat(left.status).isEqualTo(204);
    assertThat(left.cacheControl()).contains("no-store");
    assertThat(member.get("/api/households/" + householdId).status).isEqualTo(404);

    // Leaving again after departure is the generic household 404.
    Resp again = member.post("/api/households/" + householdId + "/leave", null, member.csrf());
    assertThat(again.status).isEqualTo(404);
    assertThat(again.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    // The last owner cannot leave: the household keeps its owner row.
    Resp blocked = owner.post("/api/households/" + householdId + "/leave", null, owner.csrfToken);
    assertThat(blocked.status).isEqualTo(409);
    assertThat(blocked.json().path("code").asText()).isEqualTo("LAST_OWNER_REQUIRED");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(1);

    // Unsafe leave needs CSRF: a session without the header is CSRF_INVALID.
    assertThat(owner.post("/api/households/" + householdId + "/leave", null, null).status)
        .isEqualTo(403);
    // A signed-out browser with a valid CSRF bootstrap is unauthenticated, not CSRF-failed.
    Agent anonymous = new Agent();
    assertThat(
            anonymous.post("/api/households/" + householdId + "/leave", null, anonymous.csrf())
                .status)
        .isEqualTo(401);
  }

  @Test
  void concurrentLeavesOfTwoOwnersKeepOneOwner() throws Exception {
    Agent owner = signedInAgent("raceowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("racemember", owner, householdId);
    // Promote the member so both are owners and either could be the last one.
    owner.request(
        "PATCH",
        "/api/households/" + householdId + "/members/" + member.me().json().path("id").asText(),
        "{\"role\":\"OWNER\"}",
        owner.csrfToken);

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Future<Resp>> attempts = new ArrayList<>();
      for (Agent actor : List.of(owner, member)) {
        attempts.add(
            pool.submit(
                (Callable<Resp>)
                    () -> {
                      start.await(10, TimeUnit.SECONDS);
                      return actor.post(
                          "/api/households/" + householdId + "/leave", null, actor.csrfToken);
                    }));
      }
      start.countDown();
      Resp first = attempts.get(0).get(60, TimeUnit.SECONDS);
      Resp second = attempts.get(1).get(60, TimeUnit.SECONDS);

      // One leave wins with an empty 204; the loser observes the last-owner invariant with 409.
      List<Integer> statuses = List.of(first.status, second.status);
      assertThat(statuses).containsExactlyInAnyOrder(204, 409);
      Resp losingLeave = first.status == 204 ? second : first;
      assertThat(losingLeave.json().path("code").asText()).isEqualTo("LAST_OWNER_REQUIRED");
      assertThat(
              jdbc.queryForObject(
                  "SELECT COUNT(*) FROM household_members WHERE household_id = ?::uuid"
                      + " AND role = 'OWNER'",
                  Integer.class,
                  householdId))
          .isEqualTo(1);
    } finally {
      pool.shutdownNow();
      pool.awaitTermination(30, TimeUnit.SECONDS);
    }
  }

  @Test
  void membershipChangesImmediatelyRevokeInvitationAuthority() throws Exception {
    Agent owner = signedInAgent("invowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("invmember", owner, householdId);

    // Promote the member, then demote the original owner through the target endpoint.
    owner.request(
        "PATCH",
        "/api/households/" + householdId + "/members/" + member.me().json().path("id").asText(),
        "{\"role\":\"OWNER\"}",
        owner.csrfToken);
    Resp demoted =
        member.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + owner.me().json().path("id").asText(),
            "{\"role\":\"MEMBER\"}",
            member.csrfToken);
    assertThat(demoted.status).isEqualTo(200);

    // The demoted owner loses owner-authorized invitation writes immediately.
    Resp deniedCreate =
        owner.post("/api/households/" + householdId + "/invitations", "{}", owner.csrfToken);
    assertThat(deniedCreate.status).isEqualTo(403);
    assertThat(deniedCreate.json().path("code").asText()).isEqualTo("FORBIDDEN");
    Resp deniedList = owner.get("/api/households/" + householdId + "/invitations");
    assertThat(deniedList.status).isEqualTo(403);

    // The remaining co-owner removes the demoted actor; the removed member is then
    // indistinguishable from a missing household on invitation routes.
    Resp removed =
        member.request(
            "DELETE",
            "/api/households/" + householdId + "/members/" + owner.me().json().path("id").asText(),
            null,
            member.csrfToken);
    assertThat(removed.status).isEqualTo(204);
    Resp removedInvitation =
        owner.post("/api/households/" + householdId + "/invitations", "{}", owner.csrfToken);
    assertThat(removedInvitation.status).isEqualTo(404);
    assertThat(removedInvitation.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
  }

  @Test
  void unimplementedLifecycleMethodShapesStayDenied() throws Exception {
    Agent owner = signedInAgent("shapesowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    Agent member = joinedMember("shapesmember", owner, householdId);
    String memberId = member.me().json().path("id").asText();

    assertThat(
            owner.request(
                    "PUT",
                    "/api/households/" + householdId + "/members/" + memberId,
                    "{\"role\":\"OWNER\"}",
                    owner.csrfToken)
                .status)
        .isEqualTo(403);
    assertThat(
            owner.request(
                    "POST", "/api/households/" + householdId + "/members", "{}", owner.csrfToken)
                .status)
        .isEqualTo(403);
    assertThat(
            owner.request(
                    "GET", "/api/households/" + householdId + "/members/" + memberId, null, null)
                .status)
        .isEqualTo(403);
    assertThat(owner.request("GET", "/api/households/" + householdId + "/leave", null, null).status)
        .isEqualTo(403);
    assertThat(
            owner.request(
                    "DELETE",
                    "/api/households/" + householdId + "/members/" + memberId + "/extra",
                    null,
                    null)
                .status)
        .isEqualTo(403);
  }

  @Test
  void expiredSessionLosesLifecycleAccess() throws Exception {
    Agent owner = signedInAgent("expiryowner");
    String householdId = createdHousehold(owner, "Elm Street home");
    assertThat(owner.get("/api/households/" + householdId + "/members").status).isEqualTo(200);
    jdbc.update(
        "DELETE FROM spring_session WHERE session_id = ?",
        new String(Base64.getDecoder().decode(owner.sessionCookie)));
    Resp denied = owner.get("/api/households/" + householdId + "/members");
    assertThat(denied.status).isEqualTo(401);
    assertThat(denied.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");
  }

  // --- helpers ---

  private String createdHousehold(Agent agent, String name) throws Exception {
    Resp created = agent.post("/api/households", "{\"name\":\"" + name + "\"}", agent.csrfToken);
    assertThat(created.status).isEqualTo(201);
    return created.json().path("id").asText();
  }

  /** Joins through the real invitation flow: owner creates, member previews and accepts. */
  private Agent joinedMember(String tag, Agent owner, String householdId) throws Exception {
    Agent member = signedInAgent(tag);
    Resp invitation =
        owner.post("/api/households/" + householdId + "/invitations", "{}", owner.csrfToken);
    assertThat(invitation.status).isEqualTo(201);
    String invitationId = invitation.json().path("id").asText();
    String secret = invitation.json().path("secret").asText();
    String capability = "{\"invitationId\":\"" + invitationId + "\",\"secret\":\"" + secret + "\"}";
    assertThat(member.post("/api/invitations/accept", capability, member.csrfToken).status)
        .isEqualTo(200);
    return member;
  }

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
      return request("POST", path, json == null ? null : json, csrf);
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
