package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
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
 * Category contract on real PostgreSQL: the fixed taxonomy endpoint, nullable category create/patch
 * semantics with explicit null, refund inheritance and whole-group propagation including retained
 * voided refunds, voided-entry rejection, fingerprint participation, and the source-expense version
 * as the refund-group concurrency token.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class TransactionCategoryHttpIT {

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

  @Autowired private com.housesync.identity.application.IdentityGrants grants;
  @Autowired private JdbcTemplate jdbc;
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void taxonomyEndpointReturnsExactFixedListToCurrentMembersOnly() throws Exception {
    Agent actor = signedInAgent("taxonomy-owner");
    String householdId = createHousehold(actor, "Taxonomy home");
    Agent member = signedInAgent("taxonomy-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());

    Resp list = actor.get(categoryPath(householdId));
    assertThat(list.status).isEqualTo(200);
    assertThat(list.cacheControl()).contains("no-store");
    JsonNode body = list.json();
    assertThat(body.propertyNames()).containsExactly("items");
    JsonNode items = body.path("items");
    assertThat(items.size()).isEqualTo(16);
    List<String> codes = new ArrayList<>();
    for (JsonNode item : items) {
      assertThat(item.propertyNames()).containsExactly("code", "label");
      codes.add(item.path("code").asText());
    }
    assertThat(codes)
        .containsExactly(
            "HOUSING",
            "GROCERIES",
            "DINING",
            "UTILITIES",
            "TRANSPORTATION",
            "SHOPPING",
            "ENTERTAINMENT",
            "HEALTHCARE",
            "TRAVEL",
            "EDUCATION",
            "PERSONAL",
            "HOUSEHOLD_SUPPLIES",
            "SUBSCRIPTIONS",
            "INCOME",
            "TRANSFERS",
            "MISCELLANEOUS");
    assertThat(items.get(0).path("label").asText()).isEqualTo("Housing");
    assertThat(items.get(1).path("label").asText()).isEqualTo("Groceries");
    assertThat(items.get(11).path("label").asText()).isEqualTo("Household Supplies");
    assertThat(items.get(14).path("label").asText()).isEqualTo("Transfers");
    assertThat(items.get(15).path("label").asText()).isEqualTo("Miscellaneous");

    Resp memberList = member.get(categoryPath(householdId));
    assertThat(memberList.status).isEqualTo(200);
    assertThat(memberList.json().path("items").size()).isEqualTo(16);

    Resp queried = actor.get(categoryPath(householdId) + "?limit=5");
    assertThat(queried.status).isEqualTo(400);
    assertThat(queried.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(queried.json().has("fieldErrors")).isFalse();
    assertThat(queried.cacheControl()).contains("no-store");

    Agent outsider = signedInAgent("taxonomy-outsider");
    Resp outsiderList = outsider.get(categoryPath(householdId));
    assertThat(outsiderList.status).isEqualTo(404);
    assertThat(outsiderList.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(outsiderList.body).doesNotContain("Taxonomy", householdId);

    Agent anonymous = new Agent();
    Resp unauthenticated = anonymous.get(categoryPath(householdId));
    assertThat(unauthenticated.status).isEqualTo(401);
    assertThat(unauthenticated.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");

    // The route is GET-only: an authenticated caller presenting a valid CSRF token still
    // reaches the security denial, never CSRF handling or a controller mapping.
    Resp deniedPost = actor.request("POST", categoryPath(householdId), "{}", actor.csrfToken, null);
    Resp deniedDelete =
        actor.request("DELETE", categoryPath(householdId), null, actor.csrfToken, null);
    for (Resp response : List.of(deniedPost, deniedDelete)) {
      assertThat(response.status).isEqualTo(403);
      assertThat(response.json().path("code").asText()).isEqualTo("FORBIDDEN");
    }
  }

  @Test
  void categoryCreateAcceptsOmissionExplicitNullAndExactTokens() throws Exception {
    Agent actor = signedInAgent("category-create");
    String householdId = createHousehold(actor, "Category create home");
    String accountId = createAccount(actor, householdId, "BRL");

    String omittedId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-5.00", "BRL", "Omitted")));
    String explicitNullId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                "{\"accountId\":\""
                    + accountId
                    + "\",\"kind\":\"EXPENSE\","
                    + "\"money\":{\"amount\":\"-5.00\",\"currency\":\"BRL\"},"
                    + "\"occurredOn\":\"2026-09-16\",\"description\":\"Cleared\",\"category\":null}"));
    String tokenId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entryWithCategory(accountId, "EXPENSE", "-5.00", "BRL", "Sorted", "GROCERIES")));
    String incomeId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entryWithCategory(accountId, "INCOME", "5.00", "BRL", "Wage", "INCOME")));

    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                UUID.fromString(omittedId)))
        .isNull();
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                UUID.fromString(explicitNullId)))
        .isNull();
    Resp detail = actor.get(transactionPath(householdId) + "/" + tokenId);
    assertThat(detail.status).isEqualTo(200);
    assertThat(detail.json().path("category").asText()).isEqualTo("GROCERIES");
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                UUID.fromString(incomeId)))
        .isEqualTo("INCOME");

    JsonNode listed = actor.get(transactionPath(householdId)).json();
    assertThat(items(listed).toString()).contains("GROCERIES");
    assertThat(items(listed).toString()).contains("\"category\":null");

    // An empty token is rejected too, without an impossible empty echo assertion.
    for (String bad : new String[] {"groceries", "UNKNOWN", "HOUSING "}) {
      Resp rejected =
          actor.createTransaction(
              householdId,
              UUID.randomUUID(),
              entryWithCategory(accountId, "EXPENSE", "-5.00", "BRL", "Bad", bad));
      assertThat(rejected.status).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("fieldErrors").propertyNames()).containsExactly("category");
      assertThat(rejected.body).doesNotContain("Bad", bad);
    }
    Resp emptyToken =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            entryWithCategory(accountId, "EXPENSE", "-5.00", "BRL", "Bad", ""));
    assertThat(emptyToken.status).isEqualTo(400);
    assertThat(emptyToken.json().path("fieldErrors").propertyNames()).containsExactly("category");
    Resp numeric =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + accountId
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":\"-5.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Bad\",\"category\":5}");
    assertThat(numeric.status).isEqualTo(400);
    assertThat(numeric.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
  }

  @Test
  void categoryPatchSetsClearsAndKeepsNoopVersionRules() throws Exception {
    Agent actor = signedInAgent("category-patch");
    String householdId = createHousehold(actor, "Category patch home");
    String accountId = createAccount(actor, householdId, "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entryWithCategory(accountId, "EXPENSE", "-5.00", "BRL", "Coffee", "DINING")));

    Resp renamed =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":0,\"category\":\"HOUSING\"}");
    assertThat(renamed.status).isEqualTo(200);
    assertThat(renamed.json().path("category").asText()).isEqualTo("HOUSING");
    assertThat(renamed.json().path("version").asInt()).isEqualTo(1);

    Resp cleared =
        actor.patchTransaction(householdId, expenseId, "{\"expectedVersion\":1,\"category\":null}");
    assertThat(cleared.status).isEqualTo(200);
    assertThat(cleared.json().path("category").isNull()).isTrue();
    assertThat(cleared.json().path("version").asInt()).isEqualTo(2);

    Resp setAgain =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":2,\"category\":\"DINING\"}");
    assertThat(setAgain.status).isEqualTo(200);
    assertThat(setAgain.json().path("version").asInt()).isEqualTo(3);

    Resp sameValue =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":3,\"category\":\"DINING\"}");
    assertThat(sameValue.status).isEqualTo(200);
    assertThat(sameValue.json().path("version").asInt()).isEqualTo(3);

    Resp unknown =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":3,\"category\":\"CAFE\"}");
    assertThat(unknown.status).isEqualTo(400);
    assertThat(unknown.json().path("fieldErrors").propertyNames()).containsExactly("category");

    Resp numeric =
        actor.patchTransaction(householdId, expenseId, "{\"expectedVersion\":3,\"category\":7}");
    assertThat(numeric.status).isEqualTo(400);
  }

  @Test
  void refundCategoryInheritsSourceAndRejectsExplicitMismatch() throws Exception {
    Agent actor = signedInAgent("refund-category");
    String householdId = createHousehold(actor, "Refund category home");
    String accountId = createAccount(actor, householdId, "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entryWithCategory(accountId, "EXPENSE", "-50.00", "BRL", "Purchase", "GROCERIES")));

    String inheritedId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "10.00", "Inherit")));
    assertThat(category(inheritedId)).isEqualTo("GROCERIES");

    String matchedId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundWithCategory(accountId, expenseId, "5.00", "Matched", "GROCERIES")));
    assertThat(category(matchedId)).isEqualTo("GROCERIES");

    Resp explicitNullOnCategorized =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + accountId
                + "\",\"kind\":\"REFUND\","
                + "\"money\":{\"amount\":\"5.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Wrong\","
                + "\"category\":null,\"refundOfTransactionId\":\""
                + expenseId
                + "\"}");
    assertThat(explicitNullOnCategorized.status).isEqualTo(400);
    assertThat(explicitNullOnCategorized.json().path("fieldErrors").propertyNames())
        .containsExactly("category");
    assertThat(explicitNullOnCategorized.body).doesNotContain("Wrong", "Purchase");

    Resp explicitMismatch =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundWithCategory(accountId, expenseId, "5.00", "Wrong", "DINING"));
    assertThat(explicitMismatch.status).isEqualTo(400);
    assertThat(explicitMismatch.json().path("fieldErrors").propertyNames())
        .containsExactly("category");
    assertThat(explicitMismatch.body).doesNotContain("DINING");

    String uncategorizedId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-20.00", "BRL", "Plain")));
    String clearedId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                "{\"accountId\":\""
                    + accountId
                    + "\",\"kind\":\"REFUND\","
                    + "\"money\":{\"amount\":\"5.00\",\"currency\":\"BRL\"},"
                    + "\"occurredOn\":\"2026-09-16\",\"description\":\"Clear\","
                    + "\"category\":null,\"refundOfTransactionId\":\""
                    + uncategorizedId
                    + "\"}"));
    assertThat(category(clearedId)).isNull();
  }

  @Test
  void directRefundCategoryAndVisibilityPatchesAreAlwaysRejected() throws Exception {
    Agent actor = signedInAgent("refund-direct-patch");
    String householdId = createHousehold(actor, "Refund patch home");
    String accountId = createAccount(actor, householdId, "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-50.00", "BRL", "Bought")));
    String refundId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "10.00", "Back")));

    Resp directCategory =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":0,\"category\":\"DINING\"}");
    assertThat(directCategory.status).isEqualTo(400);
    assertThat(directCategory.json().path("fieldErrors").propertyNames())
        .containsExactly("category");

    Resp directClear =
        actor.patchTransaction(householdId, refundId, "{\"expectedVersion\":0,\"category\":null}");
    assertThat(directClear.status).isEqualTo(400);
    assertThat(directClear.json().path("fieldErrors").propertyNames()).containsExactly("category");

    Resp directVisibility =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":0,\"visibility\":\"HOUSEHOLD\"}");
    assertThat(directVisibility.status).isEqualTo(400);
    assertThat(directVisibility.json().path("fieldErrors").propertyNames())
        .containsExactly("visibility");

    // The rejected refund patch leaves the row unchanged.
    assertThat(version(refundId)).isZero();
    assertThat(category(refundId)).isNull();
  }

  @Test
  void sourceCategoryPatchPropagatesToPostedAndVoidedRefundsWithVersionBumps() throws Exception {
    Agent actor = signedInAgent("group-category");
    String householdId = createHousehold(actor, "Group category home");
    String accountId = createAccount(actor, householdId, "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entryWithCategory(accountId, "EXPENSE", "-50.00", "BRL", "Purchase", "GROCERIES")));
    String firstRefundId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "10.00", "First")));
    assertThat(category(firstRefundId)).isEqualTo("GROCERIES");

    // The source patch re-propagates the changed token to every linked refund.
    Resp renamed =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"category\":\"HOUSING\"}");
    assertThat(renamed.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(2);
    assertThat(category(firstRefundId)).isEqualTo("HOUSING");
    assertThat(version(firstRefundId)).isEqualTo(1);

    String secondRefundId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "5.00", "Second")));
    assertThat(category(secondRefundId)).isEqualTo("HOUSING");
    assertThat(version(expenseId)).isEqualTo(3);

    Resp voided =
        actor.patchTransaction(
            householdId, firstRefundId, "{\"expectedVersion\":1,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(4);
    assertThat(status(firstRefundId)).isEqualTo("VOIDED");

    Instant beforePropagation = updatedAt(firstRefundId);
    Instant postedBeforePropagation = updatedAt(secondRefundId);
    Resp propagated =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":4,\"category\":\"DINING\"}");
    assertThat(propagated.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(5);
    // The retained voided refund is re-disclosed server-side, never a direct edit.
    assertThat(category(firstRefundId)).isEqualTo("DINING");
    assertThat(status(firstRefundId)).isEqualTo("VOIDED");
    assertThat(version(firstRefundId)).isEqualTo(3);
    assertThat(category(secondRefundId)).isEqualTo("DINING");
    assertThat(version(secondRefundId)).isEqualTo(1);
    assertThat(updatedAt(firstRefundId)).isAfter(beforePropagation);
    assertThat(updatedAt(secondRefundId)).isAfter(postedBeforePropagation);

    Resp noop =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":5,\"category\":\"DINING\"}");
    assertThat(noop.status).isEqualTo(200);
    assertThat(version(expenseId)).isEqualTo(5);
    assertThat(version(firstRefundId)).isEqualTo(3);
    assertThat(version(secondRefundId)).isEqualTo(1);
  }

  @Test
  void voidedEntriesRejectDirectCategoryChangesButKeepSameValueTouches() throws Exception {
    Agent actor = signedInAgent("voided-category");
    String householdId = createHousehold(actor, "Voided category home");
    String accountId = createAccount(actor, householdId, "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entryWithCategory(accountId, "EXPENSE", "-5.00", "BRL", "Coffee", "DINING")));
    Resp voided =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);

    Resp change =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"category\":\"HOUSING\"}");
    assertThat(change.status).isEqualTo(409);
    assertThat(change.json().path("code").asText()).isEqualTo("TRANSACTION_VOIDED");

    Resp clear =
        actor.patchTransaction(householdId, expenseId, "{\"expectedVersion\":1,\"category\":null}");
    assertThat(clear.status).isEqualTo(409);
    assertThat(clear.json().path("code").asText()).isEqualTo("TRANSACTION_VOIDED");

    Resp sameValue =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":1,\"category\":\"DINING\"}");
    assertThat(sameValue.status).isEqualTo(200);
    assertThat(sameValue.json().path("version").asInt()).isEqualTo(1);
    assertThat(sameValue.json().path("status").asText()).isEqualTo("VOIDED");
  }

  @Test
  void categoryIsPartOfTheCreateIdempotencyFingerprint() throws Exception {
    Agent actor = signedInAgent("category-fingerprint");
    String householdId = createHousehold(actor, "Fingerprint category home");
    String accountId = createAccount(actor, householdId, "BRL");
    UUID tokenKey = UUID.randomUUID();
    String tokenPayload =
        entryWithCategory(accountId, "EXPENSE", "-1.00", "BRL", "Fp", "GROCERIES");

    assertThat(actor.createTransaction(householdId, tokenKey, tokenPayload).status).isEqualTo(201);
    assertThat(actor.createTransaction(householdId, tokenKey, tokenPayload).status).isEqualTo(200);

    Resp changedToken =
        actor.createTransaction(
            householdId,
            tokenKey,
            entryWithCategory(accountId, "EXPENSE", "-1.00", "BRL", "Fp", "DINING"));
    assertThat(changedToken.status).isEqualTo(409);
    assertThat(changedToken.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    assertThat(changedToken.body).doesNotContain("DINING");

    Resp omittedUnderTokenKey =
        actor.createTransaction(
            householdId, tokenKey, entry(accountId, "EXPENSE", "-1.00", "BRL", "Fp"));
    assertThat(omittedUnderTokenKey.status).isEqualTo(409);

    UUID nullKey = UUID.randomUUID();
    String nullPayload =
        "{\"accountId\":\""
            + accountId
            + "\",\"kind\":\"EXPENSE\","
            + "\"money\":{\"amount\":\"-2.00\",\"currency\":\"BRL\"},"
            + "\"occurredOn\":\"2026-09-16\",\"description\":\"Null fp\",\"category\":null}";
    assertThat(actor.createTransaction(householdId, nullKey, nullPayload).status).isEqualTo(201);
    Resp nullReplay = actor.createTransaction(householdId, nullKey, nullPayload);
    assertThat(nullReplay.status).isEqualTo(200);
    Resp omittedReplay =
        actor.createTransaction(
            householdId, nullKey, entry(accountId, "EXPENSE", "-2.00", "BRL", "Null fp"));
    assertThat(omittedReplay.status).isEqualTo(200);
    assertThat(omittedReplay.json().path("id").asText())
        .isEqualTo(nullReplay.json().path("id").asText());

    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entryWithCategory(accountId, "EXPENSE", "-50.00", "BRL", "Source", "GROCERIES")));
    UUID refundKey = UUID.randomUUID();
    String refundId =
        created(
            actor.createTransaction(
                householdId, refundKey, refundEntry(accountId, expenseId, "10.00", "Return")));
    Resp refundExplicitReplay =
        actor.createTransaction(
            householdId,
            refundKey,
            refundWithCategory(accountId, expenseId, "10.00", "Return", "GROCERIES"));
    assertThat(refundExplicitReplay.status).isEqualTo(409);
    assertThat(refundExplicitReplay.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    assertThat(
            jdbc.queryForObject(
                "SELECT resource_id FROM financial_transaction_idempotency_keys"
                    + " WHERE idempotency_key = ?::uuid",
                String.class,
                refundKey))
        .isEqualTo(refundId);
  }

  @Test
  void refundExplicitNullAndOmittedCategoryAreDistinctIdempotencyFingerprints() throws Exception {
    Agent actor = signedInAgent("refund-null-fp");
    String householdId = createHousehold(actor, "Refund null fingerprint home");
    String accountId = createAccount(actor, householdId, "BRL");
    String uncategorizedId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-20.00", "BRL", "Uncategorized source")));

    // Omission is an INHERIT instruction; replaying the same key with an explicit null is
    // a different instruction against the same uncategorized source, so it conflicts.
    UUID inheritKey = UUID.randomUUID();
    String inheritedId =
        created(
            actor.createTransaction(
                householdId,
                inheritKey,
                refundEntry(accountId, uncategorizedId, "5.00", "Inherit")));
    Resp nullReplay =
        actor.createTransaction(
            householdId,
            inheritKey,
            refundWithNullCategory(accountId, uncategorizedId, "5.00", "Inherit"));
    assertThat(nullReplay.status).isEqualTo(409);
    assertThat(nullReplay.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    // The conflicting replay reserves nothing; the inherited fingerprint still replays.
    Resp inheritedReplay =
        actor.createTransaction(
            householdId, inheritKey, refundEntry(accountId, uncategorizedId, "5.00", "Inherit"));
    assertThat(inheritedReplay.status).isEqualTo(200);
    assertThat(inheritedReplay.json().path("id").asText()).isEqualTo(inheritedId);

    // The mirror order conflicts too: the key now holds the explicit-null instruction.
    UUID nullKey = UUID.randomUUID();
    String clearedId =
        created(
            actor.createTransaction(
                householdId,
                nullKey,
                refundWithNullCategory(accountId, uncategorizedId, "4.00", "Cleared")));
    Resp omittedReplay =
        actor.createTransaction(
            householdId, nullKey, refundEntry(accountId, uncategorizedId, "4.00", "Cleared"));
    assertThat(omittedReplay.status).isEqualTo(409);
    assertThat(omittedReplay.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    Resp clearedReplay =
        actor.createTransaction(
            householdId,
            nullKey,
            refundWithNullCategory(accountId, uncategorizedId, "4.00", "Cleared"));
    assertThat(clearedReplay.status).isEqualTo(200);
    assertThat(clearedReplay.json().path("id").asText()).isEqualTo(clearedId);
    assertThat(category(clearedId)).isNull();
  }

  @Test
  void sourceExpenseVersionExhaustionFailsSafelyForRefundGroupOperations() throws Exception {
    Agent actor = signedInAgent("exhaustion-category");
    String householdId = createHousehold(actor, "Exhaustion category home");
    String accountId = createAccount(actor, householdId, "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-50.00", "BRL", "Cap")));

    jdbc.update(
        "UPDATE financial_transactions SET version = 2147483647 WHERE id = ?::uuid", expenseId);

    UUID blockedKey = UUID.randomUUID();
    Resp blockedCreate =
        actor.createTransaction(
            householdId, blockedKey, refundEntry(accountId, expenseId, "10.00", "Blocked"));
    assertThat(blockedCreate.status).isEqualTo(409);
    assertThat(blockedCreate.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    assertThat(blockedCreate.cacheControl()).contains("no-store");
    // A rolled-back create reserves nothing; the key stays usable.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transaction_idempotency_keys"
                    + " WHERE idempotency_key = ?::uuid",
                Integer.class,
                blockedKey))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid"
                    + " AND kind = 'REFUND'",
                Integer.class,
                UUID.fromString(householdId)))
        .isZero();

    Resp blockedPatch =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":2147483647,\"category\":\"DINING\"}");
    assertThat(blockedPatch.status).isEqualTo(409);
    assertThat(blockedPatch.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");

    Resp provenanceAtMax =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":2147483647,\"category\":null}");
    assertThat(provenanceAtMax.status).isEqualTo(409);
    assertThat(provenanceAtMax.json().path("code").asText())
        .isEqualTo("RESOURCE_VERSION_EXHAUSTED");

    jdbc.update("UPDATE financial_transactions SET version = 0 WHERE id = ?::uuid", expenseId);
    String refundId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "10.00", "Live")));
    jdbc.update(
        "UPDATE financial_transactions SET version = 2147483647 WHERE id = ?::uuid", expenseId);
    Resp blockedCorrection =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":0,\"description\":\"Bigger\"}");
    assertThat(blockedCorrection.status).isEqualTo(409);
    assertThat(blockedCorrection.json().path("code").asText())
        .isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    Resp blockedVoid =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(blockedVoid.status).isEqualTo(409);
    assertThat(blockedVoid.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    assertThat(status(refundId)).isEqualTo("POSTED");
    // The successful "Live" create reserved its key once; the blocked mutations reserved
    // nothing and changed nothing.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transaction_idempotency_keys"
                    + " WHERE resource_id = ?::uuid",
                Integer.class,
                UUID.fromString(refundId)))
        .isEqualTo(1);
  }

  @Test
  void concurrentCategoryPropagationAndRefundCreateSerializeWithoutPartialState() throws Exception {
    Agent actor = signedInAgent("category-race");
    String householdId = createHousehold(actor, "Category race home");
    String accountId = createAccount(actor, householdId, "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-50.00", "BRL", "Race")));

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    Resp renamed;
    Resp refunded;
    try {
      Future<Resp> renaming =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return actor.patchTransaction(
                    householdId, expenseId, "{\"expectedVersion\":0,\"category\":\"DINING\"}");
              });
      Future<Resp> refunding =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return actor.createTransaction(
                    householdId,
                    UUID.randomUUID(),
                    refundEntry(accountId, expenseId, "10.00", "Raced"));
              });
      start.countDown();
      renamed = renaming.get(30, TimeUnit.SECONDS);
      refunded = refunding.get(30, TimeUnit.SECONDS);
      // Serialized by the household lock; either order is contract-valid: the refund create
      // always lands (201), while the patch either applies first (200) or conflicts on the
      // version the refund bump moved (409), exactly like the sharing race contract.
      assertThat(refunded.status).isEqualTo(201);
      assertThat(renamed.status).isIn(200, 409);
      assertThat(refunded.json().path("refundOfTransactionId").asText()).isEqualTo(expenseId);
    } finally {
      pool.shutdownNow();
    }
    // The group ends coherent either way: the refund shares the expense's final category,
    // and the expense version carries every state-changing refund group operation.
    String finalCategory = category(expenseId);
    assertThat(category(refunded.json().path("id").asText())).isEqualTo(finalCategory);
    assertThat(version(expenseId)).isEqualTo(renamed.status == 200 ? 2 : 1);
  }

  private String category(String transactionId) throws Exception {
    return jdbc.queryForObject(
        "SELECT category FROM financial_transactions WHERE id = ?::uuid",
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

  private static String categoryPath(String householdId) {
    return "/api/households/" + householdId + "/transaction-categories";
  }

  private static String transactionPath(String householdId) {
    return "/api/households/" + householdId + "/transactions";
  }

  /** Entry body without category or visibility fields. */
  private static String entry(
      String accountId, String kind, String amount, String currency, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\""
        + kind
        + "\",\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\"}";
  }

  /** Entry body with an explicit category token. */
  private static String entryWithCategory(
      String accountId,
      String kind,
      String amount,
      String currency,
      String description,
      String category) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\""
        + kind
        + "\",\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\",\"category\":\""
        + category
        + "\"}";
  }

  /** Refund entry without a category field, inheriting its expense. */
  private static String refundEntry(
      String accountId, String sourceId, String amount, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\"BRL\"},"
        + "\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\",\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  /** Refund entry with an explicit category token. */
  private static String refundWithCategory(
      String accountId, String sourceId, String amount, String description, String category) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\"BRL\"},"
        + "\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\",\"category\":\""
        + category
        + "\",\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  /** Refund entry with an explicit null category instruction. */
  private static String refundWithNullCategory(
      String accountId, String sourceId, String amount, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\"BRL\"},"
        + "\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\",\"category\":null,\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  private Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String email =
        tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    String enrollmentCode = grants.issue("ENROLLMENT", email).code();
    String registration = registrationJson(email, enrollmentCode);
    assertThat(agent.post("/api/auth/register", registration, agent.csrfToken()).status)
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

  private String createAccount(Agent agent, String householdId, String currency) throws Exception {
    Resp response =
        agent.request(
            "POST",
            "/api/households/" + householdId + "/financial-accounts",
            "{\"name\":\"Card\",\"kind\":\"CASH\",\"currency\":\"" + currency + "\"}",
            agent.csrfToken,
            UUID.randomUUID());
    assertThat(response.status).isEqualTo(201);
    return response.json().path("id").asText();
  }

  /** Registration payload: the enrollment code is recipient-bound and single-use. */
  private static String registrationJson(String email, String enrollmentCode) {
    return "{\"email\":\""
        + email
        + "\",\"password\":\""
        + PASSWORD
        + "\",\"enrollmentCode\":\""
        + enrollmentCode
        + "\"}";
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
