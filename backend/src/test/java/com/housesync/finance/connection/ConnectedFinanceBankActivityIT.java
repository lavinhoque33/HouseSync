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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
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
 * Owner-private inbox decisions: dismissal and material-revision reopening, idempotent
 * confirmation replay, modified/removed admitted labeling with an untouched ledger, confirmation
 * field strictness, and CONNECTED refund constraints with shared disclosure.
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
class ConnectedFinanceBankActivityIT extends ConnectedFinanceITSupport {

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
  @Autowired private PlatformTransactionManager transactionManager;

  @AfterEach
  void resetFake() {
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    fake.setSyncGate(null);
  }

  @Test
  void dismissalAppliesToPendingAndReopensOnlyOnMaterialRevision() throws Exception {
    Agent owner = signedInAgent("activity-dismiss");
    String householdId = createHousehold(owner, "Dismiss home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-dismiss-pending", true, "5.00", "2026-09-10", "Pending item"),
            transaction(link, "tx-dismiss-posted", false, "7.25", "2026-09-11", "Posted item")));

    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    JsonNode pending = findItem(inbox, item -> "PENDING".equals(item.path("state").asText()));
    JsonNode posted = findItem(inbox, item -> "POSTED".equals(item.path("state").asText()));

    Resp pendingDismiss =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + pending.path("id").asText()
                + "/dismiss",
            "{\"expectedVersion\":0,\"reason\":\"NOT_NEEDED\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(pendingDismiss.status()).isEqualTo(200);
    assertThat(pendingDismiss.json().path("activity").path("reviewState").asText())
        .isEqualTo("DISMISSED");
    assertThat(pendingDismiss.json().path("transactionId").isNull()).isTrue();

    Resp confirmDismissed =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + pending.path("id").asText()
                + "/confirm",
            "{\"expectedVersion\":1,\"kind\":\"EXPENSE\",\"description\":\"Pending item\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(confirmDismissed.status()).isEqualTo(409);
    assertThat(confirmDismissed.json().path("code").asText()).isEqualTo("OBSERVATION_DISMISSED");

    Resp postedDismiss =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + posted.path("id").asText()
                + "/dismiss",
            "{\"expectedVersion\":0,\"reason\":\"ALREADY_RECORDED\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(postedDismiss.status()).isEqualTo(200);
    assertThat(postedDismiss.json().path("activity").path("reviewState").asText())
        .isEqualTo("DISMISSED");

    // Cosmetic-only revision (description) keeps the dismissal.
    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-dismiss-posted", false, "7.25", "2026-09-11", "Renamed item")));
    JsonNode stillDismissed = observationJson(owner, householdId, posted.path("id").asText());
    assertThat(stillDismissed.path("reviewState").asText()).isEqualTo("DISMISSED");

    // A material money revision reopens the item once.
    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-dismiss-posted", false, "9.99", "2026-09-11", "Renamed item")));
    JsonNode reopened = observationJson(owner, householdId, posted.path("id").asText());
    assertThat(reopened.path("reviewState").asText()).isEqualTo("UNREVIEWED");
    assertThat(reopened.path("money").path("amount").asText()).isEqualTo("-9.99");
    assertThat(reopened.path("version").asInt()).isEqualTo(2);

    Resp confirmed =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + posted.path("id").asText()
                + "/confirm",
            "{\"expectedVersion\":2,\"kind\":\"EXPENSE\",\"description\":\"Renamed item\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(confirmed.status()).isEqualTo(201);

    // Replaying the same key returns the persisted outcome without a second ledger entry.
    Resp replay =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + posted.path("id").asText()
                + "/confirm",
            "{\"expectedVersion\":2,\"kind\":\"EXPENSE\",\"description\":\"Renamed item\"}",
            owner.csrfToken,
            UUID.fromString(
                jdbc.queryForObject(
                    "SELECT idempotency_key FROM connection_operation_idempotency_keys"
                        + " WHERE operation = 'BANK_ACTIVITY_CONFIRM' AND resource_id = ?::uuid",
                    String.class,
                    confirmed.json().path("transactionId").asText())));
    assertThat(replay.status()).isEqualTo(200);
    assertThat(replay.json().path("transactionId").asText())
        .isEqualTo(confirmed.json().path("transactionId").asText());
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid"
                    + " AND source = 'CONNECTED'",
                Integer.class,
                householdId))
        .isEqualTo(1);

    // Client-supplied derived facts are rejected as unknown fields.
    Resp strict =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + posted.path("id").asText()
                + "/confirm",
            "{\"expectedVersion\":2,\"kind\":\"EXPENSE\",\"description\":\"X\","
                + "\"accountId\":\""
                + link.checkingAccountId()
                + "\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(strict.status()).isEqualTo(400);
  }

  @Test
  void modifiedAndRemovedAdmittedObservationsAreLabeledWithoutLedgerChanges() throws Exception {
    Agent owner = signedInAgent("activity-review");
    String householdId = createHousehold(owner, "Review home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-review-1", false, "12.34", "2026-09-10", "Original")));

    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    JsonNode posted = findItem(inbox, item -> "POSTED".equals(item.path("state").asText()));
    String observationId = posted.path("id").asText();
    Resp confirmed =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + observationId + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"EXPENSE\",\"description\":\"Original\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(confirmed.status()).isEqualTo(201);
    String transactionId = confirmed.json().path("transactionId").asText();

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-review-1", false, "45.67", "2026-09-10", "Corrected")));
    JsonNode modified = observationJson(owner, householdId, observationId);
    assertThat(modified.path("reviewState").asText()).isEqualTo("CONFIRMED");
    assertThat(modified.path("changeState").asText()).isEqualTo("MODIFIED");
    assertThat(
            jdbc.queryForObject(
                "SELECT amount FROM financial_transactions WHERE id = ?::uuid",
                BigDecimal.class,
                transactionId))
        .isEqualByComparingTo("-12.34");
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                transactionId))
        .isZero();

    // Provider removal of an admitted entry is labeled and never silently voids or deletes it.
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(), List.of("tx-review-1"), "cursor-review-removed", false, true));
    demandAndProcess(link);
    JsonNode removed = observationJson(owner, householdId, observationId);
    assertThat(removed.path("state").asText()).isEqualTo("REMOVED");
    assertThat(removed.path("changeState").asText()).isEqualTo("REMOVED");
    assertThat(removed.path("ledgerTransactionId").asText()).isEqualTo(transactionId);
    assertThat(
            jdbc.queryForObject(
                "SELECT status FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                transactionId))
        .isEqualTo("POSTED");

    // An unknown removal leaves a tombstone that replay cannot resurrect.
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(), List.of("tx-never-seen"), "cursor-review-tombstone", false, true));
    demandAndProcess(link);
    assertThat(
            jdbc.queryForObject(
                "SELECT tombstone FROM connection_observations"
                    + " WHERE connection_id = ?::uuid AND state = 'REMOVED'"
                    + " AND provider_description IS NULL",
                Boolean.class,
                link.connectionId()))
        .isTrue();
  }

  @Test
  void connectedRefundRulesAndSharedDisclosure() throws Exception {
    Agent owner = signedInAgent("activity-refund");
    String householdId = createHousehold(owner, "Refund home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, true);

    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-expense-1", false, "12.34", "2026-09-10", "Bank expense"),
            transaction(link, "tx-credit-big", false, "-20.00", "2026-09-11", "Bank credit big"),
            transaction(link, "tx-credit-1", false, "-5.00", "2026-09-11", "Bank credit")));

    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String expenseObservation =
        findItem(
                inbox,
                item ->
                    "POSTED".equals(item.path("state").asText())
                        && "-12.34".equals(item.path("money").path("amount").asText()))
            .path("id")
            .asText();
    String bigCreditObservation =
        findItem(
                inbox,
                item ->
                    "POSTED".equals(item.path("state").asText())
                        && "20.00".equals(item.path("money").path("amount").asText()))
            .path("id")
            .asText();
    String creditObservation =
        findItem(
                inbox,
                item ->
                    "POSTED".equals(item.path("state").asText())
                        && "5.00".equals(item.path("money").path("amount").asText()))
            .path("id")
            .asText();

    Resp expenseConfirm =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + expenseObservation + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"EXPENSE\",\"description\":\"Bank expense\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(expenseConfirm.status()).isEqualTo(201);
    String expenseId = expenseConfirm.json().path("transactionId").asText();

    // A refund without a source, against a manual expense, or in another account all conflict.
    Resp missingSource =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + creditObservation + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"REFUND\",\"description\":\"Bank credit\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(missingSource.status()).isEqualTo(400);

    Resp manualAccountCreate =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/financial-accounts",
            "{\"name\":\"Manual\",\"kind\":\"CHECKING\",\"currency\":\"USD\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(manualAccountCreate.status()).isEqualTo(201);
    String manualAccountId = manualAccountCreate.json().path("id").asText();
    Resp manualExpense =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            "{\"accountId\":\""
                + manualAccountId
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":\"-5.00\",\"currency\":\"USD\"},"
                + "\"occurredOn\":\"2026-09-01\",\"description\":\"Manual expense\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(manualExpense.status()).as(manualExpense.body()).isEqualTo(201);
    Resp manualSource =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + creditObservation + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"REFUND\",\"description\":\"Bank credit\","
                + "\"refundOfTransactionId\":\""
                + manualExpense.json().path("id").asText()
                + "\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(manualSource.status()).isEqualTo(409);
    assertThat(manualSource.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");

    Resp capExceeded =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + bigCreditObservation
                + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"REFUND\",\"description\":\"Bank credit big\","
                + "\"refundOfTransactionId\":\""
                + expenseId
                + "\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(capExceeded.status()).isEqualTo(409);
    assertThat(capExceeded.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");

    // Sharing the expense requires an explicit disclosure acknowledgement for the refund.
    Resp shared =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/transactions/" + expenseId,
            "{\"expectedVersion\":0,\"visibility\":\"HOUSEHOLD\"}",
            owner.csrfToken,
            null);
    assertThat(shared.status()).isEqualTo(200);

    Resp undisclosed =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + creditObservation + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"REFUND\",\"description\":\"Bank credit\","
                + "\"refundOfTransactionId\":\""
                + expenseId
                + "\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(undisclosed.status()).isEqualTo(400);
    assertThat(undisclosed.json().path("fieldErrors").has("acknowledgeDisclosure")).isTrue();

    Resp refund =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + creditObservation + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"REFUND\",\"description\":\"Bank credit\","
                + "\"refundOfTransactionId\":\""
                + expenseId
                + "\",\"acknowledgeDisclosure\":true}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(refund.status()).isEqualTo(201);
    assertThat(
            jdbc.queryForObject(
                "SELECT visibility FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                refund.json().path("transactionId").asText()))
        .isEqualTo("HOUSEHOLD");
    assertThat(
            jdbc.queryForObject(
                    "SELECT refund_of_transaction_id FROM financial_transactions WHERE id = ?::uuid",
                    UUID.class,
                    refund.json().path("transactionId").asText())
                .toString())
        .isEqualTo(expenseId);
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

  private static PlaidAdapter.ProviderTransaction transaction(
      ConnectedLink link,
      String transactionId,
      boolean pending,
      String amount,
      String date,
      String description) {
    return new PlaidAdapter.ProviderTransaction(
        link.remoteCheckingId(),
        transactionId,
        null,
        pending,
        "USD",
        null,
        new BigDecimal(amount),
        LocalDate.parse(date),
        null,
        description,
        null);
  }

  private static JsonNode findItem(JsonNode page, java.util.function.Predicate<JsonNode> match) {
    for (JsonNode item : page.path("items")) {
      if (match.test(item)) {
        return item;
      }
    }
    throw new AssertionError("no matching bank activity item");
  }
}
