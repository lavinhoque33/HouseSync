package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
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
 * Owner-rule HTTP contract against real PostgreSQL: exact owner-private rule item and page shapes,
 * durable idempotent learning with replay and safe conflicts, version-guarded category correction
 * and one-way deactivation, financial-owner privacy against a member, a second household OWNER
 * role, and an outsider, and future-only exact classification that never rewrites existing
 * categories or amounts.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class CategorizationRuleHttpIT {

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
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private static final ObjectMapper mapper = new ObjectMapper();

  @Test
  void learnedRuleIsExactVersionedAndDurablyIdempotent() throws Exception {
    Agent owner = signedInAgent("rule-lifecycle");
    String householdId = createHousehold(owner, "Rule home");
    String accountId = createAccount(owner, householdId, UUID.randomUUID(), "Card", "CASH", "BRL");

    Resp source =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-20.00", "BRL", "Corner Market"));
    String sourceId = created(source);
    assertThat(
            owner.patchTransaction(
                    householdId, sourceId, "{\"expectedVersion\":0,\"category\":\"GROCERIES\"}")
                .status)
        .isEqualTo(200);

    String categorizationPath = transactionPath(householdId) + "/" + sourceId + "/categorization";
    Resp before = owner.get(categorizationPath);
    assertThat(before.json().propertyNames())
        .containsExactly(
            "transactionId",
            "transactionVersion",
            "category",
            "origin",
            "assignedAt",
            "reviewState",
            "ruleEligible");
    assertThat(before.json().path("ruleEligible").asBoolean()).isTrue();

    UUID key = UUID.randomUUID();
    Resp createdRule =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            key);
    assertThat(createdRule.status).isEqualTo(201);
    assertThat(createdRule.cacheControl()).contains("no-store");
    JsonNode rule = createdRule.json();
    assertThat(rule.propertyNames())
        .containsExactly(
            "id",
            "sourceTransactionId",
            "matchType",
            "matchLabel",
            "category",
            "status",
            "version",
            "createdAt",
            "updatedAt");
    assertThat(rule.path("sourceTransactionId").asText()).isEqualTo(sourceId);
    assertThat(rule.path("matchType").asText()).isEqualTo("NORMALIZED_TEXT");
    assertThat(rule.path("matchLabel").asText()).isEqualTo("Corner Market");
    assertThat(rule.path("category").asText()).isEqualTo("GROCERIES");
    assertThat(rule.path("status").asText()).isEqualTo("ACTIVE");
    assertThat(rule.path("version").asInt()).isZero();
    assertThat(rule.path("createdAt").asText()).isNotBlank();
    assertThat(rule.path("updatedAt").asText()).isEqualTo(rule.path("createdAt").asText());
    // The private derived key and ruleset never reach the browser.
    assertThat(createdRule.body).doesNotContain("corner market", "rulesetVersion", "OWNER_RULE");

    Resp afterCreate = owner.get(categorizationPath);
    assertThat(afterCreate.json().path("ruleEligible").asBoolean()).isFalse();

    UUID ruleId = UUID.fromString(rule.path("id").asText());
    Resp replay =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            key);
    assertThat(replay.status).isEqualTo(200);
    assertThat(replay.json().path("id").asText()).isEqualTo(ruleId.toString());
    assertThat(replay.json().path("version").asInt()).isZero();
    assertThat(replay.json().path("status").asText()).isEqualTo("ACTIVE");

    Resp conflictingPayload =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":0}",
            owner.csrfToken,
            key);
    assertThat(conflictingPayload.status).isEqualTo(409);
    assertThat(conflictingPayload.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");

    // Strict shape: unknown fields, missing/malformed versions, missing or malformed keys,
    // unexpected query parameters, and malformed paging values never reach the database.
    List<Resp> rejected =
        List.of(
            owner.request(
                "POST",
                transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
                "{\"expectedTransactionVersion\":1,\"extra\":true}",
                owner.csrfToken,
                UUID.randomUUID()),
            owner.request(
                "POST",
                transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
                "{}",
                owner.csrfToken,
                UUID.randomUUID()),
            owner.request(
                "POST",
                transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
                "{\"expectedTransactionVersion\":-1}",
                owner.csrfToken,
                UUID.randomUUID()),
            owner.request(
                "POST",
                transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
                "{\"expectedTransactionVersion\":\"one\"}",
                owner.csrfToken,
                UUID.randomUUID()),
            owner.request(
                "POST",
                transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
                "{\"expectedTransactionVersion\":1}",
                owner.csrfToken,
                null),
            owner.raw(
                "POST",
                transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
                "{\"expectedTransactionVersion\":1}",
                owner.csrfToken,
                "not-a-uuid",
                "application/json"),
            owner.request(
                "POST",
                transactionPath(householdId) + "/" + sourceId + "/categorization-rule?unexpected=x",
                "{\"expectedTransactionVersion\":1}",
                owner.csrfToken,
                UUID.randomUUID()));
    for (Resp response : rejected) {
      assertThat(response.status).isEqualTo(400);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(response.json().path("correlationId").asText()).isNotBlank();
      assertThat(response.cacheControl()).contains("no-store");
      assertThat(response.body).doesNotContain("SQL", "at com.housesync");
    }
    assertThat(rejected.get(1).json().path("fieldErrors").propertyNames())
        .containsExactly("expectedTransactionVersion");
    assertThat(rejected.get(4).json().path("fieldErrors").propertyNames())
        .containsExactly("idempotencyKey");

    Resp staleCreate =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":2}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(staleCreate.status).isEqualTo(409);
    assertThat(staleCreate.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    // List paging bounds are validated before any read.
    assertThat(owner.get(rulesPath(householdId) + "?limit=0").status).isEqualTo(400);
    assertThat(owner.get(rulesPath(householdId) + "?limit=1&limit=2").status).isEqualTo(400);
    assertThat(owner.get(rulesPath(householdId) + "?offset=10001").status).isEqualTo(400);
    assertThat(owner.get(rulesPath(householdId) + "?status=ENABLED").status).isEqualTo(400);

    // The same description cannot learn a second active rule for the same owner.
    Resp duplicateSource =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-4.00", "BRL", "Corner Market"));
    String duplicateId = created(duplicateSource);
    assertThat(
            owner.patchTransaction(
                    householdId, duplicateId, "{\"expectedVersion\":0,\"category\":\"GROCERIES\"}")
                .status)
        .isEqualTo(200);
    Resp conflict =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + duplicateId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(conflict.status).isEqualTo(409);
    assertThat(conflict.json().path("code").asText()).isEqualTo("CATEGORY_RULE_CONFLICT");
    assertThat(conflict.cacheControl()).contains("no-store");
    assertThat(conflict.body).doesNotContain("Corner Market", ruleId.toString());

    // A different description learns an independent rule; the page is ordered updatedAt DESC.
    Resp otherSource =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-6.00", "BRL", "Corner Market II"));
    String otherId = created(otherSource);
    assertThat(
            owner.patchTransaction(
                    householdId, otherId, "{\"expectedVersion\":0,\"category\":\"DINING\"}")
                .status)
        .isEqualTo(200);
    Resp secondRule =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + otherId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(secondRule.status).isEqualTo(201);
    assertThat(secondRule.json().path("matchLabel").asText()).isEqualTo("Corner Market II");
    String secondRuleId = secondRule.json().path("id").asText();

    Resp page = owner.get(rulesPath(householdId));
    assertThat(page.status).isEqualTo(200);
    assertThat(page.cacheControl()).contains("no-store");
    assertThat(page.json().propertyNames()).containsExactly("items", "limit", "offset", "hasMore");
    assertThat(page.json().path("limit").asInt()).isEqualTo(50);
    assertThat(page.json().path("offset").asInt()).isZero();
    assertThat(page.json().path("hasMore").asBoolean()).isFalse();
    assertThat(page.json().path("items").size()).isEqualTo(2);

    Resp firstCorrected =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":0,\"category\":\"DINING\"}",
            owner.csrfToken,
            null);
    assertThat(firstCorrected.status).isEqualTo(200);
    assertThat(firstCorrected.json().path("version").asInt()).isEqualTo(1);
    assertThat(firstCorrected.json().path("category").asText()).isEqualTo("DINING");
    assertThat(firstCorrected.json().path("updatedAt").asText())
        .isNotEqualTo(firstCorrected.json().path("createdAt").asText());
    // The rule item never echoes the request body's category text or the match key.
    assertThat(firstCorrected.body).doesNotContain("corner market");

    // The correction bumps updatedAt, so the corrected rule now sorts first deterministically.
    Resp reordered = owner.get(rulesPath(householdId));
    assertThat(reordered.json().path("items").get(0).path("id").asText())
        .isEqualTo(ruleId.toString());
    assertThat(reordered.json().path("items").get(1).path("id").asText()).isEqualTo(secondRuleId);

    Resp stalePatch =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":0,\"category\":\"DINING\"}",
            owner.csrfToken,
            null);
    assertThat(stalePatch.status).isEqualTo(409);
    assertThat(stalePatch.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    Resp bothFields =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":1,\"category\":\"GROCERIES\",\"status\":\"INACTIVE\"}",
            owner.csrfToken,
            null);
    assertThat(bothFields.status).isEqualTo(400);
    assertThat(bothFields.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    Resp deactivate =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":1,\"status\":\"INACTIVE\"}",
            owner.csrfToken,
            null);
    assertThat(deactivate.status).isEqualTo(200);
    assertThat(deactivate.json().path("status").asText()).isEqualTo("INACTIVE");
    assertThat(deactivate.json().path("version").asInt()).isEqualTo(2);
    assertThat(deactivate.json().path("category").asText()).isEqualTo("DINING");

    Resp repeatDeactivate =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":2,\"status\":\"INACTIVE\"}",
            owner.csrfToken,
            null);
    assertThat(repeatDeactivate.status).isEqualTo(200);
    assertThat(repeatDeactivate.json().path("version").asInt()).isEqualTo(2);

    Resp reactivate =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":2,\"status\":\"ACTIVE\"}",
            owner.csrfToken,
            null);
    assertThat(reactivate.status).isEqualTo(400);
    assertThat(reactivate.json().path("fieldErrors").propertyNames()).containsExactly("status");

    Resp patchInactive =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":2,\"category\":\"GROCERIES\"}",
            owner.csrfToken,
            null);
    assertThat(patchInactive.status).isEqualTo(400);
    assertThat(patchInactive.json().path("fieldErrors").propertyNames())
        .containsExactly("category");

    // Deactivation frees the key: the owner's rule capability is live again and future entries
    // classify with no rule until a new one is learned.
    Resp eligibleAgain = owner.get(categorizationPath);
    assertThat(eligibleAgain.json().path("ruleEligible").asBoolean()).isTrue();

    Resp replayAfterDeactivation =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            key);
    assertThat(replayAfterDeactivation.status).isEqualTo(200);
    assertThat(replayAfterDeactivation.json().path("status").asText()).isEqualTo("INACTIVE");
    assertThat(replayAfterDeactivation.json().path("version").asInt()).isEqualTo(2);

    Resp activeOnly = owner.get(rulesPath(householdId) + "?status=ACTIVE");
    assertThat(activeOnly.json().path("items").size()).isEqualTo(1);
    assertThat(activeOnly.json().path("items").get(0).path("id").asText()).isEqualTo(secondRuleId);
    Resp inactiveOnly = owner.get(rulesPath(householdId) + "?status=INACTIVE");
    assertThat(inactiveOnly.json().path("items").size()).isEqualTo(1);
    assertThat(inactiveOnly.json().path("items").get(0).path("status").asText())
        .isEqualTo("INACTIVE");
    Resp badStatus = owner.get(rulesPath(householdId) + "?status=ENABLED");
    assertThat(badStatus.status).isEqualTo(400);
    assertThat(badStatus.json().path("fieldErrors").propertyNames()).containsExactly("status");
  }

  @Test
  void rulesArePrivateToTheirFinancialOwner() throws Exception {
    Agent owner = signedInAgent("rule-privacy");
    String householdId = createHousehold(owner, "Rule privacy home");
    Agent member = signedInAgent("rule-privacy-member");
    addMember(householdId, member.userId(), "MEMBER");
    // A second household OWNER proves a household role confers no rule access.
    Agent householdOwner = signedInAgent("rule-privacy-owner");
    addMember(householdId, householdOwner.userId(), "OWNER");
    Agent outsider = signedInAgent("rule-privacy-outsider");
    String accountId = createAccount(owner, householdId, UUID.randomUUID(), "Card", "CASH", "BRL");

    Resp source =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-20.00", "BRL", "Corner Market"));
    String sourceId = created(source);
    assertThat(
            owner.patchTransaction(
                    householdId, sourceId, "{\"expectedVersion\":0,\"category\":\"GROCERIES\"}")
                .status)
        .isEqualTo(200);
    Resp rule =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(rule.status).isEqualTo(201);
    String ruleId = rule.json().path("id").asText();

    // A member sees only an empty private page and generic 404s; the member's own household role
    // and the household OWNER role both confer nothing.
    Resp memberList = member.get(rulesPath(householdId));
    assertThat(memberList.status).isEqualTo(200);
    assertThat(memberList.json().propertyNames())
        .containsExactly("items", "limit", "offset", "hasMore");
    assertThat(memberList.json().path("items").size()).isZero();
    assertThat(memberList.body).doesNotContain("Corner Market", ruleId);
    assertThat(householdOwner.get(rulesPath(householdId)).json().path("items").size()).isZero();
    assertThat(member.get(transactionPath(householdId) + "/" + sourceId + "/categorization").status)
        .isEqualTo(404);
    assertThat(
            householdOwner.get(transactionPath(householdId) + "/" + sourceId + "/categorization")
                .status)
        .isEqualTo(404);
    Resp memberCreate =
        member.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            member.csrfToken,
            UUID.randomUUID());
    assertThat(memberCreate.status).isEqualTo(404);
    assertThat(memberCreate.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
    Resp memberPatch =
        member.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":0,\"status\":\"INACTIVE\"}",
            member.csrfToken,
            null);
    assertThat(memberPatch.status).isEqualTo(404);
    assertThat(memberPatch.json().path("code").asText()).isEqualTo("CATEGORY_RULE_NOT_FOUND");
    assertThat(
            householdOwner.request(
                    "PATCH",
                    rulesPath(householdId) + "/" + ruleId,
                    "{\"expectedVersion\":0,\"status\":\"INACTIVE\"}",
                    householdOwner.csrfToken,
                    null)
                .status)
        .isEqualTo(404);

    // An outsider (never a member) receives the generic household 404 on every route.
    assertThat(outsider.get(rulesPath(householdId)).status).isEqualTo(404);
    assertThat(outsider.get(rulesPath(householdId)).json().path("code").asText())
        .isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp outsiderCreate =
        outsider.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            outsider.csrfToken,
            UUID.randomUUID());
    assertThat(outsiderCreate.status).isEqualTo(404);
    assertThat(outsiderCreate.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(
            outsider.request(
                    "PATCH",
                    rulesPath(householdId) + "/" + ruleId,
                    "{\"expectedVersion\":0,\"status\":\"INACTIVE\"}",
                    outsider.csrfToken,
                    null)
                .status)
        .isEqualTo(404);

    // The same description learns an independent rule for another owner in the same household.
    String memberAccountId =
        createAccount(member, householdId, UUID.randomUUID(), "Member Card", "CASH", "BRL");
    Resp memberSource =
        member.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(memberAccountId, "EXPENSE", "-9.00", "BRL", "Corner Market"));
    String memberSourceId = created(memberSource);
    assertThat(
            member.patchTransaction(
                    householdId, memberSourceId, "{\"expectedVersion\":0,\"category\":\"DINING\"}")
                .status)
        .isEqualTo(200);
    Resp memberRule =
        member.request(
            "POST",
            transactionPath(householdId) + "/" + memberSourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            member.csrfToken,
            UUID.randomUUID());
    assertThat(memberRule.status).isEqualTo(201);
    assertThat(memberRule.json().path("matchType").asText()).isEqualTo("NORMALIZED_TEXT");
    // The owner's page still shows only the owner's rule.
    assertThat(owner.get(rulesPath(householdId)).json().path("items").size()).isEqualTo(1);
    assertThat(owner.get(rulesPath(householdId)).json().path("items").get(0).path("id").asText())
        .isEqualTo(ruleId);
    assertThat(member.get(rulesPath(householdId)).json().path("items").size()).isEqualTo(1);

    // Anonymous and CSRF contracts apply to the new routes too.
    Agent anonymous = new Agent();
    Resp anonymousList = anonymous.get(rulesPath(householdId));
    assertThat(anonymousList.status).isEqualTo(401);
    assertThat(anonymousList.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");
    // Signed-in requests without the CSRF header keep the existing 403 contract.
    Resp missingCsrf =
        member.request(
            "POST",
            transactionPath(householdId) + "/" + sourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            null,
            UUID.randomUUID());
    assertThat(missingCsrf.status).isEqualTo(403);
    assertThat(missingCsrf.json().path("code").asText()).isEqualTo("CSRF_INVALID");
  }

  @Test
  void classificationAppliesExactOwnerRulesFutureOnly() throws Exception {
    Agent owner = signedInAgent("rule-classify");
    String householdId = createHousehold(owner, "Rule classify home");
    Agent member = signedInAgent("rule-classify-member");
    addMember(householdId, member.userId(), "MEMBER");
    String accountId = createAccount(owner, householdId, UUID.randomUUID(), "Card", "CASH", "BRL");

    // A pre-rule entry stays NONE even after a later rule is learned elsewhere.
    Resp preRule =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-3.00", "BRL", "Corner Market"));
    String preRuleId = created(preRule);
    assertThat(preRule.json().path("category").isNull()).isTrue();
    assertThat(preRule.json().path("version").asInt()).isZero();

    Resp ruleSource =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-20.00", "BRL", "Corner Market"));
    String ruleSourceId = created(ruleSource);
    assertThat(
            owner.patchTransaction(
                    householdId, ruleSourceId, "{\"expectedVersion\":0,\"category\":\"GROCERIES\"}")
                .status)
        .isEqualTo(200);
    Resp rule =
        owner.request(
            "POST",
            transactionPath(householdId) + "/" + ruleSourceId + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(rule.status).isEqualTo(201);

    Resp preRuleProvenance =
        owner.get(transactionPath(householdId) + "/" + preRuleId + "/categorization");
    assertThat(preRuleProvenance.json().path("origin").asText()).isEqualTo("NONE");
    assertThat(preRuleProvenance.json().path("category").isNull()).isTrue();
    assertThat(preRuleProvenance.json().path("ruleEligible").asBoolean()).isFalse();
    // No retroactive assignment: the pre-rule row's category and version are untouched.
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                preRuleId))
        .isNull();
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                preRuleId))
        .isZero();

    // A future omitted-category entry matches exactly under the documented normalizer.
    Resp matched =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-12.00", "BRL", "corner  MARKET "));
    String matchedId = created(matched);
    assertThat(matched.json().path("category").asText()).isEqualTo("GROCERIES");
    assertThat(matched.json().path("version").asInt()).isZero();
    assertThat(matched.json().propertyNames().size()).isEqualTo(16);
    Resp matchedProvenance =
        owner.get(transactionPath(householdId) + "/" + matchedId + "/categorization");
    assertThat(matchedProvenance.json().path("origin").asText()).isEqualTo("OWNER_RULE");
    assertThat(matchedProvenance.json().path("category").asText()).isEqualTo("GROCERIES");
    assertThat(matchedProvenance.json().path("ruleEligible").asBoolean()).isFalse();
    assertThat(
            jdbc.queryForObject(
                "SELECT category_rule_id IS NOT NULL FROM financial_transactions WHERE id = ?::uuid",
                Boolean.class,
                matchedId))
        .isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT categorization_ruleset_version FROM financial_transactions"
                    + " WHERE id = ?::uuid",
                String.class,
                matchedId))
        .isEqualTo("OWNER_RULE_V1");

    // An explicit category beats the exact rule and records USER.
    Resp explicit =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + accountId
                + "\",\"kind\":\"EXPENSE\",\"money\":{\"amount\":\"-8.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Corner Market\","
                + "\"category\":\"DINING\"}");
    assertThat(explicit.json().path("category").asText()).isEqualTo("DINING");
    Resp explicitProvenance =
        owner.get(transactionPath(householdId) + "/" + created(explicit) + "/categorization");
    assertThat(explicitProvenance.json().path("origin").asText()).isEqualTo("USER");

    // Different text never matches: no similarity, no substring.
    Resp unmatched =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-1.50", "BRL", "Corner Market II"));
    String unmatchedId = created(unmatched);
    assertThat(unmatched.json().path("category").isNull()).isTrue();
    Resp unmatchedProvenance =
        owner.get(transactionPath(householdId) + "/" + unmatchedId + "/categorization");
    assertThat(unmatchedProvenance.json().path("origin").asText()).isEqualTo("NONE");

    // Refunds inherit and never classify by rule.
    Resp refund =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(accountId, matchedId, "2.00", "2026-09-17", "Partial refund"));
    assertThat(refund.json().path("category").asText()).isEqualTo("GROCERIES");
    assertThat(
            owner
                .get(transactionPath(householdId) + "/" + created(refund) + "/categorization")
                .json()
                .path("origin")
                .asText())
        .isEqualTo("INHERITED");

    // Another owner's entry with the same description gets nothing: rules are owner-scoped.
    String memberAccountId =
        createAccount(member, householdId, UUID.randomUUID(), "Member Card", "CASH", "BRL");
    Resp memberEntry =
        member.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(memberAccountId, "EXPENSE", "-5.00", "BRL", "Corner Market"));
    assertThat(memberEntry.json().path("category").isNull()).isTrue();
    assertThat(
            owner.get(transactionPath(householdId) + "/" + created(memberEntry) + "/categorization")
                .status)
        .isEqualTo(404);

    // Deactivation stops future matching without rewriting past assignments.
    String ruleId =
        jdbc.queryForObject(
            "SELECT id FROM categorization_rules WHERE household_id = ?::uuid LIMIT 1",
            String.class,
            householdId);
    Resp deactivate =
        owner.request(
            "PATCH",
            rulesPath(householdId) + "/" + ruleId,
            "{\"expectedVersion\":0,\"status\":\"INACTIVE\"}",
            owner.csrfToken,
            null);
    assertThat(deactivate.status).isEqualTo(200);
    Resp afterDeactivation =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(accountId, "EXPENSE", "-7.00", "BRL", "Corner Market"));
    assertThat(afterDeactivation.json().path("category").isNull()).isTrue();
    // The matched row keeps its effective category and OWNER_RULE provenance.
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                matchedId))
        .isEqualTo("GROCERIES");
  }

  /** Exact signed entry body; money is a string and defaults stay implicit. */
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

  /** Refund-shaped entry body referencing a source expense in the same account. */
  private static String refundEntry(
      String accountId, String sourceId, String amount, String date, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\"BRL\"},"
        + "\"occurredOn\":\""
        + date
        + "\",\"description\":\""
        + description
        + "\",\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  private static String created(Resp response) throws Exception {
    assertThat(response.status).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String transactionPath(String householdId) {
    return "/api/households/" + householdId + "/transactions";
  }

  private static String rulesPath(String householdId) {
    return "/api/households/" + householdId + "/categorization-rules";
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

  private String createAccount(
      Agent agent, String householdId, UUID key, String name, String kind, String currency)
      throws Exception {
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
            key);
    assertThat(response.status).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String identityJson(String email) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
  }

  record Resp(int status, String body, java.net.http.HttpHeaders headers) {
    JsonNode json() throws Exception {
      return mapper.readTree(body);
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
      return raw(
          method,
          path,
          json,
          csrf,
          idempotencyKey == null ? null : idempotencyKey.toString(),
          json == null ? null : "application/json");
    }

    /** Raw variant for malformed idempotency keys the typed form cannot send. */
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
