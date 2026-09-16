package com.housesync.finance.account;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
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

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class FinancialAccountHttpIT {

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

  @Autowired private JdbcTemplate jdbc;
  @Autowired private DataSource dataSource;
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void bothRolesCreatePrivateAccountsWithExactDtoAndBoundedLists() throws Exception {
    Agent owner = signedInAgent("owner-create");
    String householdId = createHousehold(owner, "Elm Street home");
    Agent member = signedInAgent("member-create");
    addMember(householdId, member.userId(), "MEMBER");

    Resp ownerCreated =
        owner.createAccount(householdId, UUID.randomUUID(), "Daily spending", "CHECKING", "BRL");
    Resp memberCreated =
        member.createAccount(householdId, UUID.randomUUID(), "Cash", "CASH", "JPY");
    Resp ownerSecond =
        owner.createAccount(householdId, UUID.randomUUID(), "Second account", "SAVINGS", "USD");

    assertThat(ownerCreated.status).isEqualTo(201);
    assertAccount(
        ownerCreated.json(), householdId, owner.userId(), "Daily spending", "CHECKING", "BRL");
    assertThat(ownerCreated.json().propertyNames())
        .containsExactlyInAnyOrder(
            "id",
            "householdId",
            "ownerUserId",
            "name",
            "kind",
            "currency",
            "source",
            "visibility",
            "status",
            "version",
            "createdAt",
            "updatedAt");
    assertThat(ownerCreated.cacheControl()).contains("no-store");
    assertThat(Instant.parse(ownerCreated.json().path("createdAt").asText()))
        .isBefore(Instant.now().plusSeconds(60));
    assertThat(memberCreated.status).isEqualTo(201);
    assertAccount(memberCreated.json(), householdId, member.userId(), "Cash", "CASH", "JPY");
    assertThat(ownerSecond.status).isEqualTo(201);

    JsonNode ownerList =
        owner.get(accountPath(householdId) + "?limit=1&offset=0&status=ACTIVE").json();
    assertThat(ownerList.propertyNames())
        .containsExactlyInAnyOrder("items", "limit", "offset", "hasMore");
    assertThat(ownerList.path("items").size()).isEqualTo(1);
    assertThat(ownerList.path("items").get(0).path("ownerUserId").asText())
        .isEqualTo(owner.userId());
    assertThat(ownerList.path("items").get(0).path("name").asText()).isEqualTo("Daily spending");
    assertThat(ownerList.path("limit").asInt()).isEqualTo(1);
    assertThat(ownerList.path("offset").asInt()).isZero();
    assertThat(ownerList.path("hasMore").asBoolean()).isTrue();

    JsonNode ownerSecondPage = owner.get(accountPath(householdId) + "?limit=1&offset=1").json();
    assertThat(ownerSecondPage.path("items").size()).isEqualTo(1);
    assertThat(ownerSecondPage.path("items").get(0).path("name").asText())
        .isEqualTo("Second account");
    assertThat(ownerSecondPage.path("hasMore").asBoolean()).isFalse();

    JsonNode memberList = member.get(accountPath(householdId)).json();
    assertThat(memberList.path("items").size()).isEqualTo(1);
    assertThat(memberList.path("items").get(0).path("name").asText()).isEqualTo("Cash");
    assertThat(ownerList.toString()).doesNotContain("Cash");
    assertThat(memberList.toString()).doesNotContain("Daily spending", "Second account");
  }

  @Test
  void householdOwnerCannotReadOrMutateAnotherMembersPrivateAccount() throws Exception {
    Agent owner = signedInAgent("owner-private");
    String householdId = createHousehold(owner, "Privacy home");
    Agent member = signedInAgent("member-private");
    addMember(householdId, member.userId(), "MEMBER");
    JsonNode created =
        member
            .createAccount(householdId, UUID.randomUUID(), "Private card", "CREDIT_CARD", "USD")
            .json();
    String accountId = created.path("id").asText();

    Resp hidden = owner.get(accountPath(householdId) + "/" + accountId);
    Resp missing = owner.get(accountPath(householdId) + "/" + UUID.randomUUID());
    for (Resp response : List.of(hidden, missing)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("FINANCIAL_ACCOUNT_NOT_FOUND");
      assertThat(response.body).doesNotContain("Private card", accountId);
    }
    assertThat(hidden.json().path("message").asText())
        .isEqualTo(missing.json().path("message").asText());

    Resp forbiddenUpdate =
        owner.patchAccount(
            householdId, accountId, "{\"expectedVersion\":0,\"status\":\"ARCHIVED\"}");
    assertThat(forbiddenUpdate.status).isEqualTo(404);
    assertThat(owner.get(accountPath(householdId)).json().path("items").size()).isZero();

    Agent outsider = signedInAgent("outsider-private");
    Resp outsiderDetail = outsider.get(accountPath(householdId) + "/" + accountId);
    Resp outsiderMissingDetail = outsider.get(accountPath(householdId) + "/" + UUID.randomUUID());
    Resp outsiderList = outsider.get(accountPath(householdId));
    for (Resp response : List.of(outsiderDetail, outsiderMissingDetail, outsiderList)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
      assertThat(response.body).doesNotContain("Private card", accountId);
    }
  }

  @Test
  void createIsDurablyIdempotentAndConcurrentDuplicatesProduceOneAccount() throws Exception {
    Agent actor = signedInAgent("idempotency");
    String householdId = createHousehold(actor, "Retry home");
    UUID key = UUID.randomUUID();

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Future<Resp>> futures = new ArrayList<>();
      for (int index = 0; index < 2; index++) {
        futures.add(
            pool.submit(
                () -> {
                  start.await(10, TimeUnit.SECONDS);
                  return actor.createAccount(householdId, key, "Retry account", "SAVINGS", "EUR");
                }));
      }
      start.countDown();
      Resp first = futures.get(0).get(30, TimeUnit.SECONDS);
      Resp second = futures.get(1).get(30, TimeUnit.SECONDS);
      assertThat(List.of(first.status, second.status)).containsExactlyInAnyOrder(200, 201);
      assertThat(first.json().path("id").asText()).isEqualTo(second.json().path("id").asText());
    } finally {
      pool.shutdownNow();
    }

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_account_idempotency_keys"
                    + " WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(1);

    Resp conflict = actor.createAccount(householdId, key, "Changed payload", "SAVINGS", "EUR");
    assertThat(conflict.status).isEqualTo(409);
    assertThat(conflict.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    assertThat(conflict.body).doesNotContain("Retry account", "Changed payload", key.toString());
  }

  @Test
  void updateSupportsRenameArchiveUnarchiveNoOpAndRejectsStaleVersions() throws Exception {
    Agent actor = signedInAgent("updates");
    String householdId = createHousehold(actor, "Version home");
    UUID createKey = UUID.randomUUID();
    JsonNode created =
        actor.createAccount(householdId, createKey, "Main", "CHECKING", "GBP").json();
    String accountId = created.path("id").asText();

    Resp renamed =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":0,\"name\":\"  Daily main  \"}");
    assertThat(renamed.status).isEqualTo(200);
    assertThat(renamed.json().path("name").asText()).isEqualTo("Daily main");
    assertThat(renamed.json().path("version").asInt()).isEqualTo(1);
    assertThat(renamed.json().path("kind").asText()).isEqualTo("CHECKING");
    assertThat(renamed.json().path("currency").asText()).isEqualTo("GBP");

    Resp stale =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":0,\"status\":\"ARCHIVED\"}");
    assertThat(stale.status).isEqualTo(409);
    assertThat(stale.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    Resp archived =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":1,\"status\":\"ARCHIVED\"}");
    assertThat(archived.status).isEqualTo(200);
    assertThat(archived.json().path("status").asText()).isEqualTo("ARCHIVED");
    assertThat(archived.json().path("version").asInt()).isEqualTo(2);
    assertThat(actor.get(accountPath(householdId)).json().path("items").size()).isZero();
    assertThat(actor.get(accountPath(householdId) + "?status=ARCHIVED").json().path("items").size())
        .isEqualTo(1);

    Resp noOp =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":2,\"status\":\"ARCHIVED\"}");
    assertThat(noOp.status).isEqualTo(200);
    assertThat(noOp.json().path("version").asInt()).isEqualTo(2);

    Resp active =
        actor.patchAccount(householdId, accountId, "{\"expectedVersion\":2,\"status\":\"ACTIVE\"}");
    assertThat(active.json().path("status").asText()).isEqualTo("ACTIVE");
    assertThat(active.json().path("version").asInt()).isEqualTo(3);

    Resp archivedAgain =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":3,\"status\":\"ARCHIVED\"}");
    assertThat(archivedAgain.status).isEqualTo(200);

    // Same-key replay returns the current representation, not a re-created or stale snapshot.
    Resp replay = actor.createAccount(householdId, createKey, "Main", "CHECKING", "GBP");
    assertThat(replay.status).isEqualTo(200);
    assertThat(replay.json().path("id").asText()).isEqualTo(accountId);
    assertThat(replay.json().path("name").asText()).isEqualTo("Daily main");
    assertThat(replay.json().path("status").asText()).isEqualTo("ARCHIVED");
    assertThat(replay.json().path("version").asInt()).isEqualTo(4);
    assertThat(replay.cacheControl()).contains("no-store");

    // U+2028/U+2029 trim at the outer boundary and the stored row passes the V6 CHECK (200).
    Resp separatedRename =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":4,\"name\":\"\\u2028 Renamed \\u2029\"}");
    assertThat(separatedRename.status).isEqualTo(200);
    assertThat(separatedRename.json().path("name").asText()).isEqualTo("Renamed");
    assertThat(separatedRename.json().path("version").asInt()).isEqualTo(5);
  }

  @Test
  void strictValidationRejectsForgedFieldsQueriesDuplicateKeysAndMalformedInput() throws Exception {
    Agent actor = signedInAgent("validation");
    String householdId = createHousehold(actor, "Validation home");
    String path = accountPath(householdId);

    List<Resp> rejected =
        List.of(
            actor.request("POST", path, "{}", actor.csrfToken, UUID.randomUUID()),
            actor.request(
                "POST",
                path,
                "{\"name\":\"Bad\",\"kind\":\"BANK\",\"currency\":\"CAD\"}",
                actor.csrfToken,
                UUID.randomUUID()),
            actor.request(
                "POST",
                path,
                "{\"name\":\"One\",\"name\":\"Two\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
                actor.csrfToken,
                UUID.randomUUID()),
            actor.request(
                "POST",
                path,
                "{\"name\":123,\"kind\":\"CASH\",\"currency\":\"USD\"}",
                actor.csrfToken,
                UUID.randomUUID()),
            actor.request(
                "POST",
                path,
                "{\"name\":\"Bad\",\"kind\":true,\"currency\":\"USD\"}",
                actor.csrfToken,
                UUID.randomUUID()),
            actor.request(
                "POST",
                path,
                "{\"name\":\"Bad\",\"kind\":\"CASH\",\"currency\":\"USD\",\"ownerUserId\":\""
                    + UUID.randomUUID()
                    + "\"}",
                actor.csrfToken,
                UUID.randomUUID()),
            actor.request("POST", path, "{not json", actor.csrfToken, UUID.randomUUID()),
            actor.request(
                "POST",
                path + "?unexpected=x",
                "{\"name\":\"Bad\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
                actor.csrfToken,
                UUID.randomUUID()),
            actor.request(
                "POST",
                path,
                "{\"name\":\"Bad\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
                actor.csrfToken,
                null),
            actor.raw(
                "POST",
                path,
                "{\"name\":\"Bad\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
                actor.csrfToken,
                "not-a-uuid",
                "application/json"),
            actor.get(path + "?limit=1&limit=2"),
            actor.get(path + "?limit=01"),
            actor.get(path + "?offset=10001"),
            actor.get(path + "?status=PRIVATE"),
            actor.get(path + "/not-a-uuid"));
    for (Resp response : rejected) {
      assertThat(response.status).isEqualTo(400);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(response.json().path("correlationId").asText()).isNotBlank();
      assertThat(response.cacheControl()).contains("no-store");
      assertThat(response.body).doesNotContain("SQL", "at com.housesync");
    }
    Resp wrongScalarPatch =
        actor.patchAccount(
            householdId,
            UUID.randomUUID().toString(),
            "{\"expectedVersion\":\"0\",\"name\":\"X\"}");
    assertThat(wrongScalarPatch.status).isEqualTo(400);
    assertThat(wrongScalarPatch.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    // Body-level and query-level rejections are top level: fieldErrors names no synthetic keys.
    Resp noChange =
        actor.patchAccount(householdId, UUID.randomUUID().toString(), "{\"expectedVersion\":0}");
    Resp unknownParam = actor.get(path + "?unexpected=x");
    Resp duplicateParam = actor.get(path + "?offset=1&offset=2");
    Resp unsupportedMedia =
        actor.raw(
            "POST",
            path,
            "{\"name\":\"Bad\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
            actor.csrfToken,
            UUID.randomUUID().toString(),
            "text/plain");
    for (Resp response : List.of(noChange, unknownParam, duplicateParam, unsupportedMedia)) {
      int expectedStatus = response == unsupportedMedia ? 415 : 400;
      assertThat(response.status).isEqualTo(expectedStatus);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(response.json().has("fieldErrors")).isFalse();
      assertThat(response.body).doesNotContain("unexpected", "text/plain");
    }

    // Patch field validation keeps real field keys only.
    Resp missingVersion =
        actor.patchAccount(householdId, UUID.randomUUID().toString(), "{\"name\":\"X\"}");
    assertThat(missingVersion.status).isEqualTo(400);
    assertThat(missingVersion.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(missingVersion.json().path("fieldErrors").propertyNames())
        .containsExactly("expectedVersion");

    Resp nullName =
        actor.patchAccount(
            householdId, UUID.randomUUID().toString(), "{\"expectedVersion\":0,\"name\":null}");
    Resp nullStatus =
        actor.patchAccount(
            householdId, UUID.randomUUID().toString(), "{\"expectedVersion\":0,\"status\":null}");
    Resp nullVersion =
        actor.patchAccount(
            householdId, UUID.randomUUID().toString(), "{\"expectedVersion\":null,\"name\":\"X\"}");
    for (Resp response : List.of(nullName, nullStatus, nullVersion)) {
      assertThat(response.status).isEqualTo(400);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(response.json().path("correlationId").asText()).isNotBlank();
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();
  }

  @Test
  void removalSerializesWithCreateAndRetainedOwnershipReturnsAfterRejoin() throws Exception {
    Agent owner = signedInAgent("owner-race");
    String householdId = createHousehold(owner, "Lifecycle home");
    Agent member = signedInAgent("member-race");
    String memberId = member.userId();
    addMember(householdId, memberId, "MEMBER");
    UUID key = UUID.randomUUID();

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    Resp create;
    Resp remove;
    try {
      Future<Resp> creating =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return member.createAccount(householdId, key, "Race account", "CHECKING", "USD");
              });
      Future<Resp> removing =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "DELETE",
                    "/api/households/" + householdId + "/members/" + memberId,
                    null,
                    owner.csrfToken,
                    null);
              });
      start.countDown();
      create = creating.get(30, TimeUnit.SECONDS);
      remove = removing.get(30, TimeUnit.SECONDS);
    } finally {
      pool.shutdownNow();
    }

    assertThat(remove.status).isEqualTo(204);
    assertThat(create.status).isIn(201, 404);
    String createdId = create.status == 201 ? create.json().path("id").asText() : null;
    int retained =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid"
                + " AND owner_user_id = ?::uuid",
            Integer.class,
            householdId,
            memberId);
    assertThat(retained).isEqualTo(create.status == 201 ? 1 : 0);
    Resp revoked = member.get(accountPath(householdId) + "?status=ALL");
    assertThat(revoked.status).isEqualTo(404);
    assertThat(revoked.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    // Removal revokes detail reads and replays alike; neither re-creates nor replays.
    String revokedDetailId = retained == 1 ? createdId : UUID.randomUUID().toString();
    Resp revokedDetail = member.get(accountPath(householdId) + "/" + revokedDetailId);
    assertThat(revokedDetail.status).isEqualTo(404);
    assertThat(revokedDetail.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp revokedReplay = member.createAccount(householdId, key, "Race account", "CHECKING", "USD");
    assertThat(revokedReplay.status).isEqualTo(404);
    assertThat(revokedReplay.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    addMember(householdId, memberId, "MEMBER");
    JsonNode restored = member.get(accountPath(householdId) + "?status=ALL").json();
    assertThat(restored.path("items").size()).isEqualTo(retained);
    if (retained == 1) {
      assertThat(restored.path("items").get(0).path("name").asText()).isEqualTo("Race account");
    }
    assertThat(owner.get(accountPath(householdId) + "?status=ALL").json().path("items").size())
        .isZero();

    // Rejoined ownership restores the durable key: committed keys replay to the current
    // representation; rolled-back creates may create afresh under the same key.
    Resp rejoinedReplay = member.createAccount(householdId, key, "Race account", "CHECKING", "USD");
    if (retained == 1) {
      assertThat(rejoinedReplay.status).isEqualTo(200);
      assertThat(rejoinedReplay.json().path("id").asText()).isEqualTo(createdId);
      assertThat(rejoinedReplay.json().path("name").asText()).isEqualTo("Race account");
      assertThat(rejoinedReplay.json().path("status").asText()).isEqualTo("ACTIVE");
    } else {
      assertThat(rejoinedReplay.status).isEqualTo(201);
      assertAccount(
          rejoinedReplay.json(), householdId, memberId, "Race account", "CHECKING", "USD");
    }
  }

  @Test
  void anonymousAndMissingCsrfRequestsUseExistingSecurityContract() throws Exception {
    Agent anonymous = new Agent();
    String householdId = UUID.randomUUID().toString();
    Resp get = anonymous.get(accountPath(householdId));
    assertThat(get.status).isEqualTo(401);
    assertThat(get.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");

    Agent actor = signedInAgent("csrf-finance");
    householdId = createHousehold(actor, "CSRF home");
    Resp rejected =
        actor.request(
            "POST",
            accountPath(householdId),
            "{\"name\":\"Cash\",\"kind\":\"CASH\",\"currency\":\"BRL\"}",
            null,
            UUID.randomUUID());
    assertThat(rejected.status).isEqualTo(403);
    assertThat(rejected.json().path("code").asText()).isEqualTo("CSRF_INVALID");
  }

  @Test
  void heldHouseholdLockTimesOutCreateWith503AndNoPartialState() throws Exception {
    Agent actor = signedInAgent("busy");
    String householdId = createHousehold(actor, "Busy home");
    UUID key = UUID.randomUUID();

    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (PreparedStatement lock =
          connection.prepareStatement("SELECT id FROM households WHERE id = ?::uuid FOR UPDATE")) {
        lock.setString(1, householdId);
        try (ResultSet rows = lock.executeQuery()) {
          assertThat(rows.next()).isTrue();
        }
        Resp busy = actor.createAccount(householdId, key, "Blocked account", "CHECKING", "USD");
        assertThat(busy.status).isEqualTo(503);
        assertThat(busy.json().path("code").asText()).isEqualTo("FINANCE_BUSY");
        assertThat(busy.cacheControl()).contains("no-store");
        assertThat(busy.body).doesNotContain("Blocked account");
      } finally {
        connection.rollback();
      }
    }

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_account_idempotency_keys"
                    + " WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();

    // The rolled-back attempt left no reservation; a valid attempt reuses the key.
    Resp retry = actor.createAccount(householdId, key, "Blocked account", "CHECKING", "USD");
    assertThat(retry.status).isEqualTo(201);
    assertAccount(retry.json(), householdId, actor.userId(), "Blocked account", "CHECKING", "USD");
  }

  @Test
  void maxVersionChangeIsExhaustedWhileNoOpStaysAllowed() throws Exception {
    Agent actor = signedInAgent("exhausted");
    String householdId = createHousehold(actor, "Exhaustion home");
    String accountId =
        actor
            .createAccount(householdId, UUID.randomUUID(), "Ledger", "SAVINGS", "EUR")
            .json()
            .path("id")
            .asText();
    jdbc.update("UPDATE financial_accounts SET version = 2147483647 WHERE id = ?::uuid", accountId);

    Resp exhausted =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":2147483647,\"name\":\"Changed\"}");
    assertThat(exhausted.status).isEqualTo(409);
    assertThat(exhausted.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");

    Resp noOp =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":2147483647,\"name\":\"Ledger\"}");
    assertThat(noOp.status).isEqualTo(200);
    assertThat(noOp.json().path("version").asInt()).isEqualTo(2147483647);
  }

  @Test
  void duplicateLabelsCreateSeparateAccountsUnderSeparateKeys() throws Exception {
    Agent actor = signedInAgent("duplicates");
    String householdId = createHousehold(actor, "Duplicate home");

    Resp first = actor.createAccount(householdId, UUID.randomUUID(), "Same label", "CASH", "BRL");
    Resp second = actor.createAccount(householdId, UUID.randomUUID(), "Same label", "CASH", "BRL");

    assertThat(first.status).isEqualTo(201);
    assertThat(second.status).isEqualTo(201);
    assertThat(second.json().path("id").asText()).isNotEqualTo(first.json().path("id").asText());
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(2);
  }

  private Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String email =
        tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    assertThat(agent.post("/api/auth/register", identityJson(email), agent.csrfToken()).status)
        .isEqualTo(201);
    assertThat(agent.post("/api/auth/login", identityJson(email), agent.csrfToken()).status)
        .isEqualTo(200);
    agent.csrfToken();
    return agent;
  }

  private String createHousehold(Agent agent, String name) throws Exception {
    return agent
        .post("/api/households", "{\"name\":\"" + name + "\"}", agent.csrfToken)
        .json()
        .path("id")
        .asText();
  }

  private void addMember(String householdId, String userId, String role) {
    assertThat(
            jdbc.update(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?::uuid, ?::uuid, ?)",
                householdId,
                userId,
                role))
        .isEqualTo(1);
  }

  private static String identityJson(String email) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
  }

  private static String accountPath(String householdId) {
    return "/api/households/" + householdId + "/financial-accounts";
  }

  private static void assertAccount(
      JsonNode account,
      String householdId,
      String ownerId,
      String name,
      String kind,
      String currency) {
    UUID.fromString(account.path("id").asText());
    assertThat(account.path("householdId").asText()).isEqualTo(householdId);
    assertThat(account.path("ownerUserId").asText()).isEqualTo(ownerId);
    assertThat(account.path("name").asText()).isEqualTo(name);
    assertThat(account.path("kind").asText()).isEqualTo(kind);
    assertThat(account.path("currency").asText()).isEqualTo(currency);
    assertThat(account.path("source").asText()).isEqualTo("MANUAL");
    assertThat(account.path("visibility").asText()).isEqualTo("PRIVATE");
    assertThat(account.path("status").asText()).isEqualTo("ACTIVE");
    assertThat(account.path("version").asInt()).isZero();
  }

  record Resp(int status, String body, java.net.http.HttpHeaders headers) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }

    String cacheControl() {
      return headers.firstValue("Cache-Control").orElse("");
    }
  }

  class Agent {
    String sessionCookie;
    String csrfToken;
    String cachedUserId;

    String csrfToken() throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/csrf"))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      addSession(builder);
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      assertThat(response.statusCode()).isEqualTo(200);
      csrfToken = mapper.readTree(response.body()).path("token").asText();
      return csrfToken;
    }

    String userId() throws Exception {
      if (cachedUserId == null) cachedUserId = get("/api/auth/me").json().path("id").asText();
      return cachedUserId;
    }

    Resp get(String path) throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      addSession(builder);
      return send(builder.build());
    }

    Resp post(String path, String json, String csrf) throws Exception {
      return request("POST", path, json, csrf, null);
    }

    Resp createAccount(String householdId, UUID key, String name, String kind, String currency)
        throws Exception {
      return request(
          "POST",
          accountPath(householdId),
          "{\"name\":\"" + name + "\",\"kind\":\"" + kind + "\",\"currency\":\"" + currency + "\"}",
          csrfToken,
          key);
    }

    Resp patchAccount(String householdId, String accountId, String json) throws Exception {
      return request("PATCH", accountPath(householdId) + "/" + accountId, json, csrfToken, null);
    }

    Resp request(String method, String path, String json, String csrf, UUID idempotencyKey)
        throws Exception {
      return raw(
          method,
          path,
          json,
          csrf,
          idempotencyKey == null ? null : idempotencyKey.toString(),
          json == null ? null : "application/json");
    }

    /** Raw variant for malformed headers and unsupported media types the typed form cannot send. */
    Resp raw(
        String method,
        String path,
        String json,
        String csrf,
        String idempotencyKey,
        String contentType)
        throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(15))
              .header("Accept", "application/json")
              .method(
                  method,
                  json == null
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofString(json));
      if (contentType != null) builder.header("Content-Type", contentType);
      if (csrf != null) builder.header("X-CSRF-TOKEN", csrf);
      if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
      addSession(builder);
      return send(builder.build());
    }

    private Resp send(HttpRequest request) throws Exception {
      HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      return new Resp(response.statusCode(), response.body(), response.headers());
    }

    private void addSession(HttpRequest.Builder builder) {
      if (sessionCookie != null) builder.header("Cookie", "SESSION=" + sessionCookie);
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
  }
}
