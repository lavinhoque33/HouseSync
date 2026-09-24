package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.connection.application.ConnectionSyncDemandRegistrar;
import com.housesync.finance.connection.application.ConnectionSyncService;
import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.function.Predicate;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;

/**
 * Owner-rule connected-finance flow against real PostgreSQL: the owner-only ruleEligible capability
 * on admitted entries, provider-merchant rules learned from retained observation evidence, exact
 * owner-rule precedence over the reviewed provider mapping, text-keyed rules for connected entries
 * without a stable merchant identity, owner-scoped isolation for a household member, and
 * replace-ledger replacement classification with no retroactive ledger change.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      "app.auth.ip-max-attempts=1000",
      "app.connected-finance.enabled=true",
      "app.connected-finance.provider=fake",
      "app.connected-finance.fake-allowed=true",
      "app.connected-finance.encryption-keys=test-key-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      "app.connected-finance.revocation-poll-ms=3600000",
      "app.connected-finance.attempt-cleanup-ms=3600000",
      "app.connected-finance.sync-poll-ms=3600000",
      "app.connected-finance.sync-sweep-ms=3600000",
      "app.connected-finance.sync-scrub-ms=3600000"
    })
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class ConnectedFinanceCategorizationRuleIT extends ConnectedFinanceITSupport {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @DynamicPropertySource
  static void databaseProperties(DynamicPropertyRegistry registry) {
    registerContainerProperties(registry, POSTGRES);
  }

  @Autowired private FakePlaidAdapter fake;
  @Autowired private ConnectionSyncService syncService;
  @Autowired private ConnectionSyncDemandRegistrar demandRegistrar;
  @Autowired private JdbcTemplate jdbc;
  @Autowired private PlatformTransactionManager transactionManager;

  @Test
  void providerMerchantRuleBeatsProviderMappingAndStaysOwnerScoped() throws Exception {
    Agent owner = signedInAgent("rule-merchant");
    String householdId = createHousehold(owner, "Merchant rule home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(
            categorizedTransaction(
                link,
                "tx-merchant-1",
                "12.34",
                "2026-09-12",
                "Store purchase",
                "merchant-entity-1",
                "GENERAL_MERCHANDISE",
                null)));
    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String observationId =
        findItem(inbox, item -> "POSTED".equals(item.path("state").asText())).path("id").asText();
    Resp confirmed =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + observationId + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"EXPENSE\",\"description\":\"Store purchase\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(confirmed.status()).isEqualTo(201);
    String transactionId = confirmed.json().path("transactionId").asText();
    // No rule yet: the reviewed provider mapping applies.
    assertThat(category(transactionId)).isEqualTo("SHOPPING");
    assertThat(origin(transactionId)).isEqualTo("PROVIDER");

    String categorizationPath =
        "/api/households/" + householdId + "/transactions/" + transactionId + "/categorization";
    Resp provenance = owner.get(categorizationPath);
    assertThat(provenance.json().propertyNames())
        .containsExactly(
            "transactionId",
            "transactionVersion",
            "category",
            "origin",
            "assignedAt",
            "reviewState",
            "ruleEligible");
    // A PROVIDER assignment is automated evidence, not an explicit user decision to learn from.
    assertThat(provenance.json().path("ruleEligible").asBoolean()).isFalse();

    Resp corrected =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/transactions/" + transactionId,
            "{\"expectedVersion\":0,\"category\":\"DINING\"}",
            owner.csrfToken,
            null);
    assertThat(corrected.status()).isEqualTo(200);
    Resp eligible = owner.get(categorizationPath);
    assertThat(eligible.json().path("origin").asText()).isEqualTo("USER");
    assertThat(eligible.json().path("ruleEligible").asBoolean()).isTrue();

    Resp rule =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/transactions/"
                + transactionId
                + "/categorization-rule",
            "{\"expectedTransactionVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(rule.status()).isEqualTo(201);
    assertThat(rule.json().path("matchType").asText()).isEqualTo("PROVIDER_MERCHANT");
    assertThat(rule.json().path("matchLabel").asText()).isEqualTo("Store purchase");
    assertThat(rule.json().path("category").asText()).isEqualTo("DINING");
    assertThat(rule.json().path("version").asInt()).isZero();
    // The raw provider identity and the scope-bound digest never reach a browser response.
    assertThat(rule.body()).doesNotContain("merchant-entity", "digest", "providerIdentity");
    assertThat(owner.get(categorizationPath).json().path("ruleEligible").asBoolean()).isFalse();

    // A future connected entry with the same stable merchant identity beats the provider mapping.
    importPage(
        owner,
        householdId,
        link,
        List.of(
            categorizedTransaction(
                link,
                "tx-merchant-2",
                "9.99",
                "2026-09-13",
                "Store purchase",
                "merchant-entity-1",
                "FOOD_AND_DRINK",
                "FOOD_AND_DRINK_GROCERIES")));
    JsonNode nextInbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String nextObservationId =
        findItem(nextInbox, item -> "POSTED".equals(item.path("state").asText()))
            .path("id")
            .asText();
    Resp nextConfirmed =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + nextObservationId + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"EXPENSE\",\"description\":\"Store purchase\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(nextConfirmed.status()).isEqualTo(201);
    String matchedId = nextConfirmed.json().path("transactionId").asText();
    // The owner rule wins over the GROCERIES provider mapping for the same entry.
    assertThat(category(matchedId)).isEqualTo("DINING");
    assertThat(origin(matchedId)).isEqualTo("OWNER_RULE");
    assertThat(
            jdbc.queryForObject(
                "SELECT categorization_ruleset_version FROM financial_transactions"
                    + " WHERE id = ?::uuid",
                String.class,
                matchedId))
        .isEqualTo("OWNER_RULE_V1");
    assertThat(ruleApplied(matchedId)).isTrue();

    // A different stable merchant identity never matches: exact matching only.
    importPage(
        owner,
        householdId,
        link,
        List.of(
            categorizedTransaction(
                link,
                "tx-merchant-3",
                "4.50",
                "2026-09-14",
                "Store purchase",
                "merchant-entity-2",
                "GENERAL_MERCHANDISE",
                null)));
    JsonNode thirdInbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String thirdObservationId =
        findItem(thirdInbox, item -> "POSTED".equals(item.path("state").asText()))
            .path("id")
            .asText();
    Resp thirdConfirmed =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + thirdObservationId + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"EXPENSE\",\"description\":\"Store purchase\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(thirdConfirmed.status()).isEqualTo(201);
    assertThat(origin(thirdConfirmed.json().path("transactionId").asText())).isEqualTo("PROVIDER");

    // A household member's identical manual entry gets nothing: rules are financial-owner scoped.
    Agent member = signedInAgent("rule-merchant-member");
    addMember(householdId, member.userId(), "MEMBER");
    String memberAccountId =
        createAccount(member, householdId, UUID.randomUUID(), "Member Card", "CASH", "USD");
    Resp memberEntry =
        member.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            "{\"accountId\":\""
                + memberAccountId
                + "\",\"kind\":\"EXPENSE\",\"money\":{\"amount\":\"-3.00\",\"currency\":\"USD\"},"
                + "\"occurredOn\":\"2026-09-15\",\"description\":\"Store purchase\"}",
            member.csrfToken,
            UUID.randomUUID());
    assertThat(memberEntry.status()).isEqualTo(201);
    assertThat(memberEntry.json().path("category").isNull()).isTrue();
    String memberEntryId = memberEntry.json().path("id").asText();
    assertThat(
            owner.get("/api/households/" + householdId + "/transactions/" + memberEntryId).status())
        .isEqualTo(404);

    // Each owner sees exactly their own private page: the member's list is empty, the owner's
    // page holds the one learned merchant rule.
    Resp memberRules = member.get("/api/households/" + householdId + "/categorization-rules");
    assertThat(memberRules.status()).isEqualTo(200);
    assertThat(memberRules.json().path("items").size()).isZero();
    assertThat(memberRules.body()).doesNotContain("Store purchase");
    JsonNode ownerRules =
        owner.get("/api/households/" + householdId + "/categorization-rules").json();
    assertThat(ownerRules.path("items").size()).isEqualTo(1);
    assertThat(ownerRules.path("items").get(0).path("matchType").asText())
        .isEqualTo("PROVIDER_MERCHANT");
  }

  @Test
  void textRuleClassifiesConnectedAdmissionAndReplaceLedger() throws Exception {
    Agent owner = signedInAgent("rule-text");
    String householdId = createHousehold(owner, "Text rule home");
    String manualAccountId =
        createAccount(owner, householdId, UUID.randomUUID(), "Manual Card", "CHECKING", "USD");
    Resp manualSource =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            "{\"accountId\":\""
                + manualAccountId
                + "\",\"kind\":\"EXPENSE\",\"money\":{\"amount\":\"-20.00\",\"currency\":\"USD\"},"
                + "\"occurredOn\":\"2026-09-01\",\"description\":\"Corner Market\","
                + "\"category\":\"GROCERIES\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(manualSource.status()).isEqualTo(201);
    Resp rule =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/transactions/"
                + manualSource.json().path("id").asText()
                + "/categorization-rule",
            "{\"expectedTransactionVersion\":0}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(rule.status()).isEqualTo(201);
    assertThat(rule.json().path("matchType").asText()).isEqualTo("NORMALIZED_TEXT");

    ConnectedLink link = linkAndSelect(owner, householdId, true, false);
    // A connected entry without a stable merchant identity keys on the retained description.
    importPage(
        owner,
        householdId,
        link,
        List.of(
            categorizedTransaction(
                link, "tx-text-1", "12.34", "2026-09-12", "Corner Market", null, null, null)));
    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String observationId =
        findItem(inbox, item -> "POSTED".equals(item.path("state").asText())).path("id").asText();
    Resp confirmed =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + observationId + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"EXPENSE\",\"description\":\"Corner Market\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(confirmed.status()).isEqualTo(201);
    String ledgerId = confirmed.json().path("transactionId").asText();
    assertThat(category(ledgerId)).isEqualTo("GROCERIES");
    assertThat(origin(ledgerId)).isEqualTo("OWNER_RULE");
    assertThat(
            owner
                .get(
                    "/api/households/"
                        + householdId
                        + "/transactions/"
                        + ledgerId
                        + "/categorization")
                .json()
                .path("ruleEligible")
                .asBoolean())
        .isFalse();

    // A material bank revision needs a separately reviewed replacement; the replacement admits
    // with the owner's corrected values and classifies future-only from the exact rule.
    importPage(
        owner,
        householdId,
        link,
        List.of(
            categorizedTransaction(
                link, "tx-text-1", "45.67", "2026-09-12", "Corner Market", null, null, null)));
    JsonNode modified = observationJson(owner, householdId, observationId);
    assertThat(modified.path("reviewState").asText()).isEqualTo("CONFIRMED");
    assertThat(modified.path("changeState").asText()).isEqualTo("MODIFIED");

    Resp replaced =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + observationId
                + "/replace-ledger",
            "{\"expectedVersion\":"
                + modified.path("version").asInt()
                + ",\"expectedLedgerVersion\":0,\"kind\":\"EXPENSE\","
                + "\"description\":\"Corner Market\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(replaced.status()).isEqualTo(201);
    String replacementId = replaced.json().path("transaction").path("id").asText();
    assertThat(category(replacementId)).isEqualTo("GROCERIES");
    assertThat(origin(replacementId)).isEqualTo("OWNER_RULE");
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                replacementId))
        .isZero();
    // No retroactive ledger change: the voided entry keeps its effective category and amount.
    assertThat(
            jdbc.queryForObject(
                "SELECT status FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                ledgerId))
        .isEqualTo("VOIDED");
    assertThat(category(ledgerId)).isEqualTo("GROCERIES");
    assertThat(
            jdbc.queryForObject(
                "SELECT amount FROM financial_transactions WHERE id = ?::uuid",
                BigDecimal.class,
                ledgerId))
        .isEqualByComparingTo("-12.34");
  }

  private String category(String transactionId) {
    return jdbc.queryForObject(
        "SELECT category FROM financial_transactions WHERE id = ?::uuid",
        String.class,
        transactionId);
  }

  private String origin(String transactionId) {
    return jdbc.queryForObject(
        "SELECT category_origin FROM financial_transactions WHERE id = ?::uuid",
        String.class,
        transactionId);
  }

  private Boolean ruleApplied(String transactionId) {
    return jdbc.queryForObject(
        "SELECT category_rule_id IS NOT NULL FROM financial_transactions WHERE id = ?::uuid",
        Boolean.class,
        transactionId);
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
    assertThat(response.status()).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private void importPage(
      Agent owner,
      String householdId,
      ConnectedLink link,
      List<PlaidAdapter.ProviderTransaction> upserts)
      throws Exception {
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(upserts, List.of(), "cursor-" + UUID.randomUUID(), false, true));
    demandAndProcess(link);
  }

  /** Registers demand directly (bypassing the manual interval) and runs one worker sweep. */
  private void demandAndProcess(ConnectedLink link) {
    new TransactionTemplate(transactionManager)
        .execute(
            status -> {
              demandRegistrar.demand(UUID.fromString(link.connectionId()), Instant.now());
              return null;
            });
    syncService.processDueSyncs();
  }

  private JsonNode observationJson(Agent owner, String householdId, String observationId)
      throws Exception {
    Resp response = owner.get("/api/households/" + householdId + "/bank-activity/" + observationId);
    assertThat(response.status()).isEqualTo(200);
    return response.json();
  }

  private static PlaidAdapter.ProviderTransaction categorizedTransaction(
      ConnectedLink link,
      String transactionId,
      String amount,
      String date,
      String description,
      String merchantIdentity,
      String pfcPrimary,
      String pfcDetail) {
    return new PlaidAdapter.ProviderTransaction(
        link.remoteCheckingId(),
        transactionId,
        null,
        false,
        "USD",
        null,
        new BigDecimal(amount),
        LocalDate.parse(date),
        null,
        description,
        description,
        merchantIdentity,
        description,
        pfcPrimary,
        pfcDetail);
  }

  private static JsonNode findItem(JsonNode page, Predicate<JsonNode> match) {
    for (JsonNode item : page.path("items")) {
      if (match.test(item)) {
        return item;
      }
    }
    throw new AssertionError("no matching bank activity item");
  }
}
