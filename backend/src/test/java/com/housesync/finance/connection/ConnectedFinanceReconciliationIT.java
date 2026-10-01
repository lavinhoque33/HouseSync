package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.connection.application.ConnectionLifecycleService;
import com.housesync.finance.connection.application.ConnectionSyncDemandRegistrar;
import com.housesync.finance.connection.application.ConnectionSyncService;
import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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
 * Reconciliation and recovery on real PostgreSQL: modified-admitted coalescing with an untouched
 * ledger, removed-admitted review without auto-void, KEEP/APPLY/VOID resolution, atomic
 * replace-ledger with retained history, allocation/refund guards, stale-version no-partial-write,
 * idempotent replay, post-disconnect and suspended review, LINKING refusal, former-member privacy,
 * disconnect-time unadmitted erasure, observation version exhaustion, and concurrent-resolution
 * fencing.
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
class ConnectedFinanceReconciliationIT extends ConnectedFinanceITSupport {

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
  @Autowired private ConnectionLifecycleService lifecycle;
  @Autowired private PlatformTransactionManager transactionManager;

  @AfterEach
  void resetFake() {
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    fake.setSyncGate(null);
  }

  @Test
  void keepLedgerPreservesLedgerAndCoalescesReviewWithReplay() throws Exception {
    Agent owner = signedInAgent("recon-keep");
    String householdId = createHousehold(owner, "Keep home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-keep-1", false, "12.34", "2026-09-10", "Original")));
    String observationId = postedId(owner, householdId);
    Resp confirmed =
        confirm(owner, householdId, observationId, 0, "EXPENSE", "Original", UUID.randomUUID());
    assertThat(confirmed.status()).isEqualTo(201);
    String transactionId = confirmed.json().path("transactionId").asText();

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-keep-1", false, "45.67", "2026-09-10", "Corrected")));
    assertThat(observationJson(owner, householdId, observationId).path("changeState").asText())
        .isEqualTo("MODIFIED");

    UUID key = UUID.randomUUID();
    Resp kept =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            key);
    assertThat(kept.status()).isEqualTo(200);
    assertThat(kept.json().path("transactionId").asText()).isEqualTo(transactionId);
    assertThat(kept.json().path("transactionVersion").asInt()).isZero();
    JsonNode activity = kept.json().path("activity");
    assertThat(activity.path("changeState").isNull()).isTrue();
    assertThat(activity.path("version").asInt()).isEqualTo(3);
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

    Resp replayed =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            key);
    assertThat(replayed.status()).isEqualTo(200);
    assertThat(replayed.json().path("transactionId").asText()).isEqualTo(transactionId);

    Resp conflicted =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":3,\"expectedLedgerVersion\":0,\"action\":\"VOID_LEDGER\"}",
            key);
    assertThat(conflicted.status()).isEqualTo(409);
    assertThat(conflicted.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
  }

  @Test
  void applyBankCorrectsSelectedFactsAndRejectsStaleVersionsWithoutPartialWrites()
      throws Exception {
    Agent owner = signedInAgent("recon-apply");
    String householdId = createHousehold(owner, "Apply home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-apply-1", false, "12.34", "2026-09-10", "Original")));
    String observationId = postedId(owner, householdId);
    Resp confirmed =
        confirm(owner, householdId, observationId, 0, "EXPENSE", "Original", UUID.randomUUID());
    String transactionId = confirmed.json().path("transactionId").asText();

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-apply-1", false, "45.67", "2026-09-10", "Corrected")));

    Resp applied =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"APPLY_BANK\","
                + "\"fields\":[\"description\",\"amount\"]}",
            UUID.randomUUID());
    assertThat(applied.status()).isEqualTo(200);
    assertThat(applied.json().path("transactionVersion").asInt()).isEqualTo(1);
    assertThat(applied.json().path("activity").path("changeState").isNull()).isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT amount FROM financial_transactions WHERE id = ?::uuid",
                BigDecimal.class,
                transactionId))
        .isEqualByComparingTo("-45.67");
    assertThat(
            jdbc.queryForObject(
                "SELECT description FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                transactionId))
        .isEqualTo("Corrected");

    // A stale ledger version fails before any write: the observation stays resolved.
    Resp stale =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":3,\"expectedLedgerVersion\":0,\"action\":\"APPLY_BANK\","
                + "\"fields\":[\"amount\"]}",
            UUID.randomUUID());
    assertThat(stale.status()).isEqualTo(409);
    assertThat(stale.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");
    assertThat(observationJson(owner, householdId, observationId).path("version").asInt())
        .isEqualTo(3);

    // Field-subset shape violations are safe 400s.
    Resp unknownField =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":3,\"expectedLedgerVersion\":1,\"action\":\"APPLY_BANK\","
                + "\"fields\":[\"kind\"]}",
            UUID.randomUUID());
    assertThat(unknownField.status()).isEqualTo(400);
    Resp emptyFields =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":3,\"expectedLedgerVersion\":1,\"action\":\"APPLY_BANK\","
                + "\"fields\":[]}",
            UUID.randomUUID());
    assertThat(emptyFields.status()).isEqualTo(400);
    Resp fieldsWithoutApply =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":3,\"expectedLedgerVersion\":1,\"action\":\"KEEP_LEDGER\","
                + "\"fields\":[\"amount\"]}",
            UUID.randomUUID());
    assertThat(fieldsWithoutApply.status()).isEqualTo(400);
  }

  @Test
  void removedAdmittedReviewRefusesApplyWhileKeepAndVoidBehave() throws Exception {
    Agent owner = signedInAgent("recon-removed");
    String householdId = createHousehold(owner, "Removed home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-rem-keep", false, "12.34", "2026-09-10", "Keep me"),
            transaction(link, "tx-rem-void", false, "7.25", "2026-09-11", "Void me")));
    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String keepObservation = itemByDescription(inbox, "Keep me").path("id").asText();
    String voidObservation = itemByDescription(inbox, "Void me").path("id").asText();
    String keepTransaction =
        confirm(owner, householdId, keepObservation, 0, "EXPENSE", "Keep me", UUID.randomUUID())
            .json()
            .path("transactionId")
            .asText();
    String voidTransaction =
        confirm(owner, householdId, voidObservation, 0, "EXPENSE", "Void me", UUID.randomUUID())
            .json()
            .path("transactionId")
            .asText();

    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(), List.of("tx-rem-keep", "tx-rem-void"), "cursor-rem-removed", false, true));
    demandAndProcess(link);

    // APPLY_BANK is unavailable for removed observations.
    Resp applyRemoved =
        resolve(
            owner,
            householdId,
            keepObservation,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"APPLY_BANK\","
                + "\"fields\":[\"description\"]}",
            UUID.randomUUID());
    assertThat(applyRemoved.status()).isEqualTo(409);
    assertThat(applyRemoved.json().path("code").asText()).isEqualTo("RECONCILIATION_REQUIRED");

    // KEEP_LEDGER preserves the confirmed entry without voiding it.
    Resp kept =
        resolve(
            owner,
            householdId,
            keepObservation,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            UUID.randomUUID());
    assertThat(kept.status()).isEqualTo(200);
    assertThat(
            jdbc.queryForObject(
                "SELECT status FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                keepTransaction))
        .isEqualTo("POSTED");

    // VOID_LEDGER voids the entry and records the decision.
    Resp voided =
        resolve(
            owner,
            householdId,
            voidObservation,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"VOID_LEDGER\"}",
            UUID.randomUUID());
    assertThat(voided.status()).isEqualTo(200);
    assertThat(voided.json().path("transactionVersion").asInt()).isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT status FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                voidTransaction))
        .isEqualTo("VOIDED");
    assertThat(voided.json().path("activity").path("changeState").isNull()).isTrue();
    // A directly voided imported entry stays associated and excluded.
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_ledger_associations WHERE transaction_id = ?::uuid",
                String.class,
                voidTransaction))
        .isEqualTo("CURRENT");
  }

  @Test
  void voidLedgerRefusesLiveRefunds() throws Exception {
    Agent owner = signedInAgent("recon-voidref");
    String householdId = createHousehold(owner, "Void refund home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-vr-expense", false, "12.34", "2026-09-10", "Bank expense"),
            transaction(link, "tx-vr-credit", false, "-5.00", "2026-09-11", "Bank credit")));
    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String expenseObservation = itemByDescription(inbox, "Bank expense").path("id").asText();
    String creditObservation = itemByDescription(inbox, "Bank credit").path("id").asText();
    String expenseId =
        confirm(
                owner,
                householdId,
                expenseObservation,
                0,
                "EXPENSE",
                "Bank expense",
                UUID.randomUUID())
            .json()
            .path("transactionId")
            .asText();
    Resp refund =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + creditObservation + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"REFUND\",\"description\":\"Bank credit\","
                + "\"refundOfTransactionId\":\""
                + expenseId
                + "\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(refund.status()).isEqualTo(201);

    Resp voided =
        resolve(
            owner,
            householdId,
            expenseObservation,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":1,\"action\":\"VOID_LEDGER\"}",
            UUID.randomUUID());
    assertThat(voided.status()).isEqualTo(409);
    assertThat(voided.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");
    assertThat(
            jdbc.queryForObject(
                "SELECT status FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                expenseId))
        .isEqualTo("POSTED");
  }

  @Test
  void replaceLedgerMovesAssociationAtomicallyWithHistoryAndReplay() throws Exception {
    Agent owner = signedInAgent("recon-replace");
    String householdId = createHousehold(owner, "Replace home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-rep-1", false, "12.34", "2026-09-10", "Original")));
    String observationId = postedId(owner, householdId);
    String oldTransaction =
        confirm(owner, householdId, observationId, 0, "EXPENSE", "Original", UUID.randomUUID())
            .json()
            .path("transactionId")
            .asText();

    UUID key = UUID.randomUUID();
    Resp replaced =
        replace(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"kind\":\"EXPENSE\","
                + "\"description\":\"Corrected label\",\"category\":\"GROCERIES\"}",
            key);
    assertThat(replaced.status()).isEqualTo(201);
    JsonNode body = replaced.json();
    String replacementId = body.path("transaction").path("id").asText();
    assertThat(replacementId).isNotEqualTo(oldTransaction);
    assertThat(body.path("transaction").path("description").asText()).isEqualTo("Corrected label");
    assertThat(body.path("transaction").path("category").asText()).isEqualTo("GROCERIES");
    assertThat(body.path("transaction").path("version").asInt()).isZero();
    assertThat(body.path("supersededTransactionId").asText()).isEqualTo(oldTransaction);
    assertThat(body.path("supersededTransactionVersion").asInt()).isEqualTo(1);
    assertThat(body.path("activity").path("ledgerTransactionId").asText()).isEqualTo(replacementId);
    assertThat(body.path("activity").path("changeState").isNull()).isTrue();

    assertThat(
            jdbc.queryForObject(
                "SELECT status FROM financial_transactions WHERE id = ?::uuid",
                String.class,
                oldTransaction))
        .isEqualTo("VOIDED");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_ledger_associations WHERE transaction_id = ?::uuid",
                String.class,
                oldTransaction))
        .isEqualTo("VOIDED");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_ledger_associations WHERE transaction_id = ?::uuid",
                String.class,
                replacementId))
        .isEqualTo("CURRENT");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_ledger_associations WHERE observation_id = ?::uuid",
                Integer.class,
                observationId))
        .isEqualTo(2);

    Resp replayed =
        replace(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"kind\":\"EXPENSE\","
                + "\"description\":\"Corrected label\",\"category\":\"GROCERIES\"}",
            key);
    assertThat(replayed.status()).isEqualTo(200);
    assertThat(replayed.json().path("transaction").path("id").asText()).isEqualTo(replacementId);
    assertThat(replayed.json().path("supersededTransactionId").asText()).isEqualTo(oldTransaction);
    assertThat(replayed.json().path("supersededTransactionVersion").asInt()).isEqualTo(1);

    // A second key now observes the moved versions and conflicts without a partial write.
    Resp conflicted =
        replace(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"kind\":\"EXPENSE\","
                + "\"description\":\"Corrected label\",\"category\":\"GROCERIES\"}",
            UUID.randomUUID());
    assertThat(conflicted.status()).isEqualTo(409);
    assertThat(conflicted.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_ledger_associations WHERE observation_id = ?::uuid",
                Integer.class,
                observationId))
        .isEqualTo(2);
  }

  @Test
  void replaceLedgerRefusesRemovedCurrencyMismatchAndStaleLedger() throws Exception {
    Agent owner = signedInAgent("recon-repneg");
    String householdId = createHousehold(owner, "Replace negative home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-rn-gone", false, "12.34", "2026-09-10", "Gone"),
            transaction(link, "tx-rn-drift", false, "9.99", "2026-09-11", "Drift")));
    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String goneObservation = itemByDescription(inbox, "Gone").path("id").asText();
    String driftObservation = itemByDescription(inbox, "Drift").path("id").asText();
    confirm(owner, householdId, goneObservation, 0, "EXPENSE", "Gone", UUID.randomUUID());
    confirm(owner, householdId, driftObservation, 0, "EXPENSE", "Drift", UUID.randomUUID());

    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(), List.of("tx-rn-gone"), "cursor-rn-removed", false, true));
    demandAndProcess(link);

    // Replacement needs a current posted revision.
    Resp removedReplace =
        replace(
            owner,
            householdId,
            goneObservation,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"kind\":\"EXPENSE\","
                + "\"description\":\"Gone\"}",
            UUID.randomUUID());
    assertThat(removedReplace.status()).isEqualTo(409);
    assertThat(removedReplace.json().path("code").asText()).isEqualTo("RECONCILIATION_REQUIRED");

    // A currency drift needs a separately reviewed mapping correction, never a silent fix.
    jdbc.update(
        "UPDATE connection_observations SET currency = 'EUR' WHERE id = ?::uuid", driftObservation);
    Resp driftedReplace =
        replace(
            owner,
            householdId,
            driftObservation,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"kind\":\"EXPENSE\","
                + "\"description\":\"Drift\"}",
            UUID.randomUUID());
    assertThat(driftedReplace.status()).isEqualTo(409);
    assertThat(driftedReplace.json().path("code").asText()).isEqualTo("RECONCILIATION_REQUIRED");
    jdbc.update(
        "UPDATE connection_observations SET currency = 'USD' WHERE id = ?::uuid", driftObservation);

    // A stale ledger version fails without voiding or admitting anything.
    Resp staleReplace =
        replace(
            owner,
            householdId,
            driftObservation,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":7,\"kind\":\"EXPENSE\","
                + "\"description\":\"Drift\"}",
            UUID.randomUUID());
    assertThat(staleReplace.status()).isEqualTo(409);
    assertThat(staleReplace.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_ledger_associations WHERE observation_id = ?::uuid",
                Integer.class,
                driftObservation))
        .isEqualTo(1);
  }

  @Test
  void allocationGuardsBlockApplyAndUnacknowledgedReplace() throws Exception {
    Agent owner = signedInAgent("recon-alloc");
    String householdId = createHousehold(owner, "Allocation guard home");
    Agent member = signedInAgent("recon-alloc-member");
    addMember(householdId, member.userId(), "MEMBER");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-al-1", false, "30.00", "2026-09-10", "Shared buy")));
    String observationId = postedId(owner, householdId);
    String expenseId =
        confirm(owner, householdId, observationId, 0, "EXPENSE", "Shared buy", UUID.randomUUID())
            .json()
            .path("transactionId")
            .asText();

    Resp shared =
        owner.request(
            "PATCH",
            "/api/households/" + householdId + "/transactions/" + expenseId,
            "{\"expectedVersion\":0,\"visibility\":\"HOUSEHOLD\"}",
            owner.csrfToken,
            null);
    assertThat(shared.status()).isEqualTo(200);
    Resp allocated =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions/" + expenseId + "/allocation",
            "{\"expectedVersion\":1,\"participantUserIds\":[\""
                + owner.userId()
                + "\",\""
                + member.userId()
                + "\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(allocated.status()).isEqualTo(201);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-al-1", false, "33.00", "2026-09-10", "Shared buy")));

    Resp applyBlocked =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":2,\"action\":\"APPLY_BANK\","
                + "\"fields\":[\"amount\"]}",
            UUID.randomUUID());
    assertThat(applyBlocked.status()).isEqualTo(409);
    assertThat(applyBlocked.json().path("code").asText()).isEqualTo("ALLOCATION_CONFLICT");

    Resp replaceBlocked =
        replace(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":2,\"kind\":\"EXPENSE\","
                + "\"description\":\"Shared buy\"}",
            UUID.randomUUID());
    assertThat(replaceBlocked.status()).isEqualTo(409);
    assertThat(replaceBlocked.json().path("code").asText()).isEqualTo("ALLOCATION_CONFLICT");

    Resp replaced =
        replace(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":2,\"kind\":\"EXPENSE\","
                + "\"description\":\"Shared buy\",\"acknowledgeAllocationRemoval\":true}",
            UUID.randomUUID());
    assertThat(replaced.status()).isEqualTo(201);
    String replacementId = replaced.json().path("transaction").path("id").asText();
    // The replacement never copies the allocation; the old one is atomically deactivated.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transaction_allocations"
                    + " WHERE transaction_id = ?::uuid AND status = 'ACTIVE'",
                Integer.class,
                expenseId))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT revoked_at FROM financial_transaction_allocations"
                    + " WHERE transaction_id = ?::uuid",
                java.time.OffsetDateTime.class,
                expenseId))
        .isNotNull();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transaction_allocations"
                    + " WHERE transaction_id = ?::uuid",
                Integer.class,
                replacementId))
        .isZero();
    assertThat(replaced.json().path("transaction").path("visibility").asText())
        .isEqualTo("PRIVATE");
  }

  @Test
  void disconnectErasesUnadmittedButKeepsAdmittedResolvable() throws Exception {
    Agent owner = signedInAgent("recon-disc");
    String householdId = createHousehold(owner, "Disconnect home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(
            transaction(link, "tx-dc-admit", false, "12.34", "2026-09-10", "Admitted"),
            transaction(link, "tx-dc-open", false, "5.00", "2026-09-11", "Open"),
            transaction(link, "tx-dc-pending", true, "3.00", "2026-09-12", "Pending")));
    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    String admittedObservation = itemByDescription(inbox, "Admitted").path("id").asText();
    confirm(owner, householdId, admittedObservation, 0, "EXPENSE", "Admitted", UUID.randomUUID());

    Resp disconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + link.connectionId()
                + "/disconnect",
            "{\"expectedVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(disconnected.status()).isEqualTo(202);
    String workId =
        jdbc.queryForObject(
            "SELECT id FROM connection_revocation_work WHERE connection_id = ?::uuid"
                + " AND state = 'QUEUED'",
            String.class,
            link.connectionId());
    lifecycle.processOneRevocation(UUID.fromString(workId));
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("DISCONNECTED");

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT review_state FROM connection_observations WHERE id = ?::uuid",
                String.class,
                admittedObservation))
        .isEqualTo("CONFIRMED");

    // The retained admitted review still resolves after disconnect.
    Resp kept =
        resolve(
            owner,
            householdId,
            admittedObservation,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            UUID.randomUUID());
    assertThat(kept.status()).isEqualTo(200);
  }

  @Test
  void suspendedResolvesLinkingRefusesAndFormerMemberLosesAccess() throws Exception {
    Agent owner = signedInAgent("recon-states");
    String householdId = createHousehold(owner, "States home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-st-1", false, "12.34", "2026-09-10", "Stateful")));
    String observationId = postedId(owner, householdId);
    confirm(owner, householdId, observationId, 0, "EXPENSE", "Stateful", UUID.randomUUID());

    jdbc.update(
        "UPDATE financial_connections SET state = 'SUSPENDED' WHERE id = ?::uuid",
        link.connectionId());
    Resp suspended =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            UUID.randomUUID());
    assertThat(suspended.status()).isEqualTo(200);

    jdbc.update(
        "UPDATE financial_connections SET state = 'LINKING' WHERE id = ?::uuid",
        link.connectionId());
    Resp linking =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            UUID.randomUUID());
    assertThat(linking.status()).isEqualTo(409);
    assertThat(linking.json().path("code").asText()).isEqualTo("CONNECTION_NOT_READY");
    jdbc.update(
        "UPDATE financial_connections SET state = 'ACTIVE' WHERE id = ?::uuid",
        link.connectionId());

    // A removed member shares the indistinguishable 404, never the review.
    Agent outsider = signedInAgent("recon-outsider");
    Resp foreign =
        outsider.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + observationId + "/resolve",
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            outsider.csrfToken,
            UUID.randomUUID());
    assertThat(foreign.status()).isEqualTo(404);
    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
        householdId,
        owner.userId());
    Resp former =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}",
            UUID.randomUUID());
    assertThat(former.status()).isEqualTo(404);
  }

  @Test
  void exhaustedObservationVersionMapsToConflict() throws Exception {
    Agent owner = signedInAgent("recon-exhaust");
    String householdId = createHousehold(owner, "Exhausted home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-ex-1", false, "12.34", "2026-09-10", "Capped")));
    String observationId = postedId(owner, householdId);
    String transactionId =
        confirm(owner, householdId, observationId, 0, "EXPENSE", "Capped", UUID.randomUUID())
            .json()
            .path("transactionId")
            .asText();
    jdbc.update(
        "UPDATE connection_observations SET version = 2147483647 WHERE id = ?::uuid",
        observationId);

    Resp exhausted =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":2147483647,\"expectedLedgerVersion\":0,"
                + "\"action\":\"KEEP_LEDGER\"}",
            UUID.randomUUID());
    assertThat(exhausted.status()).isEqualTo(409);
    assertThat(exhausted.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                transactionId))
        .isZero();
  }

  @Test
  void applyRejectsNullFieldElementWithoutServerError() throws Exception {
    Agent owner = signedInAgent("recon-nullfield");
    String householdId = createHousehold(owner, "Null field home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-nf-1", false, "12.34", "2026-09-10", "Nullish")));
    String observationId = postedId(owner, householdId);
    confirm(owner, householdId, observationId, 0, "EXPENSE", "Nullish", UUID.randomUUID());

    Resp rejected =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"action\":\"APPLY_BANK\","
                + "\"fields\":[null]}",
            UUID.randomUUID());
    assertThat(rejected.status()).isEqualTo(400);
    assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
  }

  @Test
  void applyWithOverscaleBankAmountNeedsReconciliation() throws Exception {
    Agent owner = signedInAgent("recon-overscale");
    String householdId = createHousehold(owner, "Overscale home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-os-1", false, "12.34", "2026-09-10", "Scaled")));
    String observationId = postedId(owner, householdId);
    String transactionId =
        confirm(owner, householdId, observationId, 0, "EXPENSE", "Scaled", UUID.randomUUID())
            .json()
            .path("transactionId")
            .asText();
    // Three-decimal stored bank facts fit NUMERIC(15, 3) but cannot scale to USD exactly.
    jdbc.update(
        "UPDATE connection_observations SET amount = -12.345 WHERE id = ?::uuid", observationId);

    Resp reconciling =
        resolve(
            owner,
            householdId,
            observationId,
            "{\"expectedVersion\":1,\"expectedLedgerVersion\":0,\"action\":\"APPLY_BANK\","
                + "\"fields\":[\"amount\"]}",
            UUID.randomUUID());
    assertThat(reconciling.status()).isEqualTo(409);
    assertThat(reconciling.json().path("code").asText()).isEqualTo("RECONCILIATION_REQUIRED");
    assertThat(
            jdbc.queryForObject(
                "SELECT amount FROM financial_transactions WHERE id = ?::uuid",
                BigDecimal.class,
                transactionId))
        .isEqualByComparingTo("-12.34");
  }

  @Test
  void concurrentKeepResolutionsElectASingleWinner() throws Exception {
    Agent owner = signedInAgent("recon-race");
    String householdId = createHousehold(owner, "Race home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-race-1", false, "12.34", "2026-09-10", "Racy")));
    String observationId = postedId(owner, householdId);
    confirm(owner, householdId, observationId, 0, "EXPENSE", "Racy", UUID.randomUUID());
    importPage(
        owner,
        householdId,
        link,
        List.of(transaction(link, "tx-race-1", false, "45.67", "2026-09-10", "Racy")));
    String keepBody =
        "{\"expectedVersion\":2,\"expectedLedgerVersion\":0,\"action\":\"KEEP_LEDGER\"}";

    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<Resp> first =
          pool.submit(
              () -> resolve(owner, householdId, observationId, keepBody, UUID.randomUUID()));
      Future<Resp> second =
          pool.submit(
              () -> resolve(owner, householdId, observationId, keepBody, UUID.randomUUID()));
      Resp firstResult = first.get(60, TimeUnit.SECONDS);
      Resp secondResult = second.get(60, TimeUnit.SECONDS);
      List<Integer> statuses = List.of(firstResult.status(), secondResult.status());
      assertThat(statuses).containsExactlyInAnyOrder(200, 409);
      Resp loser = firstResult.status() == 200 ? secondResult : firstResult;
      assertThat(loser.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");
    } finally {
      pool.shutdownNow();
    }
    assertThat(observationJson(owner, householdId, observationId).path("version").asInt())
        .isEqualTo(3);
  }

  private Resp confirm(
      Agent owner,
      String householdId,
      String observationId,
      int expectedVersion,
      String kind,
      String description,
      UUID key)
      throws Exception {
    return owner.request(
        "POST",
        "/api/households/" + householdId + "/bank-activity/" + observationId + "/confirm",
        "{\"expectedVersion\":"
            + expectedVersion
            + ",\"kind\":\""
            + kind
            + "\",\"description\":\""
            + description
            + "\"}",
        owner.csrfToken,
        key);
  }

  private Resp resolve(Agent owner, String householdId, String observationId, String body, UUID key)
      throws Exception {
    return owner.request(
        "POST",
        "/api/households/" + householdId + "/bank-activity/" + observationId + "/resolve",
        body,
        owner.csrfToken,
        key);
  }

  private Resp replace(Agent owner, String householdId, String observationId, String body, UUID key)
      throws Exception {
    return owner.request(
        "POST",
        "/api/households/" + householdId + "/bank-activity/" + observationId + "/replace-ledger",
        body,
        owner.csrfToken,
        key);
  }

  private String postedId(Agent owner, String householdId) throws Exception {
    JsonNode inbox = owner.get("/api/households/" + householdId + "/bank-activity").json();
    return findItem(inbox, item -> "POSTED".equals(item.path("state").asText()))
        .path("id")
        .asText();
  }

  private void importPage(
      Agent owner,
      String householdId,
      ConnectedLink link,
      List<PlaidAdapter.ProviderTransaction> upserts) {
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
        null,
        null,
        null,
        null,
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

  private static JsonNode itemByDescription(JsonNode page, String description) {
    return findItem(page, item -> description.equals(item.path("providerDescription").asText()));
  }
}
