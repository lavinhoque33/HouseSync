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
import java.time.Instant;
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

/**
 * Sharing contract on real PostgreSQL: SQL-scoped household feed over disclosed entries
 * from any owner including departed owners, non-owner account redaction in feed and detail,
 * financial-owner-only mutation, whole-refund-group disclosure and revocation with the source
 * expense version as the group concurrency token, lifecycle-safe access for removed members and
 * outsiders, and bounded lock behavior with no partial state.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class TransactionSharingHttpIT {

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
  void householdFeedScopesDisclosedEntriesInSqlWithFiltersAndPagination() throws Exception {
    Agent owner = signedInAgent("feed-owner");
    String householdId = createHousehold(owner, "Feed home");
    Agent member = signedInAgent("feed-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String ownerBrlAccount = createAccount(owner, householdId, "Owner brl", "CASH", "BRL");
    String memberAccount = createAccount(member, householdId, "Member card", "CASH", "BRL");

    String newestShared =
        created(
            member.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    memberAccount,
                    "EXPENSE",
                    "-1.00",
                    "BRL",
                    "Member shared",
                    "2026-09-14",
                    "HOUSEHOLD")));
    String middleShared =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerBrlAccount,
                    "EXPENSE",
                    "-2.00",
                    "BRL",
                    "Shared brl",
                    "2026-09-13",
                    "HOUSEHOLD")));
    String oldestShared =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount, "EXPENSE", "-3.00", "USD", "Shared", "2026-09-12", "HOUSEHOLD")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(ownerAccount, "EXPENSE", "-4.00", "USD", "Hidden", "2026-09-15", null)));
    created(
        member.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(
                memberAccount, "EXPENSE", "-5.00", "BRL", "Member private", "2026-09-15", null)));

    JsonNode household = member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json();
    assertThat(items(household).size()).as(household.toString()).isEqualTo(3);
    assertThat(items(household).get(0).path("description").asText()).isEqualTo("Member shared");
    assertThat(items(household).get(1).path("description").asText()).isEqualTo("Shared brl");
    assertThat(items(household).get(2).path("description").asText()).isEqualTo("Shared");
    assertThat(items(household).toString()).doesNotContain("Hidden", "Member private");

    JsonNode ownerHousehold = owner.get(transactionPath(householdId) + "?view=HOUSEHOLD").json();
    assertThat(items(ownerHousehold).size()).isEqualTo(3);
    assertThat(items(ownerHousehold).toString()).doesNotContain("Hidden", "Member private");

    JsonNode firstPage =
        member.get(transactionPath(householdId) + "?view=HOUSEHOLD&limit=2").json();
    assertThat(items(firstPage).size()).isEqualTo(2);
    assertThat(firstPage.path("hasMore").asBoolean()).isTrue();
    JsonNode secondPage =
        member.get(transactionPath(householdId) + "?view=HOUSEHOLD&limit=2&offset=2").json();
    assertThat(items(secondPage).size()).isEqualTo(1);
    assertThat(secondPage.path("hasMore").asBoolean()).isFalse();

    JsonNode usdOnly =
        member.get(transactionPath(householdId) + "?view=HOUSEHOLD&currency=USD").json();
    assertThat(items(usdOnly).size()).isEqualTo(1);
    assertThat(items(usdOnly).get(0).path("description").asText()).isEqualTo("Shared");

    JsonNode windowed =
        member
            .get(transactionPath(householdId) + "?view=HOUSEHOLD&from=2026-09-13&to=2026-09-14")
            .json();
    assertThat(items(windowed).size()).isEqualTo(1);
    assertThat(items(windowed).get(0).path("description").asText()).isEqualTo("Shared brl");

    Resp voided =
        member.patchTransaction(
            householdId, newestShared, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);
    assertThat(items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json()).size())
        .isEqualTo(2);
    assertThat(
            items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD&status=VOIDED").json())
                .size())
        .isEqualTo(1);
    assertThat(
            items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD&status=ALL").json())
                .size())
        .isEqualTo(3);

    // The own view keeps every entry of the actor at both visibilities; the member's shared
    // entry was voided above, so the default POSTED own page shows only their private one.
    JsonNode memberOwn = member.get(transactionPath(householdId)).json();
    assertThat(items(memberOwn).size()).isEqualTo(1);
    assertThat(items(memberOwn).toString()).contains("Member private");
    assertThat(items(member.get(transactionPath(householdId) + "?status=ALL").json()).size())
        .isEqualTo(2);
    JsonNode ownerOwn = owner.get(transactionPath(householdId)).json();
    assertThat(items(ownerOwn).size()).isEqualTo(3);
    assertThat(items(ownerOwn).toString()).contains("Hidden", "Shared");

    Resp accountWithHouseholdView =
        member.get(transactionPath(householdId) + "?view=HOUSEHOLD&accountId=" + memberAccount);
    assertThat(accountWithHouseholdView.status).isEqualTo(400);
    assertThat(accountWithHouseholdView.json().path("fieldErrors").propertyNames())
        .containsExactly("accountId");
  }

  @Test
  void householdFeedAndDetailRedactAccountReferencesForNonOwners() throws Exception {
    Agent owner = signedInAgent("redact-owner");
    String householdId = createHousehold(owner, "Redaction home");
    Agent member = signedInAgent("redact-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String memberAccount = createAccount(member, householdId, "Member card", "CASH", "BRL");

    String sharedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount,
                    "EXPENSE",
                    "-10.00",
                    "USD",
                    "Shared buy",
                    "2026-09-16",
                    "HOUSEHOLD")));
    String privateId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount, "EXPENSE", "-6.00", "USD", "Hidden buy", "2026-09-16", null)));

    JsonNode householdFeed = member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json();
    JsonNode sharedRow = items(householdFeed).get(0);
    assertThat(sharedRow.path("description").asText()).isEqualTo("Shared buy");
    assertThat(sharedRow.path("accountId").isNull()).isTrue();
    assertThat(sharedRow.path("ownerUserId").asText()).isEqualTo(owner.userId());
    assertThat(sharedRow.path("version").asInt()).isEqualTo(0);
    assertThat(items(householdFeed).toString()).doesNotContain("Hidden buy", ownerAccount);

    JsonNode ownFeed = owner.get(transactionPath(householdId)).json();
    for (JsonNode row : items(ownFeed)) {
      assertThat(row.path("accountId").asText()).isEqualTo(ownerAccount);
    }

    JsonNode memberDetail = member.get(transactionPath(householdId) + "/" + sharedId).json();
    assertThat(memberDetail.path("description").asText()).isEqualTo("Shared buy");
    assertThat(memberDetail.path("accountId").isNull()).isTrue();

    JsonNode ownerDetail = owner.get(transactionPath(householdId) + "/" + sharedId).json();
    assertThat(ownerDetail.path("accountId").asText()).isEqualTo(ownerAccount);

    Resp hiddenDetail = member.get(transactionPath(householdId) + "/" + privateId);
    Resp missing = member.get(transactionPath(householdId) + "/" + UUID.randomUUID());
    for (Resp response : List.of(hiddenDetail, missing)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
      assertThat(response.body).doesNotContain("Hidden buy", privateId);
    }
    assertThat(hiddenDetail.json().path("message").asText())
        .isEqualTo(missing.json().path("message").asText());

    String refundId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(ownerAccount, sharedId, "2.00", "USD", "Shared back")));
    JsonNode refundDetail = member.get(transactionPath(householdId) + "/" + refundId).json();
    assertThat(refundDetail.path("accountId").isNull()).isTrue();
    assertThat(refundDetail.path("refundOfTransactionId").asText()).isEqualTo(sharedId);
    assertThat(items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json()).size())
        .isEqualTo(2);

    String memberEntryId =
        created(
            member.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    memberAccount, "EXPENSE", "-1.00", "BRL", "Member buy", "2026-09-16", null)));
    JsonNode memberOwnDetail =
        member.get(transactionPath(householdId) + "/" + memberEntryId).json();
    assertThat(memberOwnDetail.path("accountId").asText()).isEqualTo(memberAccount);
    assertThat(memberOwnDetail.path("visibility").asText()).isEqualTo("PRIVATE");
  }

  @Test
  void mutationsStayFinancialOwnerOnlyAcrossVisibilities() throws Exception {
    Agent owner = signedInAgent("mutate-owner");
    String householdId = createHousehold(owner, "Mutation home");
    Agent member = signedInAgent("mutate-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String sharedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount,
                    "EXPENSE",
                    "-10.00",
                    "USD",
                    "Shared",
                    "2026-09-16",
                    "HOUSEHOLD")));

    Resp memberPatch =
        member.patchTransaction(
            householdId, sharedId, "{\"expectedVersion\":0,\"description\":\"Hijacked\"}");
    assertThat(memberPatch.status).isEqualTo(403);
    assertThat(memberPatch.json().path("code").asText()).isEqualTo("FORBIDDEN");
    assertThat(memberPatch.body).doesNotContain("Hijacked", sharedId);
    assertThat(version(sharedId)).isZero();

    Resp memberCategory =
        member.patchTransaction(
            householdId, sharedId, "{\"expectedVersion\":0,\"category\":\"DINING\"}");
    assertThat(memberCategory.status).isEqualTo(403);

    Resp memberVisibility =
        member.patchTransaction(
            householdId, sharedId, "{\"expectedVersion\":0,\"visibility\":\"PRIVATE\"}");
    assertThat(memberVisibility.status).isEqualTo(403);
    assertThat(visibility(sharedId)).isEqualTo("HOUSEHOLD");

    Resp ownerPatch =
        owner.patchTransaction(
            householdId, sharedId, "{\"expectedVersion\":0,\"description\":\"Corrected\"}");
    assertThat(ownerPatch.status).isEqualTo(200);
    assertThat(ownerPatch.json().path("version").asInt()).isEqualTo(1);

    String privateId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(ownerAccount, "EXPENSE", "-2.00", "USD", "Secret", "2026-09-16", null)));
    Resp memberOnPrivate =
        member.patchTransaction(
            householdId, privateId, "{\"expectedVersion\":0,\"description\":\"Stolen\"}");
    assertThat(memberOnPrivate.status).isEqualTo(404);
    assertThat(memberOnPrivate.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
    assertThat(memberOnPrivate.body).doesNotContain("Stolen", "Secret");

    Agent outsider = signedInAgent("mutate-outsider");
    Resp outsiderPatch =
        outsider.patchTransaction(
            householdId, sharedId, "{\"expectedVersion\":0,\"description\":\"Outside\"}");
    assertThat(outsiderPatch.status).isEqualTo(404);
    assertThat(outsiderPatch.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
  }

  @Test
  void disclosureAndRevocationPropagateToWholeRefundGroupIncludingVoided() throws Exception {
    Agent owner = signedInAgent("group-owner");
    String householdId = createHousehold(owner, "Group home");
    Agent member = signedInAgent("group-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount, "EXPENSE", "-50.00", "BRL", "Group buy", "2026-09-15", null)));
    String liveRefundId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(ownerAccount, expenseId, "10.00", "BRL", "Live back")));

    Resp share =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"visibility\":\"HOUSEHOLD\"}");
    assertThat(share.status).isEqualTo(200);
    assertThat(share.json().path("version").asInt()).isEqualTo(2);
    assertThat(visibility(liveRefundId)).isEqualTo("HOUSEHOLD");
    assertThat(version(liveRefundId)).isEqualTo(1);
    assertThat(items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json()).size())
        .isEqualTo(2);

    String voidedRefundId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(ownerAccount, expenseId, "5.00", "BRL", "Soon voided")));
    Resp voided =
        owner.patchTransaction(
            householdId, voidedRefundId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(4);

    Resp revoked =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":4,\"visibility\":\"PRIVATE\"}");
    assertThat(revoked.status).isEqualTo(200);
    assertThat(revoked.json().path("version").asInt()).isEqualTo(5);
    assertThat(visibility(voidedRefundId)).isEqualTo("PRIVATE");
    assertThat(status(voidedRefundId)).isEqualTo("VOIDED");
    // The whole group is re-versioned by the server-side propagation, including the
    // retained voided refund.
    assertThat(version(voidedRefundId)).isEqualTo(2);
    assertThat(visibility(liveRefundId)).isEqualTo("PRIVATE");
    assertThat(version(liveRefundId)).isEqualTo(2);

    assertThat(items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json()).size())
        .isZero();
    Resp revokedExpense = member.get(transactionPath(householdId) + "/" + expenseId);
    assertThat(revokedExpense.status).isEqualTo(404);
    assertThat(revokedExpense.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
    Resp revokedRefund = member.get(transactionPath(householdId) + "/" + liveRefundId);
    assertThat(revokedRefund.status).isEqualTo(404);

    Resp reShare =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":5,\"visibility\":\"HOUSEHOLD\"}");
    assertThat(reShare.status).isEqualTo(200);
    assertThat(visibility(voidedRefundId)).isEqualTo("HOUSEHOLD");
    // The voided refund is re-versioned once more by the re-disclosure propagation.
    assertThat(version(voidedRefundId)).isEqualTo(3);
    assertThat(items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json()).size())
        .isEqualTo(2);
  }

  @Test
  void voidedExpenseVisibilityPropagatesToEveryRetainedVoidedRefund() throws Exception {
    Agent owner = signedInAgent("voided-group-owner");
    String householdId = createHousehold(owner, "Voided group home");
    Agent member = signedInAgent("voided-group-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount, "EXPENSE", "-50.00", "BRL", "Retained", "2026-09-15", null)));
    String firstVoidedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(ownerAccount, expenseId, "10.00", "BRL", "First back")));
    String secondVoidedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(ownerAccount, expenseId, "5.00", "BRL", "Second back")));

    // Both refunds are voided first, so voiding the expense leaves a whole retained
    // voided refund group behind.
    Resp voidFirst =
        owner.patchTransaction(
            householdId, firstVoidedId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    Resp voidSecond =
        owner.patchTransaction(
            householdId, secondVoidedId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voidFirst.status).isEqualTo(200);
    assertThat(voidSecond.status).isEqualTo(200);
    Resp voidExpense =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":4,\"status\":\"VOIDED\"}");
    assertThat(voidExpense.status).isEqualTo(200);
    assertThat(voidExpense.json().path("version").asInt()).isEqualTo(5);

    Instant firstBefore = updatedAt(firstVoidedId);
    Instant secondBefore = updatedAt(secondVoidedId);
    Resp disclosed =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":5,\"visibility\":\"HOUSEHOLD\"}");
    assertThat(disclosed.status).isEqualTo(200);
    assertThat(disclosed.json().path("version").asInt()).isEqualTo(6);
    assertThat(disclosed.json().path("status").asText()).isEqualTo("VOIDED");

    // Every retained voided refund is re-disclosed and re-versioned server-side in the
    // same patch, each like a direct correction would have versioned it.
    Resp firstDetail = owner.get(transactionPath(householdId) + "/" + firstVoidedId);
    Resp secondDetail = owner.get(transactionPath(householdId) + "/" + secondVoidedId);
    for (Resp response : List.of(firstDetail, secondDetail)) {
      assertThat(response.status).isEqualTo(200);
      assertThat(response.json().path("status").asText()).isEqualTo("VOIDED");
      assertThat(response.json().path("visibility").asText()).isEqualTo("HOUSEHOLD");
      assertThat(response.json().path("version").asInt()).isEqualTo(2);
    }
    assertThat(updatedAt(firstVoidedId)).isAfter(firstBefore);
    assertThat(updatedAt(secondVoidedId)).isAfter(secondBefore);

    // The disclosed voided rows reach the member through the household view as well.
    JsonNode memberFeed =
        member.get(transactionPath(householdId) + "?view=HOUSEHOLD&status=ALL").json();
    assertThat(items(memberFeed).size()).isEqualTo(3);
    assertThat(items(member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json()).size())
        .isZero();
    Resp memberDetail = member.get(transactionPath(householdId) + "/" + firstVoidedId);
    assertThat(memberDetail.status).isEqualTo(200);
    assertThat(memberDetail.json().path("visibility").asText()).isEqualTo("HOUSEHOLD");
    assertThat(memberDetail.json().path("accountId").isNull()).isTrue();
  }

  @Test
  void sharedHistorySurvivesDepartedOwnersAndJoinedLaterMembers() throws Exception {
    Agent owner = signedInAgent("lifecycle-owner");
    String householdId = createHousehold(owner, "Lifecycle sharing home");
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String sharedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount,
                    "EXPENSE",
                    "-8.00",
                    "BRL",
                    "Kept history",
                    "2026-09-16",
                    "HOUSEHOLD")));

    Agent lateJoiner = signedInAgent("lifecycle-late");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        lateJoiner.userId());
    assertThat(
            items(lateJoiner.get(transactionPath(householdId) + "?view=HOUSEHOLD").json()).size())
        .isEqualTo(1);

    Agent successor = signedInAgent("lifecycle-successor");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'OWNER')",
        householdId,
        successor.userId());
    Resp removed =
        successor.request(
            "DELETE",
            "/api/households/" + householdId + "/members/" + owner.userId(),
            null,
            successor.csrfToken,
            null);
    assertThat(removed.status).isEqualTo(204);

    JsonNode remaining = successor.get(transactionPath(householdId) + "?view=HOUSEHOLD").json();
    assertThat(items(remaining).size()).isEqualTo(1);
    assertThat(items(remaining).get(0).path("description").asText()).isEqualTo("Kept history");
    JsonNode departedRow = items(remaining).get(0);
    assertThat(departedRow.path("accountId").isNull()).isTrue();
    assertThat(departedRow.path("ownerUserId").asText()).isEqualTo(owner.userId());
    Resp departedDetail = successor.get(transactionPath(householdId) + "/" + sharedId);
    assertThat(departedDetail.status).isEqualTo(200);
    assertThat(departedDetail.json().path("accountId").isNull()).isTrue();

    Resp revokedList = owner.get(transactionPath(householdId));
    assertThat(revokedList.status).isEqualTo(404);
    assertThat(revokedList.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp revokedDetail = owner.get(transactionPath(householdId) + "/" + sharedId);
    assertThat(revokedDetail.status).isEqualTo(404);
    assertThat(revokedDetail.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        owner.userId());
    JsonNode rejoined = owner.get(transactionPath(householdId)).json();
    assertThat(items(rejoined).size()).isEqualTo(1);
    assertThat(items(rejoined).get(0).path("accountId").asText()).isEqualTo(ownerAccount);
  }

  @Test
  void staleExpenseFormConflictsAfterRefundGroupChanges() throws Exception {
    Agent owner = signedInAgent("stale-owner");
    String householdId = createHousehold(owner, "Stale form home");
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount,
                    "EXPENSE",
                    "-50.00",
                    "BRL",
                    "Stale target",
                    "2026-09-15",
                    "HOUSEHOLD")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(ownerAccount, expenseId, "10.00", "BRL", "Stale refund")));

    Resp staleShare =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":0,\"visibility\":\"PRIVATE\"}");
    assertThat(staleShare.status).isEqualTo(409);
    assertThat(staleShare.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    Resp fresh =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"visibility\":\"PRIVATE\"}");
    assertThat(fresh.status).isEqualTo(200);
    assertThat(fresh.json().path("version").asInt()).isEqualTo(2);
  }

  @Test
  void concurrentVisibilityPatchAndRefundCreateSerializeThroughTheSourceExpenseVersion()
      throws Exception {
    Agent owner = signedInAgent("race-visibility");
    String householdId = createHousehold(owner, "Visibility race home");
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount, "EXPENSE", "-30.00", "BRL", "Race target", "2026-09-15", null)));

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    Resp shared;
    Resp refunded;
    try {
      Future<Resp> sharing =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.patchTransaction(
                    householdId, expenseId, "{\"expectedVersion\":0,\"visibility\":\"HOUSEHOLD\"}");
              });
      Future<Resp> refunding =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.createTransaction(
                    householdId,
                    UUID.randomUUID(),
                    refundEntry(ownerAccount, expenseId, "5.00", "BRL", "Race refund"));
              });
      start.countDown();
      shared = sharing.get(30, TimeUnit.SECONDS);
      refunded = refunding.get(30, TimeUnit.SECONDS);
      // Serialized under the household lock: the disclosure either commits before the
      // refund exists or conflicts on the moved source version; the refund always lands.
      assertThat(refunded.status).isEqualTo(201);
      assertThat(shared.status).isIn(200, 409);
    } finally {
      pool.shutdownNow();
    }
    // The group ends coherent either way: the disclosed entry and its refund agree, and
    // the expense version carries every state-changing refund group operation.
    String refundId = refunded.json().path("id").asText();
    String finalVisibility = visibility(expenseId);
    assertThat(visibility(refundId)).isEqualTo(finalVisibility);
    // Order A (disclosure first): expense v1 from the patch, then v2 from the refund bump.
    // Order B (refund first): expense v1 from the refund bump, and the stale patch conflicts.
    assertThat(version(expenseId)).isEqualTo(shared.status == 200 ? 2 : 1);
    // A freshly created refund is never versioned by its own creation.
    assertThat(version(refundId)).isZero();
    JsonNode feed = owner.get(transactionPath(householdId) + "?view=HOUSEHOLD").json();
    assertThat(items(feed).size()).isEqualTo(shared.status == 200 ? 2 : 0);
  }

  @Test
  void removedMemberAndOutsiderKeepGenericHouseholdDenial() throws Exception {
    Agent owner = signedInAgent("denial-owner");
    String householdId = createHousehold(owner, "Denial home");
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String sharedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount, "EXPENSE", "-8.00", "BRL", "Shared", "2026-09-16", "HOUSEHOLD")));
    Agent member = signedInAgent("denial-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());

    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
        householdId,
        member.userId());
    Resp removedList = member.get(transactionPath(householdId));
    Resp removedFeed = member.get(transactionPath(householdId) + "?view=HOUSEHOLD");
    Resp removedDetail = member.get(transactionPath(householdId) + "/" + sharedId);
    Resp removedPatch =
        member.patchTransaction(
            householdId, sharedId, "{\"expectedVersion\":0,\"description\":\"Ghost\"}");
    for (Resp response : List.of(removedList, removedFeed, removedDetail, removedPatch)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
      assertThat(response.body).doesNotContain("Shared", sharedId);
    }

    Agent outsider = signedInAgent("denial-outsider");
    Resp outsiderFeed = outsider.get(transactionPath(householdId) + "?view=HOUSEHOLD");
    Resp outsiderDetail = outsider.get(transactionPath(householdId) + "/" + sharedId);
    for (Resp response : List.of(outsiderFeed, outsiderDetail)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    }

    Resp ownerDetail = owner.get(transactionPath(householdId) + "/" + sharedId);
    assertThat(ownerDetail.status).isEqualTo(200);
    assertThat(ownerDetail.json().path("accountId").asText()).isEqualTo(ownerAccount);
  }

  @Test
  void heldHouseholdLockTimesOutGroupPropagationWith503AndNoPartialState() throws Exception {
    Agent owner = signedInAgent("busy-sharing");
    String householdId = createHousehold(owner, "Busy sharing home");
    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    ownerAccount, "EXPENSE", "-10.00", "BRL", "Busy target", "2026-09-16", null)));
    String refundId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(ownerAccount, expenseId, "2.00", "BRL", "Busy refund")));

    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (PreparedStatement lock =
          connection.prepareStatement("SELECT id FROM households WHERE id = ?::uuid FOR UPDATE")) {
        lock.setString(1, householdId);
        try (ResultSet rows = lock.executeQuery()) {
          assertThat(rows.next()).isTrue();
        }
        Resp busy =
            owner.patchTransaction(
                householdId, expenseId, "{\"expectedVersion\":0,\"visibility\":\"HOUSEHOLD\"}");
        assertThat(busy.status).isEqualTo(503);
        assertThat(busy.json().path("code").asText()).isEqualTo("FINANCE_BUSY");
        assertThat(busy.cacheControl()).contains("no-store");
      } finally {
        connection.rollback();
      }
    }

    // The refunded group sits at expense v1/refund v0 before the blocked attempt.
    assertThat(visibility(expenseId)).isEqualTo("PRIVATE");
    assertThat(visibility(refundId)).isEqualTo("PRIVATE");
    assertThat(version(expenseId)).isEqualTo(1);
    assertThat(version(refundId)).isZero();

    Resp retried =
        owner.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"visibility\":\"HOUSEHOLD\"}");
    assertThat(retried.status).isEqualTo(200);
    assertThat(retried.json().path("version").asInt()).isEqualTo(2);
    assertThat(visibility(refundId)).isEqualTo("HOUSEHOLD");
    assertThat(version(refundId)).isEqualTo(1);
  }

  private String visibility(String transactionId) throws Exception {
    return jdbc.queryForObject(
        "SELECT visibility FROM financial_transactions WHERE id = ?::uuid",
        String.class,
        UUID.fromString(transactionId));
  }

  private int version(String transactionId) throws Exception {
    return jdbc.queryForObject(
        "SELECT version FROM financial_transactions WHERE id = ?::uuid",
        Integer.class,
        UUID.fromString(transactionId));
  }

  private String status(String transactionId) throws Exception {
    return jdbc.queryForObject(
        "SELECT status FROM financial_transactions WHERE id = ?::uuid",
        String.class,
        UUID.fromString(transactionId));
  }

  private Instant updatedAt(String transactionId) throws Exception {
    return jdbc.queryForObject(
        "SELECT updated_at FROM financial_transactions WHERE id = ?::uuid",
        Instant.class,
        UUID.fromString(transactionId));
  }

  private JsonNode items(JsonNode list) {
    return list.path("items");
  }

  private static String created(Resp response) throws Exception {
    assertThat(response.status).as(response.body).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String transactionPath(String householdId) {
    return "/api/households/" + householdId + "/transactions";
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
    StringBuilder body =
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
      body.append(",\"visibility\":\"").append(visibility).append("\"");
    }
    return body.append("}").toString();
  }

  /** Refund entry inheriting visibility and category from its expense. */
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
      if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey.toString());
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
