package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
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

/**
 * Allocation contract on real PostgreSQL (ADR 0007): owner-only creation of one active
 * allocation per posted household expense, durable create idempotency with 201/200 replay and
 * since-revoked representations, the expense version as the only concurrency token, safe privacy
 * precedence on reads, ALLOCATION_CONFLICT blocking of money correction and privacy revocation, and
 * atomic void deactivation.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class FinancialAllocationHttpIT {

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
  void createValidatesStrictShapeParticipantsAndEligibilityBeforeStateChanges() throws Exception {
    Agent owner = signedInAgent("alloc-owner");
    String householdId = createHousehold(owner, "Validation home");
    Agent member = signedInAgent("alloc-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-10.00", "USD", "Shared buy", "2026-09-16", "HOUSEHOLD")));
    String path = allocationPath(householdId, expenseId);
    String roster = participantArray(owner.userId(), member.userId());

    // The Idempotency-Key header itself is mandatory even with a valid session and CSRF.
    Resp missingKey = owner.request("POST", path, createBody("0", roster), owner.csrfToken, null);
    assertThat(missingKey.status).isEqualTo(400);
    assertThat(missingKey.json().path("fieldErrors").propertyNames())
        .containsExactly("idempotencyKey");
    Resp malformedKey =
        owner.requestRawKey("POST", path, createBody("0", roster), owner.csrfToken, "not-a-uuid");
    assertThat(malformedKey.status).isEqualTo(400);
    assertThat(malformedKey.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    Resp unknownField =
        owner.request(
            "POST",
            path,
            "{\"expectedVersion\":0,\"participantUserIds\":[" + roster + "],\"extra\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(unknownField.status).isEqualTo(400);
    assertThat(unknownField.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    Resp missingVersion =
        owner.request(
            "POST",
            path,
            "{\"participantUserIds\":[" + roster + "]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(missingVersion.status).isEqualTo(400);
    assertThat(missingVersion.json().path("fieldErrors").propertyNames())
        .containsExactly("expectedVersion");

    Resp emptyParticipants =
        owner.request(
            "POST",
            path,
            "{\"expectedVersion\":0,\"participantUserIds\":[]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(emptyParticipants.status).isEqualTo(400);
    assertThat(emptyParticipants.json().path("fieldErrors").propertyNames())
        .containsExactly("participantUserIds");

    Resp duplicateParticipants =
        owner.request(
            "POST",
            path,
            createBody("0", participantArray(owner.userId(), owner.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(duplicateParticipants.status).isEqualTo(400);
    assertThat(duplicateParticipants.json().path("fieldErrors").propertyNames())
        .as(duplicateParticipants.body)
        .containsExactly("participantUserIds");

    Resp malformedParticipant =
        owner.request(
            "POST",
            path,
            "{\"expectedVersion\":0,\"participantUserIds\":[\"oops\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(malformedParticipant.status).isEqualTo(400);
    assertThat(malformedParticipant.json().path("fieldErrors").propertyNames())
        .containsExactly("participantUserIds");

    Resp nonMemberParticipant =
        owner.request(
            "POST",
            path,
            createBody("0", participantArray(owner.userId(), UUID.randomUUID().toString())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(nonMemberParticipant.status).isEqualTo(400);
    assertThat(nonMemberParticipant.json().path("fieldErrors").propertyNames())
        .containsExactly("participantUserIds");

    Resp queryParam =
        owner.request(
            "POST",
            path + "?filter=x",
            createBody("0", roster),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(queryParam.status).isEqualTo(400);

    Resp memberCreate =
        member.request("POST", path, createBody("0", roster), member.csrfToken, UUID.randomUUID());
    assertThat(memberCreate.status).isEqualTo(403);
    assertThat(memberCreate.json().path("code").asText()).isEqualTo("FORBIDDEN");
    assertThat(memberCreate.body).doesNotContain(expenseId, account);

    String privateId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(account, "EXPENSE", "-4.00", "USD", "Hidden buy", "2026-09-16", null)));
    Resp memberOnPrivate =
        member.request(
            "POST",
            allocationPath(householdId, privateId),
            createBody("0", roster),
            member.csrfToken,
            UUID.randomUUID());
    assertThat(memberOnPrivate.status).isEqualTo(404);
    assertThat(memberOnPrivate.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
    assertThat(memberOnPrivate.body).doesNotContain("Hidden buy", privateId);

    Resp missingCreate =
        owner.request(
            "POST",
            allocationPath(householdId, UUID.randomUUID().toString()),
            createBody("0", roster),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(missingCreate.status).isEqualTo(404);
    assertThat(missingCreate.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");

    String incomeId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "INCOME", "3.00", "USD", "Shared income", "2026-09-16", "HOUSEHOLD")));
    Resp incomeCreate =
        owner.request(
            "POST",
            allocationPath(householdId, incomeId),
            createBody("0", roster),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(incomeCreate.status).isEqualTo(409);
    assertThat(incomeCreate.json().path("code").asText()).isEqualTo("ALLOCATION_CONFLICT");

    String refundId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(account, expenseId, "1.00", "USD", "Eligibility back")));
    Resp refundCreate =
        owner.request(
            "POST",
            allocationPath(householdId, refundId),
            createBody("0", roster),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(refundCreate.status).isEqualTo(409);
    assertThat(refundCreate.json().path("code").asText()).isEqualTo("ALLOCATION_CONFLICT");

    // The state-changing refund create already bumped the expense version once.
    Resp staleCreate =
        owner.request("POST", path, createBody("2", roster), owner.csrfToken, UUID.randomUUID());
    assertThat(staleCreate.status).isEqualTo(409);
    assertThat(staleCreate.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    // No failed attempt left partial state behind.
    assertThat(version(expenseId)).isEqualTo(1);
    assertThat(allocationCount(expenseId)).isZero();
    assertThat(allocationKeyCount(owner.userId(), householdId)).isZero();
  }

  @Test
  void tinyAllocationsCreateExactOrderedZeroSharesWithPersistenceAndReplay() throws Exception {
    Agent owner = signedInAgent("tiny-owner");
    String householdId = createHousehold(owner, "Tiny home");
    Agent second = signedInAgent("tiny-second");
    Agent third = signedInAgent("tiny-third");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        second.userId());
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        third.userId());
    String usdAccount = createAccount(owner, householdId, "Owner usd", "CASH", "USD");
    String jpyAccount = createAccount(owner, householdId, "Owner jpy", "CASH", "JPY");
    String usdExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    usdAccount,
                    "EXPENSE",
                    "-0.01",
                    "USD",
                    "One cent split",
                    "2026-09-16",
                    "HOUSEHOLD")));
    String jpyExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    jpyAccount,
                    "EXPENSE",
                    "-1",
                    "JPY",
                    "One yen split",
                    "2026-09-16",
                    "HOUSEHOLD")));
    List<String> roster = sorted(List.of(owner.userId(), second.userId(), third.userId()));
    String rosterArray = participantArray(roster.toArray(new String[0]));

    // USD 0.01 across three participants: only the canonical-first participant receives the
    // single minor unit and the remaining ordered shares are exact zeros that persist.
    UUID usdKey = UUID.randomUUID();
    Resp usdCreated =
        owner.request(
            "POST",
            allocationPath(householdId, usdExpenseId),
            createBody("0", rosterArray),
            owner.csrfToken,
            usdKey);
    assertThat(usdCreated.status).as(usdCreated.body).isEqualTo(201);
    JsonNode usdAllocation = usdCreated.json();
    assertThat(usdAllocation.path("originalAmount").path("amount").asText()).isEqualTo("0.01");
    String[] usdShares = {"0.01", "0.00", "0.00"};
    for (int index = 0; index < 3; index++) {
      JsonNode participant = usdAllocation.path("participants").get(index);
      assertThat(participant.path("userId").asText()).isEqualTo(roster.get(index));
      assertThat(participant.path("share").path("amount").asText()).isEqualTo(usdShares[index]);
      assertThat(participant.path("share").path("currency").asText()).isEqualTo("USD");
    }
    assertThat(participantCount(usdAllocation.path("id").asText())).isEqualTo(3);
    assertThat(version(usdExpenseId)).isEqualTo(1);

    Resp usdReplay =
        owner.request(
            "POST",
            allocationPath(householdId, usdExpenseId),
            createBody("0", rosterArray),
            owner.csrfToken,
            usdKey);
    assertThat(usdReplay.status).isEqualTo(200);
    assertThat(usdReplay.json().path("id").asText()).isEqualTo(usdAllocation.path("id").asText());
    assertThat(usdReplay.json().path("participants").get(1).path("share").path("amount").asText())
        .isEqualTo("0.00");

    // JPY 1 across three participants divides in whole units: 1/0/0.
    Resp jpyCreated =
        owner.request(
            "POST",
            allocationPath(householdId, jpyExpenseId),
            createBody("0", rosterArray),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(jpyCreated.status).as(jpyCreated.body).isEqualTo(201);
    assertThat(jpyCreated.json().path("originalAmount").path("amount").asText()).isEqualTo("1");
    String[] jpyShares = {"1", "0", "0"};
    for (int index = 0; index < 3; index++) {
      JsonNode participant = jpyCreated.json().path("participants").get(index);
      assertThat(participant.path("userId").asText()).isEqualTo(roster.get(index));
      assertThat(participant.path("share").path("amount").asText()).isEqualTo(jpyShares[index]);
    }
    assertThat(participantCount(jpyCreated.json().path("id").asText())).isEqualTo(3);

    // A tiny allocation revokes like any other, keeping its frozen zero-share history.
    Resp revoked =
        owner.request(
            "PATCH",
            allocationPath(householdId, usdExpenseId),
            "{\"expectedVersion\":1,\"status\":\"REVOKED\"}",
            owner.csrfToken,
            null);
    assertThat(revoked.status).isEqualTo(200);
    assertThat(revoked.json().path("status").asText()).isEqualTo("REVOKED");
    assertThat(version(usdExpenseId)).isEqualTo(2);
    assertThat(participantCount(usdAllocation.path("id").asText())).isEqualTo(3);
  }

  @Test
  void legacyEqualUuidSpellingsReplayNormalizedIntentAfterRevocation() throws Exception {
    Agent owner = signedInAgent("legacy-uuid-owner");
    String householdId = createHousehold(owner, "Legacy UUID home");
    Agent member = signedInAgent("legacy-uuid-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account,
                    "EXPENSE",
                    "-10.00",
                    "USD",
                    "Legacy split",
                    "2026-09-16",
                    "HOUSEHOLD")));
    String path = allocationPath(householdId, expenseId);
    UUID key = UUID.randomUUID();
    String legacyBody =
        createBody("0", participantArray(member.userId().toUpperCase(Locale.ROOT), owner.userId()));
    Resp created = owner.request("POST", path, legacyBody, owner.csrfToken, key);
    assertThat(created.status).as(created.body).isEqualTo(201);
    String allocationId = created.json().path("id").asText();
    assertThat(created.json().path("method").asText()).isEqualTo("EQUAL");
    assertThat(allocationCount(expenseId)).isEqualTo(1);
    assertThat(allocationKeyCount(owner.userId(), householdId)).isEqualTo(1);

    Resp normalizedReplay =
        owner.request(
            "POST",
            path,
            createBody("0", participantArray(owner.userId(), member.userId())),
            owner.csrfToken,
            key);
    assertThat(normalizedReplay.status).as(normalizedReplay.body).isEqualTo(200);
    assertThat(normalizedReplay.json().path("id").asText()).isEqualTo(allocationId);

    Resp duplicateAfterNormalization =
        owner.request(
            "POST",
            path,
            createBody(
                "0", participantArray(member.userId(), member.userId().toUpperCase(Locale.ROOT))),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(duplicateAfterNormalization.status).isEqualTo(400);
    assertThat(duplicateAfterNormalization.json().path("fieldErrors").propertyNames())
        .containsExactly("participantUserIds");

    Resp revoked =
        owner.request(
            "PATCH", path, "{\"expectedVersion\":1,\"status\":\"REVOKED\"}", owner.csrfToken, null);
    assertThat(revoked.status).as(revoked.body).isEqualTo(200);
    Resp replayAfterRevoke = owner.request("POST", path, legacyBody, owner.csrfToken, key);
    assertThat(replayAfterRevoke.status).as(replayAfterRevoke.body).isEqualTo(200);
    assertThat(replayAfterRevoke.json().path("id").asText()).isEqualTo(allocationId);
    assertThat(replayAfterRevoke.json().path("status").asText()).isEqualTo("REVOKED");
    assertThat(replayAfterRevoke.json().path("transactionVersion").asInt()).isEqualTo(2);
    assertThat(allocationCount(expenseId)).isEqualTo(1);
    assertThat(allocationKeyCount(owner.userId(), householdId)).isEqualTo(1);

    Resp changedIntent =
        owner.request(
            "POST",
            path,
            createBody("1", participantArray(owner.userId(), member.userId())),
            owner.csrfToken,
            key);
    assertThat(changedIntent.status).isEqualTo(409);
    assertThat(changedIntent.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
  }

  @Test
  void versionExhaustedCreateFailsSafelyBeforeAnyKeyReservation() throws Exception {
    Agent owner = signedInAgent("exhaust-owner");
    String householdId = createHousehold(owner, "Exhaust home");
    Agent member = signedInAgent("exhaust-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-1.00", "USD", "Exhausted", "2026-09-16", "HOUSEHOLD")));
    String path = allocationPath(householdId, expenseId);
    String roster = participantArray(owner.userId(), member.userId());
    UUID exhaustedKey = UUID.randomUUID();

    jdbc.update(
        "UPDATE financial_transactions SET version = 2147483647 WHERE id = ?::uuid", expenseId);
    Resp exhausted =
        owner.request(
            "POST", path, createBody("2147483647", roster), owner.csrfToken, exhaustedKey);
    assertThat(exhausted.status).isEqualTo(409);
    assertThat(exhausted.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    // No allocation row, participant row, or durable idempotency key was reserved.
    assertThat(allocationCount(expenseId)).isZero();
    assertThat(version(expenseId)).isEqualTo(2147483647);
    assertThat(allocationKeyCount(owner.userId(), householdId)).isZero();

    // After restoring a valid version, the untouched same key succeeds on retry.
    jdbc.update("UPDATE financial_transactions SET version = 1 WHERE id = ?::uuid", expenseId);
    Resp retried =
        owner.request("POST", path, createBody("1", roster), owner.csrfToken, exhaustedKey);
    assertThat(retried.status).as(retried.body).isEqualTo(201);
    assertThat(retried.json().path("transactionVersion").asInt()).isEqualTo(2);
    assertThat(version(expenseId)).isEqualTo(2);
    assertThat(allocationKeyCount(owner.userId(), householdId)).isEqualTo(1);
  }

  @Test
  void createReplayRevokeAndRecreateFollowDurableIdempotencyAndVersionToken() throws Exception {
    Agent owner = signedInAgent("idem-owner");
    String householdId = createHousehold(owner, "Idempotency home");
    Agent second = signedInAgent("idem-second");
    Agent third = signedInAgent("idem-third");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        second.userId());
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        third.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-10.00", "USD", "Split buy", "2026-09-16", "HOUSEHOLD")));
    String path = allocationPath(householdId, expenseId);
    List<String> roster = sorted(List.of(owner.userId(), second.userId(), third.userId()));
    String fullRoster = participantArray(roster.toArray(new String[0]));
    UUID createKey = UUID.randomUUID();
    String body = createBody("0", fullRoster);

    Resp createdResponse = owner.request("POST", path, body, owner.csrfToken, createKey);
    assertThat(createdResponse.status).isEqualTo(201);
    JsonNode allocation = createdResponse.json();
    List<String> fieldOrder = new ArrayList<>();
    allocation.propertyNames().forEach(fieldOrder::add);
    assertThat(fieldOrder)
        .containsExactly(
            "id",
            "transactionId",
            "householdId",
            "payerUserId",
            "currency",
            "originalAmount",
            "participants",
            "status",
            "createdAt",
            "revokedAt",
            "transactionVersion",
            "method",
            "refundPolicy",
            "impact");
    assertThat(allocation.path("method").asText()).isEqualTo("EQUAL");
    assertThat(allocation.path("refundPolicy").asText()).isEqualTo("EQUAL_V1");
    assertThat(allocation.path("transactionId").asText()).isEqualTo(expenseId);
    assertThat(allocation.path("householdId").asText()).isEqualTo(householdId);
    assertThat(allocation.path("payerUserId").asText()).isEqualTo(owner.userId());
    assertThat(allocation.path("currency").asText()).isEqualTo("USD");
    assertThat(allocation.path("originalAmount").path("amount").asText()).isEqualTo("10.00");
    assertThat(allocation.path("originalAmount").path("currency").asText()).isEqualTo("USD");
    assertThat(allocation.path("participants").size()).isEqualTo(3);
    String[] expectedShares = {"3.34", "3.33", "3.33"};
    for (int index = 0; index < 3; index++) {
      JsonNode participant = allocation.path("participants").get(index);
      assertThat(participant.path("userId").asText()).isEqualTo(roster.get(index));
      assertThat(participant.path("share").path("amount").asText())
          .isEqualTo(expectedShares[index]);
      assertThat(participant.path("share").path("currency").asText()).isEqualTo("USD");
    }
    assertThat(allocation.path("status").asText()).isEqualTo("ACTIVE");
    assertThat(allocation.path("revokedAt").isNull()).isTrue();
    assertThat(allocation.path("transactionVersion").asInt()).isEqualTo(1);
    assertThat(version(expenseId)).isEqualTo(1);
    assertThat(createdResponse.cacheControl()).contains("no-store");
    String allocationRow = allocation.path("id").asText();
    assertThat(participantCount(allocationRow)).isEqualTo(3);

    Resp replay = owner.request("POST", path, body, owner.csrfToken, createKey);
    assertThat(replay.status).isEqualTo(200);
    assertThat(replay.json().path("id").asText()).isEqualTo(allocationRow);
    assertThat(replay.json().path("status").asText()).isEqualTo("ACTIVE");
    assertThat(replay.json().path("transactionVersion").asInt()).isEqualTo(1);
    assertThat(replay.cacheControl()).contains("no-store");

    Resp replayChangedSet =
        owner.request(
            "POST",
            path,
            createBody("0", participantArray(owner.userId(), second.userId())),
            owner.csrfToken,
            createKey);
    assertThat(replayChangedSet.status).isEqualTo(409);
    assertThat(replayChangedSet.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");

    Resp replayChangedVersion =
        owner.request("POST", path, createBody("1", fullRoster), owner.csrfToken, createKey);
    assertThat(replayChangedVersion.status).isEqualTo(409);
    assertThat(replayChangedVersion.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");

    Resp secondCreate =
        owner.request(
            "POST", path, createBody("1", fullRoster), owner.csrfToken, UUID.randomUUID());
    assertThat(secondCreate.status).isEqualTo(409);
    assertThat(secondCreate.json().path("code").asText()).isEqualTo("ALLOCATION_CONFLICT");
    assertThat(version(expenseId)).isEqualTo(1);

    // The same scoped key on a different transaction is a different fingerprint and conflicts
    // without reserving the key or touching the other expense.
    String otherExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-3.00", "USD", "Other buy", "2026-09-16", "HOUSEHOLD")));
    Resp otherTransaction =
        owner.request(
            "POST", allocationPath(householdId, otherExpenseId), body, owner.csrfToken, createKey);
    assertThat(otherTransaction.status).isEqualTo(409);
    assertThat(otherTransaction.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    assertThat(version(otherExpenseId)).isZero();
    assertThat(allocationCount(otherExpenseId)).isZero();
    assertThat(allocationKeyCount(owner.userId(), householdId)).isEqualTo(1);

    Resp memberRevoke =
        second.request(
            "PATCH",
            path,
            "{\"expectedVersion\":1,\"status\":\"REVOKED\"}",
            second.csrfToken,
            null);
    assertThat(memberRevoke.status).isEqualTo(403);
    assertThat(memberRevoke.json().path("code").asText()).isEqualTo("FORBIDDEN");

    Resp wrongStatus =
        owner.request(
            "PATCH", path, "{\"expectedVersion\":1,\"status\":\"ACTIVE\"}", owner.csrfToken, null);
    assertThat(wrongStatus.status).isEqualTo(400);
    assertThat(wrongStatus.json().path("fieldErrors").propertyNames()).containsExactly("status");

    Resp missingStatus =
        owner.request("PATCH", path, "{\"expectedVersion\":1}", owner.csrfToken, null);
    assertThat(missingStatus.status).isEqualTo(400);
    assertThat(missingStatus.json().path("fieldErrors").propertyNames()).containsExactly("status");

    Resp staleRevoke =
        owner.request(
            "PATCH", path, "{\"expectedVersion\":0,\"status\":\"REVOKED\"}", owner.csrfToken, null);
    assertThat(staleRevoke.status).isEqualTo(409);
    assertThat(staleRevoke.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    Resp revoked =
        owner.request(
            "PATCH", path, "{\"expectedVersion\":1,\"status\":\"REVOKED\"}", owner.csrfToken, null);
    assertThat(revoked.status).isEqualTo(200);
    assertThat(revoked.json().path("status").asText()).isEqualTo("REVOKED");
    assertThat(revoked.json().path("revokedAt").isNull()).isFalse();
    assertThat(revoked.json().path("transactionVersion").asInt()).isEqualTo(2);
    assertThat(version(expenseId)).isEqualTo(2);
    assertThat(revoked.cacheControl()).contains("no-store");

    Resp revokedRead = owner.get(path);
    assertThat(revokedRead.status).isEqualTo(404);
    assertThat(revokedRead.json().path("code").asText()).isEqualTo("ALLOCATION_NOT_FOUND");
    Resp revokeAgain =
        owner.request(
            "PATCH", path, "{\"expectedVersion\":2,\"status\":\"REVOKED\"}", owner.csrfToken, null);
    assertThat(revokeAgain.status).isEqualTo(404);
    assertThat(revokeAgain.json().path("code").asText()).isEqualTo("ALLOCATION_NOT_FOUND");

    // The durable key still answers with the current, now-revoked representation.
    Resp replayAfterRevoke = owner.request("POST", path, body, owner.csrfToken, createKey);
    assertThat(replayAfterRevoke.status).isEqualTo(200);
    assertThat(replayAfterRevoke.json().path("id").asText()).isEqualTo(allocationRow);
    assertThat(replayAfterRevoke.json().path("status").asText()).isEqualTo("REVOKED");
    assertThat(replayAfterRevoke.json().path("revokedAt").isNull()).isFalse();
    assertThat(replayAfterRevoke.json().path("transactionVersion").asInt()).isEqualTo(2);

    // Recreation needs a fresh key and moves the expense version once more.
    Resp recreated =
        owner.request(
            "POST",
            path,
            createBody("2", participantArray(owner.userId(), second.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(recreated.status).isEqualTo(201);
    assertThat(recreated.json().path("status").asText()).isEqualTo("ACTIVE");
    assertThat(recreated.json().path("participants").size()).isEqualTo(2);
    assertThat(recreated.json().path("transactionVersion").asInt()).isEqualTo(3);
    assertThat(version(expenseId)).isEqualTo(3);

    // History is retained server-side with no read route for revoked allocations.
    assertThat(allocationStatus(allocationRow)).isEqualTo("REVOKED");
    assertThat(participantCount(allocationRow)).isEqualTo(3);
    assertThat(allocationKeyCount(owner.userId(), householdId)).isEqualTo(2);
  }

  @Test
  void allocationReadsFollowSafePrivacyPrecedence() throws Exception {
    Agent owner = signedInAgent("read-owner");
    String householdId = createHousehold(owner, "Read home");
    Agent member = signedInAgent("read-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String allocatedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-10.00", "USD", "Allocated", "2026-09-16", "HOUSEHOLD")));
    String unallocatedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-6.00", "USD", "Unallocated", "2026-09-16", "HOUSEHOLD")));
    String privateId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(account, "EXPENSE", "-2.00", "USD", "Hidden", "2026-09-16", null)));
    Resp createdResponse =
        owner.request(
            "POST",
            allocationPath(householdId, allocatedId),
            createBody("0", participantArray(owner.userId(), member.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(createdResponse.status).isEqualTo(201);

    Resp memberRead = member.get(allocationPath(householdId, allocatedId));
    assertThat(memberRead.status).isEqualTo(200);
    assertThat(memberRead.json().path("status").asText()).isEqualTo("ACTIVE");
    assertThat(memberRead.json().path("payerUserId").asText()).isEqualTo(owner.userId());
    assertThat(memberRead.json().path("participants").size()).isEqualTo(2);
    // The allocation response carries no account metadata at all.
    assertThat(memberRead.body).doesNotContain(account, "accountId");

    Resp ownerRead = owner.get(allocationPath(householdId, allocatedId));
    assertThat(ownerRead.status).isEqualTo(200);
    assertThat(ownerRead.json().path("id").asText())
        .isEqualTo(memberRead.json().path("id").asText());
    assertThat(ownerRead.cacheControl()).contains("no-store");

    Resp memberUnallocated = member.get(allocationPath(householdId, unallocatedId));
    assertThat(memberUnallocated.status).isEqualTo(404);
    assertThat(memberUnallocated.json().path("code").asText()).isEqualTo("ALLOCATION_NOT_FOUND");
    assertThat(memberUnallocated.cacheControl()).contains("no-store");

    Resp ownerHidden = owner.get(allocationPath(householdId, privateId));
    assertThat(ownerHidden.status).isEqualTo(404);
    assertThat(ownerHidden.json().path("code").asText()).isEqualTo("ALLOCATION_NOT_FOUND");

    Resp memberHidden = member.get(allocationPath(householdId, privateId));
    Resp memberMissing = member.get(allocationPath(householdId, UUID.randomUUID().toString()));
    for (Resp response : List.of(memberHidden, memberMissing)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
      assertThat(response.body).doesNotContain("Hidden", privateId);
    }

    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
        householdId,
        member.userId());
    Resp removedRead = member.get(allocationPath(householdId, allocatedId));
    assertThat(removedRead.status).isEqualTo(404);
    assertThat(removedRead.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(removedRead.body).doesNotContain("Allocated");

    // A removed member cannot mutate allocations either: the lifecycle lock answers the generic
    // household 404 before any allocation state is touched, for create and revoke alike.
    Resp removedCreate =
        member.request(
            "POST",
            allocationPath(householdId, allocatedId),
            createBody("1", participantArray(owner.userId(), member.userId())),
            member.csrfToken,
            UUID.randomUUID());
    assertThat(removedCreate.status).isEqualTo(404);
    assertThat(removedCreate.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp removedRevoke =
        member.request(
            "PATCH",
            allocationPath(householdId, allocatedId),
            "{\"expectedVersion\":1,\"status\":\"REVOKED\"}",
            member.csrfToken,
            null);
    assertThat(removedRevoke.status).isEqualTo(404);
    assertThat(removedRevoke.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    // A removed member can no longer enter a roster either: the owner-side create listing them
    // fails validation and leaves the unallocated expense untouched.
    Resp removedRosterCreate =
        owner.request(
            "POST",
            allocationPath(householdId, unallocatedId),
            createBody("0", participantArray(owner.userId(), member.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(removedRosterCreate.status).isEqualTo(400);
    assertThat(removedRosterCreate.json().path("fieldErrors").propertyNames())
        .containsExactly("participantUserIds");
    assertThat(version(unallocatedId)).isZero();

    Agent outsider = signedInAgent("read-outsider");
    Resp outsiderRead = outsider.get(allocationPath(householdId, allocatedId));
    assertThat(outsiderRead.status).isEqualTo(404);
    assertThat(outsiderRead.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    Resp queryRead = member.get(allocationPath(householdId, allocatedId) + "?x=1");
    assertThat(queryRead.status).isEqualTo(400);
  }

  @Test
  void activeAllocationBlocksMoneyAndPrivacyCorrectionsButAllowsDescriptiveOnes() throws Exception {
    Agent owner = signedInAgent("guard-owner");
    String householdId = createHousehold(owner, "Guard home");
    Agent member = signedInAgent("guard-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-10.00", "USD", "Guarded", "2026-09-16", "HOUSEHOLD")));
    String path = allocationPath(householdId, expenseId);
    Resp createdResponse =
        owner.request(
            "POST",
            path,
            createBody("0", participantArray(owner.userId(), member.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(createdResponse.status).isEqualTo(201);

    Resp moneyBlocked =
        owner.patchTransaction(
            householdId,
            expenseId,
            "{\"expectedVersion\":1,\"money\":{\"amount\":\"-9.00\",\"currency\":\"USD\"}}");
    assertThat(moneyBlocked.status).isEqualTo(409);
    assertThat(moneyBlocked.json().path("code").asText()).isEqualTo("ALLOCATION_CONFLICT");
    assertThat(amount(expenseId)).isEqualByComparingTo(new java.math.BigDecimal("-10.00"));

    Resp privacyBlocked =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"visibility\":\"PRIVATE\"}");
    assertThat(privacyBlocked.status).isEqualTo(409);
    assertThat(privacyBlocked.json().path("code").asText()).isEqualTo("ALLOCATION_CONFLICT");
    assertThat(visibility(expenseId)).isEqualTo("HOUSEHOLD");

    Resp privacyNoOp =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"visibility\":\"HOUSEHOLD\"}");
    assertThat(privacyNoOp.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(1);

    Resp descriptionChange =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"description\":\"Guarded dinner\"}");
    assertThat(descriptionChange.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(2);

    Resp dateChange =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":2,\"occurredOn\":\"2026-09-15\"}");
    assertThat(dateChange.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(3);

    Resp categoryChange =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":3,\"category\":\"DINING\"}");
    assertThat(categoryChange.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(4);

    // Refund create remains allowed while the allocation is active.
    Resp refundAllowed =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, expenseId, "2.00", "USD", "Guarded back"));
    assertThat(refundAllowed.status).isEqualTo(201);
    assertThat(version(expenseId)).isEqualTo(5);

    Resp revoked =
        owner.request(
            "PATCH", path, "{\"expectedVersion\":5,\"status\":\"REVOKED\"}", owner.csrfToken, null);
    assertThat(revoked.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(6);

    Resp moneyAllowed =
        owner.patchTransaction(
            householdId,
            expenseId,
            "{\"expectedVersion\":6,\"money\":{\"amount\":\"-9.00\",\"currency\":\"USD\"}}");
    assertThat(moneyAllowed.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(7);

    Resp privacyAllowed =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":7,\"visibility\":\"PRIVATE\"}");
    assertThat(privacyAllowed.status).isEqualTo(200);
    assertThat(visibility(expenseId)).isEqualTo("PRIVATE");
  }

  @Test
  void expenseVoidDeactivatesAllocationAtomicallyAfterLiveRefundsAreVoided() throws Exception {
    Agent owner = signedInAgent("void-owner");
    String householdId = createHousehold(owner, "Void home");
    Agent member = signedInAgent("void-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account,
                    "EXPENSE",
                    "-10.00",
                    "USD",
                    "Void target",
                    "2026-09-16",
                    "HOUSEHOLD")));
    String path = allocationPath(householdId, expenseId);
    String voidRoster = participantArray(owner.userId(), member.userId());
    UUID voidCreateKey = UUID.randomUUID();
    Resp createdResponse =
        owner.request("POST", path, createBody("0", voidRoster), owner.csrfToken, voidCreateKey);
    assertThat(createdResponse.status).isEqualTo(201);
    String allocationRow = createdResponse.json().path("id").asText();
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, expenseId, "2.00", "USD", "Live refund")));

    Resp blockedVoid =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":2,\"status\":\"VOIDED\"}");
    assertThat(blockedVoid.status).isEqualTo(409);
    assertThat(blockedVoid.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");
    assertThat(status(expenseId)).isEqualTo("POSTED");
    assertThat(allocationStatus(allocationRow)).isEqualTo("ACTIVE");

    Resp refundVoid =
        owner.patchTransaction(
            householdId, refundId(expenseId), "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(refundVoid.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(3);

    Resp voided =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":3,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);
    assertThat(voided.json().path("status").asText()).isEqualTo("VOIDED");
    assertThat(version(expenseId)).isEqualTo(4);
    // The deactivation committed atomically with the void.
    assertThat(allocationStatus(allocationRow)).isEqualTo("REVOKED");
    assertThat(revokedAt(allocationRow)).isNotNull();
    Resp readAfterVoid = owner.get(path);
    assertThat(readAfterVoid.status).isEqualTo(404);
    assertThat(readAfterVoid.json().path("code").asText()).isEqualTo("ALLOCATION_NOT_FOUND");
    assertThat(allocationCount(expenseId)).isEqualTo(1);

    // Voided allocated expenses contribute nothing to derived balances.
    Resp balances = owner.get("/api/households/" + householdId + "/member-balances");
    assertThat(balances.status).isEqualTo(200);
    assertThat(balances.json().path("currencies").size()).isZero();

    // The durable create key still answers the current representation after the expense void.
    Resp replayAfterVoid =
        owner.request("POST", path, createBody("0", voidRoster), owner.csrfToken, voidCreateKey);
    assertThat(replayAfterVoid.status).isEqualTo(200);
    assertThat(replayAfterVoid.json().path("id").asText()).isEqualTo(allocationRow);
    assertThat(replayAfterVoid.json().path("status").asText()).isEqualTo("REVOKED");
    assertThat(replayAfterVoid.json().path("revokedAt").isNull()).isFalse();
    assertThat(replayAfterVoid.json().path("transactionVersion").asInt()).isEqualTo(4);
    assertThat(version(expenseId)).isEqualTo(4);
  }

  @Test
  void allocationOperationsSerializeThroughConcurrencyAndLockTimeouts() throws Exception {
    Agent owner = signedInAgent("race-owner");
    String householdId = createHousehold(owner, "Race home");
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    List<String> roster = List.of(owner.userId());

    // Same-key concurrent creates serialize: exactly one 201 and one 200 replay.
    String sameKeyExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-10.00", "USD", "Same key", "2026-09-16", "HOUSEHOLD")));
    UUID sharedKey = UUID.randomUUID();
    String sameBody = createBody("0", participantArray(roster.toArray(new String[0])));
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      CountDownLatch start = new CountDownLatch(1);
      Future<Resp> first =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "POST",
                    allocationPath(householdId, sameKeyExpenseId),
                    sameBody,
                    owner.csrfToken,
                    sharedKey);
              });
      Future<Resp> second =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "POST",
                    allocationPath(householdId, sameKeyExpenseId),
                    sameBody,
                    owner.csrfToken,
                    sharedKey);
              });
      start.countDown();
      Resp firstResult = first.get(30, TimeUnit.SECONDS);
      Resp secondResult = second.get(30, TimeUnit.SECONDS);
      assertThat(List.of(firstResult.status, secondResult.status))
          .containsExactlyInAnyOrder(201, 200);
      assertThat(version(sameKeyExpenseId)).isEqualTo(1);
      assertThat(allocationCount(sameKeyExpenseId)).isEqualTo(1);
      assertThat(allocationKeyCount(owner.userId(), householdId)).isEqualTo(1);
    } finally {
      pool.shutdownNow();
    }

    // Different keys race on the one-active-allocation rule: one 201, one 409.
    String conflictExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-6.00", "USD", "Conflict", "2026-09-16", "HOUSEHOLD")));
    pool = Executors.newFixedThreadPool(2);
    try {
      CountDownLatch start = new CountDownLatch(1);
      Future<Resp> first =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "POST",
                    allocationPath(householdId, conflictExpenseId),
                    sameBody,
                    owner.csrfToken,
                    UUID.randomUUID());
              });
      Future<Resp> second =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "POST",
                    allocationPath(householdId, conflictExpenseId),
                    sameBody,
                    owner.csrfToken,
                    UUID.randomUUID());
              });
      start.countDown();
      Resp firstResult = first.get(30, TimeUnit.SECONDS);
      Resp secondResult = second.get(30, TimeUnit.SECONDS);
      assertThat(List.of(firstResult.status, secondResult.status))
          .containsExactlyInAnyOrder(201, 409);
      Resp losingCreate = firstResult.status == 409 ? firstResult : secondResult;
      assertThat(losingCreate.json().path("code").asText())
          .as(losingCreate.body)
          .isEqualTo("ALLOCATION_CONFLICT");
      assertThat(version(conflictExpenseId)).isEqualTo(1);
      assertThat(allocationCount(conflictExpenseId)).isEqualTo(1);
    } finally {
      pool.shutdownNow();
    }

    // A held household lifecycle lock times the create out with 503 and no partial state.
    String busyExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(account, "EXPENSE", "-4.00", "USD", "Busy", "2026-09-16", "HOUSEHOLD")));
    UUID busyKey = UUID.randomUUID();
    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (PreparedStatement lock =
          connection.prepareStatement("SELECT id FROM households WHERE id = ?::uuid FOR UPDATE")) {
        lock.setString(1, householdId);
        try (ResultSet rows = lock.executeQuery()) {
          assertThat(rows.next()).isTrue();
        }
        Resp busy =
            owner.request(
                "POST",
                allocationPath(householdId, busyExpenseId),
                sameBody,
                owner.csrfToken,
                busyKey);
        assertThat(busy.status).isEqualTo(503);
        assertThat(busy.json().path("code").asText()).isEqualTo("FINANCE_BUSY");
        assertThat(busy.cacheControl()).contains("no-store");
      } finally {
        connection.rollback();
      }
    }
    assertThat(version(busyExpenseId)).isZero();
    assertThat(allocationCount(busyExpenseId)).isZero();
    // Two earlier creates committed keys in this household; the timed-out create reserved none.
    assertThat(allocationKeyCount(owner.userId(), householdId)).isEqualTo(2);

    // The rolled-back create reserved nothing, so the same key succeeds on retry.
    Resp retried =
        owner.request(
            "POST", allocationPath(householdId, busyExpenseId), sameBody, owner.csrfToken, busyKey);
    assertThat(retried.status).isEqualTo(201);
    assertThat(version(busyExpenseId)).isEqualTo(1);
  }

  private String refundId(String expenseId) {
    return jdbc.queryForObject(
        "SELECT id::text FROM financial_transactions WHERE refund_of_transaction_id = ?::uuid",
        String.class,
        UUID.fromString(expenseId));
  }

  private String visibility(String transactionId) {
    return jdbc.queryForObject(
        "SELECT visibility FROM financial_transactions WHERE id = ?::uuid",
        String.class,
        UUID.fromString(transactionId));
  }

  private java.math.BigDecimal amount(String transactionId) {
    return jdbc.queryForObject(
        "SELECT amount FROM financial_transactions WHERE id = ?::uuid",
        java.math.BigDecimal.class,
        UUID.fromString(transactionId));
  }

  private String status(String transactionId) {
    return jdbc.queryForObject(
        "SELECT status FROM financial_transactions WHERE id = ?::uuid",
        String.class,
        UUID.fromString(transactionId));
  }

  private java.time.Instant revokedAt(String allocationId) {
    return jdbc.queryForObject(
        "SELECT revoked_at FROM financial_transaction_allocations WHERE id = ?::uuid",
        java.time.Instant.class,
        UUID.fromString(allocationId));
  }

  @Test
  void exactPreviewAndCreateProjectCompleteRefundAndPreserveOwnerOnlyRights() throws Exception {
    Agent owner = signedInAgent("exact-owner");
    String household = createHousehold(owner, "Exact home");
    Agent member = signedInAgent("exact-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role)"
            + " VALUES (?::uuid, ?::uuid, 'MEMBER')",
        household,
        member.userId());
    String account = createAccount(owner, household, "Exact card", "CASH", "USD");
    String expense =
        created(
            owner.createTransaction(
                household,
                UUID.randomUUID(),
                datedEntry(
                    account,
                    "EXPENSE",
                    "-10.00",
                    "USD",
                    "Split purchase",
                    "2026-09-16",
                    "HOUSEHOLD")));
    String refund =
        created(
            owner.createTransaction(
                household,
                UUID.randomUUID(),
                refundEntry(account, expense, "1.00", "USD", "Partial return")));
    String path = allocationPath(household, expense);
    String first = owner.userId();
    String second = member.userId();
    String body =
        "{\"expectedVersion\":1,\"participantShares\":["
            + "{\"userId\":\""
            + second
            + "\",\"share\":{\"amount\":\"3\",\"currency\":\"USD\"}},"
            + "{\"userId\":\""
            + first
            + "\",\"share\":{\"amount\":\"7.00\",\"currency\":\"USD\"}}]}";
    int originalVersion = version(expense);
    Resp denied = member.post(path + "/preview", body, member.csrfToken);
    assertThat(denied.status).isEqualTo(403);
    assertThat(owner.post(path + "/preview", body, null).status).isEqualTo(403);
    Resp invalidUnion =
        owner.post(
            path + "/preview",
            "{\"expectedVersion\":1,\"participantUserIds\":[],\"participantShares\":[]}",
            owner.csrfToken);
    assertThat(invalidUnion.status).isEqualTo(400);
    Resp invalidSum =
        owner.post(path + "/preview", body.replace("\"3\"", "\"2\""), owner.csrfToken);
    assertThat(invalidSum.status).isEqualTo(400);
    assertThat(invalidSum.json().path("fieldErrors").has("participantShares")).isTrue();
    Resp preview = owner.post(path + "/preview", body, owner.csrfToken);
    assertThat(preview.status).as(preview.body).isEqualTo(200);
    assertThat(preview.json().path("impact").path("cumulativeRefundAmount").path("amount").asText())
        .isEqualTo("1.00");
    assertThat(preview.json().path("impact").path("payerCredit").path("amount").asText())
        .isEqualTo("9.00");
    assertThat(version(expense)).isEqualTo(originalVersion);
    assertThat(allocationCount(expense)).isZero();
    assertThat(allocationKeyCount(owner.userId(), household)).isZero();
    UUID key = UUID.randomUUID();
    Resp created = owner.request("POST", path, body, owner.csrfToken, key);
    assertThat(created.status).as(created.body).isEqualTo(201);
    assertThat(created.json().path("method").asText()).isEqualTo("EXACT");
    assertThat(created.json().path("refundPolicy").asText()).isEqualTo("EXACT_JEFFERSON_V1");
    assertThat(created.json().path("impact")).isEqualTo(preview.json().path("impact"));
    assertThat(member.get(path).json().path("impact")).isEqualTo(preview.json().path("impact"));
    assertThat(owner.request("POST", path, body, owner.csrfToken, key).status).isEqualTo(200);
    String normalized = body.replace("\"amount\":\"3\"", "\"amount\":\"3.00\"");
    assertThat(owner.request("POST", path, normalized, owner.csrfToken, key).status).isEqualTo(200);
    Resp changedExactIntent =
        owner.request(
            "POST",
            path,
            body.replace("\"amount\":\"3\"", "\"amount\":\"4\"")
                .replace("\"amount\":\"7.00\"", "\"amount\":\"6.00\""),
            owner.csrfToken,
            key);
    assertThat(changedExactIntent.status).isEqualTo(409);
    assertThat(changedExactIntent.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    Resp noncanonicalExact =
        owner.request(
            "POST",
            path,
            body.replace(second, second.toUpperCase(Locale.ROOT)),
            owner.csrfToken,
            key);
    assertThat(noncanonicalExact.status).isEqualTo(400);
    assertThat(noncanonicalExact.json().path("fieldErrors").propertyNames())
        .containsExactly("participantShares");
    Resp balances = member.get("/api/households/" + household + "/member-balances");
    assertThat(balances.status).isEqualTo(200);
    Resp corrected =
        owner.patchTransaction(
            household,
            refund,
            "{\"expectedVersion\":0,\"money\":{\"amount\":\"2.00\",\"currency\":\"USD\"}}");
    assertThat(corrected.status).as(corrected.body).isEqualTo(200);
    assertThat(
            member
                .get(path)
                .json()
                .path("impact")
                .path("cumulativeRefundAmount")
                .path("amount")
                .asText())
        .isEqualTo("2.00");
    assertThat(member.get(path).json().path("impact").path("participants").size()).isEqualTo(2);
    assertThat(balances.body).contains("\"amount\":\"2.70\"");
    Resp revoked =
        owner.request(
            "PATCH", path, "{\"expectedVersion\":3,\"status\":\"REVOKED\"}", owner.csrfToken, null);
    assertThat(revoked.status).as(revoked.body).isEqualTo(200);
    assertThat(revoked.json().path("impact").isNull()).isTrue();
    assertThat(
            owner.request("POST", path, body, owner.csrfToken, key).json().path("impact").isNull())
        .isTrue();
  }

  private String allocationPath(String householdId, String transactionId) {
    return "/api/households/" + householdId + "/transactions/" + transactionId + "/allocation";
  }

  /** Entry body without visibility (defaults to PRIVATE) or category fields. */
  private static String datedEntry(
      String accountId,
      String kind,
      String amount,
      String currency,
      String description,
      String date,
      String visibility) {
    StringBuilder builder =
        new StringBuilder(
            "{\"accountId\":\""
                + accountId
                + "\",\"kind\":\""
                + kind
                + "\",\"money\":{\"amount\":\""
                + amount
                + "\",\"currency\":\""
                + currency
                + "\"},\"occurredOn\":\""
                + date
                + "\",\"description\":\""
                + description
                + "\"");
    if (visibility != null) {
      builder.append(",\"visibility\":\"").append(visibility).append("\"");
    }
    return builder.append("}").toString();
  }

  private static String refundEntry(
      String accountId, String sourceId, String amount, String currency, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},"
        + "\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\",\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  private int version(String transactionId) {
    return jdbc.queryForObject(
        "SELECT version FROM financial_transactions WHERE id = ?::uuid",
        Integer.class,
        UUID.fromString(transactionId));
  }

  private int allocationCount(String transactionId) {
    return jdbc.queryForObject(
        "SELECT COUNT(*) FROM financial_transaction_allocations WHERE transaction_id = ?::uuid",
        Integer.class,
        UUID.fromString(transactionId));
  }

  private String allocationStatus(String allocationId) {
    return jdbc.queryForObject(
        "SELECT status FROM financial_transaction_allocations WHERE id = ?::uuid",
        String.class,
        UUID.fromString(allocationId));
  }

  private int participantCount(String allocationId) {
    return jdbc.queryForObject(
        "SELECT COUNT(*) FROM financial_transaction_allocation_participants"
            + " WHERE allocation_id = ?::uuid",
        Integer.class,
        UUID.fromString(allocationId));
  }

  private int allocationKeyCount(String actorId, String householdId) {
    return jdbc.queryForObject(
        "SELECT COUNT(*) FROM financial_allocation_idempotency_keys"
            + " WHERE actor_user_id = ?::uuid AND household_id = ?::uuid",
        Integer.class,
        UUID.fromString(actorId),
        UUID.fromString(householdId));
  }

  private static List<String> sorted(List<String> ids) {
    return ids.stream().sorted(Comparator.comparing(id -> id)).toList();
  }

  private static String participantArray(String... ids) {
    StringBuilder builder = new StringBuilder();
    for (int index = 0; index < ids.length; index++) {
      if (index > 0) builder.append(",");
      builder.append("\"").append(ids[index]).append("\"");
    }
    return builder.toString();
  }

  private static String createBody(String expectedVersion, String participantArrayContents) {
    return "{\"expectedVersion\":"
        + expectedVersion
        + ",\"participantUserIds\":["
        + participantArrayContents
        + "]}";
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

  private String createAccount(
      Agent agent, String householdId, String name, String kind, String currency) throws Exception {
    Resp response =
        agent.request(
            "POST",
            "/api/households/" + householdId + "/financial-accounts",
            "{\"name\":\""
                + name
                + "\",\"kind\":\""
                + kind
                + "\",\"currency\":\""
                + currency
                + "\"}",
            agent.csrfToken,
            UUID.randomUUID());
    assertThat(response.status).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String created(Resp response) throws Exception {
    assertThat(response.status).as(response.body).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String identityJson(String email) {
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

    Resp createTransaction(String householdId, UUID key, String json) throws Exception {
      return request("POST", transactionPath(householdId), json, csrfToken, key);
    }

    Resp patchTransaction(String householdId, String transactionId, String json) throws Exception {
      return request(
          "PATCH", transactionPath(householdId) + "/" + transactionId, json, csrfToken, null);
    }

    Resp request(String method, String path, String json, String csrf, UUID idempotencyKey)
        throws Exception {
      return requestWithKey(
          method, path, json, csrf, idempotencyKey == null ? null : idempotencyKey.toString());
    }

    Resp requestRawKey(String method, String path, String json, String csrf, String rawKey)
        throws Exception {
      return requestWithKey(method, path, json, csrf, rawKey);
    }

    private Resp requestWithKey(String method, String path, String json, String csrf, String rawKey)
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
      if (json != null) builder.header("Content-Type", "application/json");
      if (csrf != null) builder.header("X-CSRF-TOKEN", csrf);
      if (rawKey != null) builder.header("Idempotency-Key", rawKey);
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

  private static String transactionPath(String householdId) {
    return "/api/households/" + householdId + "/transactions";
  }
}
