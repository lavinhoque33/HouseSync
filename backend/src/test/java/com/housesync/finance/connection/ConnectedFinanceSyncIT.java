package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.activity.persistence.ConnectionObservationRepository;
import com.housesync.finance.connection.application.ConnectionSyncDemandRegistrar;
import com.housesync.finance.connection.application.ConnectionSyncService;
import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundDeltaRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.webhook.PlaidWebhookFixture;
import com.housesync.household.application.HouseholdService;
import java.math.BigDecimal;
import java.security.KeyPair;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
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
 * Sync engine, webhook ingress, and first admission integration over real PostgreSQL. Uses the
 * deterministic fake provider; the scheduled worker is disabled by property so every round runs
 * under explicit test control.
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
class ConnectedFinanceSyncIT extends ConnectedFinanceITSupport {

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

  @Autowired private ConnectedFinanceProperties cfProperties;
  @Autowired private FinancialConnectionRepository connections;
  @Autowired private ConnectionAccountMappingRepository mappings;
  @Autowired private ConnectionLinkAttemptRepository attempts;
  @Autowired private ConnectionOperationRepository operations;
  @Autowired private ConnectionOperationIdempotencyRepository idempotency;
  @Autowired private ConnectionRevocationWorkRepository revocations;
  @Autowired private HouseholdService households;
  @Autowired private ConnectionCrypto crypto;
  @Autowired private Clock clock;
  @Autowired private PlatformTransactionManager transactionManager;
  @Autowired private ConnectionSyncWorkRepository syncWork;
  @Autowired private ConnectionSyncRoundRepository syncRounds;
  @Autowired private ConnectionSyncRoundDeltaRepository syncDeltas;
  @Autowired private ConnectionObservationRepository observations;
  @Autowired private ConnectionSyncDemandRegistrar demands;
  @Autowired private com.housesync.finance.connection.application.RevocationRetryPolicy retryPolicy;
  @Autowired private com.housesync.finance.connection.webhook.WebhookIngressService webhookIngress;

  @AfterEach
  void resetFake() {
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    fake.setSyncGate(null);
    fake.setKeyFetchFailure(null);
  }

  private ConnectionSyncService secondWorker() {
    return new ConnectionSyncService(
        cfProperties,
        connections,
        mappings,
        attempts,
        operations,
        idempotency,
        revocations,
        households,
        crypto,
        fake,
        clock,
        transactionManager,
        syncWork,
        syncRounds,
        syncDeltas,
        observations,
        demands,
        retryPolicy,
        "sync-second-worker");
  }

  private ConnectedLink linkedCheckingOnly(String tag) throws Exception {
    Agent owner = signedInAgent(tag);
    String householdId = createHousehold(owner, tag + " home");
    return linkAndSelect(owner, householdId, true, false);
  }

  @Test
  void manualSyncIsDurableRateLimitedAndOwnerScoped() throws Exception {
    Agent owner = signedInAgent("sync-manual");
    String householdId = createHousehold(owner, "Manual sync home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);
    int version = liveConnectionVersion(owner, householdId, link.connectionId());

    Resp first =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + link.connectionId()
                + "/sync",
            "{\"expectedVersion\":" + version + "}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(first.status()).isEqualTo(202);
    assertThat(first.json().path("operationType").asText()).isEqualTo("SYNC");
    assertThat(first.json().path("state").asText()).isEqualTo("PENDING");
    assertThat(first.cacheControl()).contains("no-store");

    Resp tooSoon =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + link.connectionId()
                + "/sync",
            "{\"expectedVersion\":" + version + "}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(tooSoon.status()).isEqualTo(429);
    assertThat(tooSoon.json().path("code").asText()).isEqualTo("MANUAL_SYNC_RATE_LIMITED");

    Resp staleVersion =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + link.connectionId()
                + "/sync",
            "{\"expectedVersion\":0}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(staleVersion.status()).isEqualTo(409);
    assertThat(staleVersion.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    Agent member = signedInAgent("sync-member");
    addMember(householdId, member.userId(), "MEMBER");
    Resp foreign =
        member.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + link.connectionId()
                + "/sync",
            "{\"expectedVersion\":" + version + "}",
            member.csrfToken,
            UUID.randomUUID());
    assertThat(foreign.status()).isEqualTo(404);
    assertThat(foreign.json().path("code").asText()).isEqualTo("FINANCIAL_CONNECTION_NOT_FOUND");

    assertThat(
            jdbc.queryForObject(
                "SELECT demand_sequence FROM connection_sync_work WHERE connection_id = ?::uuid",
                Long.class,
                link.connectionId()))
        .isGreaterThanOrEqualTo(1L);
  }

  @Test
  void initialEmptyThenImportQuarantineConfirmAndPrivateReporting() throws Exception {
    Agent owner = signedInAgent("sync-import");
    String householdId = createHousehold(owner, "Import home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    // Initial response is empty; the cursor and readiness commit without any observation.
    processConnection(link);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isNotBlank();
    assertThat(
            jdbc.queryForObject(
                "SELECT history_ready FROM financial_connections WHERE id = ?::uuid",
                Boolean.class,
                link.connectionId()))
        .isTrue();
    Resp connectionDetail =
        owner.get(
            "/api/households/" + householdId + "/financial-connections/" + link.connectionId());
    assertThat(connectionDetail.json().path("syncState").asText()).isEqualTo("IDLE");
    assertThat(connectionDetail.json().path("historyReady").asBoolean()).isTrue();

    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                providerTransaction(
                    link.remoteCheckingId(),
                    "tx-posted-1",
                    false,
                    "USD",
                    "12.34",
                    LocalDate.of(2026, 9, 10),
                    "Coffee Shop"),
                providerTransaction(
                    link.remoteCheckingId(),
                    "tx-pending-1",
                    true,
                    "USD",
                    "5.00",
                    LocalDate.of(2026, 9, 11),
                    "Pending charge"),
                providerTransaction(
                    link.remoteCheckingId(),
                    "tx-invalid-1",
                    false,
                    "CHF",
                    "1.00",
                    LocalDate.of(2026, 9, 10),
                    "Unsupported currency"),
                providerTransaction(
                    link.remoteSavingsId(),
                    "tx-unselected-1",
                    false,
                    "CAD",
                    "10.00",
                    LocalDate.of(2026, 9, 10),
                    "Unselected savings move")),
            List.of(),
            "cursor-after-page-1",
            false,
            true));

    int version = liveConnectionVersion(owner, householdId, link.connectionId());
    assertThat(
            owner
                .request(
                    "POST",
                    "/api/households/"
                        + householdId
                        + "/financial-connections/"
                        + link.connectionId()
                        + "/sync",
                    "{\"expectedVersion\":" + version + "}",
                    owner.csrfToken,
                    UUID.randomUUID())
                .status())
        .isEqualTo(202);
    processConnection(link);

    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-after-page-1");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(3);
    assertThat(
            jdbc.queryForObject(
                "SELECT invalid_reason FROM connection_observations"
                    + " WHERE connection_id = ?::uuid AND state = 'INVALID'",
                String.class,
                link.connectionId()))
        .isEqualTo("UNSUPPORTED_CURRENCY");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE provider_description = 'Unselected savings move'",
                Integer.class))
        .isZero();

    // Unreviewed activity never reaches the confirmed ledger or household reporting.
    Resp ownerLedger = owner.get("/api/households/" + householdId + "/transactions");
    assertThat(ownerLedger.status()).isEqualTo(200);
    assertThat(ownerLedger.json().path("items")).isEmpty();

    Resp listed = owner.get("/api/households/" + householdId + "/bank-activity");
    assertThat(listed.status()).isEqualTo(200);
    assertThat(listed.json().path("items")).hasSize(3);
    assertThat(listed.json().path("unreviewedCount").asLong()).isEqualTo(2);
    JsonNode posted = findItem(listed.json(), item -> "POSTED".equals(item.path("state").asText()));
    assertThat(posted.path("money").path("amount").asText()).isEqualTo("-12.34");
    assertThat(posted.path("money").path("currency").asText()).isEqualTo("USD");
    assertThat(posted.path("occurredOn").asText()).isEqualTo("2026-09-10");
    assertThat(posted.path("descriptionValid").asBoolean()).isTrue();
    String postedId = posted.path("id").asText();

    // Confirm admits exactly once and never exposes provider identities.
    Resp confirmed =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + postedId + "/confirm",
            "{\"expectedVersion\":"
                + posted.path("version").asInt()
                + ",\"kind\":\"EXPENSE\",\"description\":\"Coffee Shop\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(confirmed.status()).isEqualTo(201);
    assertThat(confirmed.json().path("activity").path("reviewState").asText())
        .isEqualTo("CONFIRMED");
    assertThat(confirmed.json().path("transactionId").asText()).isNotBlank();
    assertThat(confirmed.json().path("transactionVersion").asInt()).isZero();
    assertThat(confirmed.body()).doesNotContain(link.remoteCheckingId());

    Resp secondKey =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/bank-activity/" + postedId + "/confirm",
            "{\"expectedVersion\":"
                + confirmed.json().path("activity").path("version").asInt()
                + ",\"kind\":\"EXPENSE\",\"description\":\"Coffee Shop\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(secondKey.status()).isEqualTo(409);
    assertThat(secondKey.json().path("code").asText()).isEqualTo("OBSERVATION_ALREADY_CONFIRMED");

    Resp pendingConfirm =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/bank-activity/"
                + findItem(listed.json(), item -> "PENDING".equals(item.path("state").asText()))
                    .path("id")
                    .asText()
                + "/confirm",
            "{\"expectedVersion\":0,\"kind\":\"EXPENSE\",\"description\":\"Nope\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(pendingConfirm.status()).isEqualTo(409);
    assertThat(pendingConfirm.json().path("code").asText()).isEqualTo("OBSERVATION_NOT_POSTED");

    Resp ledgerAfter = owner.get("/api/households/" + householdId + "/transactions");
    assertThat(ledgerAfter.json().path("items")).hasSize(1);
    JsonNode admitted = ledgerAfter.json().path("items").get(0);
    assertThat(admitted.path("source").asText()).isEqualTo("CONNECTED");
    assertThat(admitted.path("money").path("amount").asText()).isEqualTo("-12.34");
    assertThat(admitted.path("accountId").asText()).isEqualTo(link.checkingAccountId());

    // Manual transaction POST into a CONNECTED account stays rejected.
    Resp manual =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            "{\"accountId\":\""
                + link.checkingAccountId()
                + "\",\"kind\":\"EXPENSE\",\"money\":{\"amount\":\"9.99\",\"currency\":\"USD\"},"
                + "\"occurredOn\":\"2026-09-12\",\"description\":\"Manual into bank\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(manual.status()).isEqualTo(400);

    // Owner privacy: a household member sees neither the private observation nor its ledger entry.
    Agent member = signedInAgent("sync-privacy-member");
    addMember(householdId, member.userId(), "MEMBER");
    Resp memberInbox = member.get("/api/households/" + householdId + "/bank-activity");
    assertThat(memberInbox.status()).isEqualTo(200);
    assertThat(memberInbox.json().path("items")).isEmpty();
    Resp memberDetail = member.get("/api/households/" + householdId + "/bank-activity/" + postedId);
    assertThat(memberDetail.status()).isEqualTo(404);
    assertThat(memberDetail.json().path("code").asText()).isEqualTo("BANK_ACTIVITY_NOT_FOUND");
    Resp memberLedger =
        member.get("/api/households/" + householdId + "/transactions?view=HOUSEHOLD");
    assertThat(memberLedger.status()).isEqualTo(200);
    assertThat(memberLedger.json().path("items")).isEmpty();
  }

  @Test
  void midRoundDemandForcesAnotherRoundAndSupersededWorkerCannotCommit() throws Exception {
    Agent owner = signedInAgent("sync-fence");
    String householdId = createHousehold(owner, "Fence home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    fake.enqueueSyncPage(
        link.accessToken(), fencePage(link, "tx-fence-1", "Fence page", "cursor-fence-1"));
    fake.enqueueSyncPage(
        link.accessToken(), fencePage(link, "tx-fence-2", "Fence page two", "cursor-fence-2"));

    CountDownLatch gateA = new CountDownLatch(1);
    CountDownLatch gateB = new CountDownLatch(1);
    fake.setSyncGate(gateA);
    fake.setSyncGate(gateB);
    UUID workId =
        jdbc.queryForObject(
            "SELECT id FROM connection_sync_work WHERE connection_id = ?::uuid",
            UUID.class,
            link.connectionId());
    assertThat(workId).isNotNull();
    Thread workerA =
        new Thread(
            () -> {
              try {
                syncService.processOne(workId);
              } catch (RuntimeException unexpected) {
                // The superseded worker must not leak an exception; assertions cover the outcome.
              }
            });
    workerA.start();

    long deadline = System.currentTimeMillis() + 15_000;
    while (System.currentTimeMillis() < deadline
        && jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'STAGING'",
                Integer.class,
                link.connectionId())
            == 0) {
      Thread.sleep(50);
    }

    // Crash A's lease; a second worker reclaims with a higher fence and starts a new round.
    jdbc.update(
        "UPDATE connection_sync_work SET lease_expires_at = now() - interval '1 second'"
            + " WHERE id = ?::uuid",
        workId.toString());
    Thread workerB =
        new Thread(
            () -> {
              try {
                secondWorker().processOne(workId);
              } catch (RuntimeException unexpected) {
                // Assertions cover the committed outcome.
              }
            });
    workerB.start();
    while (System.currentTimeMillis() < deadline
        && jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_work WHERE id = ?::uuid"
                    + " AND state = 'RUNNING' AND lease_fence = 2",
                Integer.class,
                workId.toString())
            == 0) {
      Thread.sleep(50);
    }

    // A demand arrives while the reclaiming worker's round is already running.
    int version = liveConnectionVersion(owner, householdId, link.connectionId());
    assertThat(
            owner
                .request(
                    "POST",
                    "/api/households/"
                        + householdId
                        + "/financial-connections/"
                        + link.connectionId()
                        + "/sync",
                    "{\"expectedVersion\":" + version + "}",
                    owner.csrfToken,
                    UUID.randomUUID())
                .status())
        .isEqualTo(202);

    // Release A first so it consumes its page and fails its fence check before B stages.
    gateA.countDown();
    workerA.join(10_000);
    gateB.countDown();
    workerB.join(10_000);

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations"
                    + " WHERE connection_id = ?::uuid AND provider_description = 'Fence page'",
                Integer.class,
                link.connectionId()))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations"
                    + " WHERE connection_id = ?::uuid"
                    + " AND provider_description = 'Fence page two'",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-fence-2");
    assertThat(
            jdbc.queryForObject(
                "SELECT lease_fence FROM connection_sync_work WHERE id = ?::uuid",
                Long.class,
                workId.toString()))
        .isEqualTo(2L);
    // The demand recorded mid-round survives completion and schedules another round.
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_sync_work WHERE id = ?::uuid",
                String.class,
                workId.toString()))
        .isEqualTo("QUEUED");
    assertThat(
            jdbc.queryForObject(
                "SELECT demand_sequence > committed_sequence FROM connection_sync_work"
                    + " WHERE id = ?::uuid",
                Boolean.class,
                workId.toString()))
        .isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'STAGING'",
                Integer.class,
                link.connectionId()))
        .isZero();
  }

  @Test
  void selectingAnAccountWithoutImportedHistoryResetsTheItemCursor() throws Exception {
    Agent owner = signedInAgent("sync-reset");
    String householdId = createHousehold(owner, "Reset home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    // The first empty round covers only the selected checking mapping.
    processConnection(link);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isNotBlank();
    assertThat(
            jdbc.queryForObject(
                "SELECT history_imported FROM financial_connection_account_mappings"
                    + " WHERE id = ?::uuid",
                Boolean.class,
                link.checkingMappingId()))
        .isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT history_imported FROM financial_connection_account_mappings"
                    + " WHERE id = ?::uuid",
                Boolean.class,
                link.savingsMappingId()))
        .isFalse();

    int version = liveConnectionVersion(owner, householdId, link.connectionId());
    Resp selected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + link.connectionId()
                + "/account-selection",
            "{\"expectedVersion\":"
                + version
                + ",\"accountMappingIds\":[\""
                + link.checkingMappingId()
                + "\",\""
                + link.savingsMappingId()
                + "\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(selected.status()).isEqualTo(200);

    // Adding a mapping whose history was never imported resets the Item-wide cursor and readiness
    // once, so the provider replays from the beginning instead of reusing a cursor that skipped it.
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isNull();
    assertThat(
            jdbc.queryForObject(
                "SELECT history_ready FROM financial_connections WHERE id = ?::uuid",
                Boolean.class,
                link.connectionId()))
        .isFalse();

    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                providerTransaction(
                    link.remoteSavingsId(),
                    "tx-savings-history-1",
                    false,
                    "CAD",
                    "10.00",
                    LocalDate.of(2026, 9, 5),
                    "Replayed savings history")),
            List.of(),
            "cursor-after-history-reset",
            false,
            true));
    processConnection(link);

    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-after-history-reset");
    assertThat(
            jdbc.queryForObject(
                "SELECT history_imported FROM financial_connection_account_mappings"
                    + " WHERE id = ?::uuid",
                Boolean.class,
                link.savingsMappingId()))
        .isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
  }

  /** Runs one targeted round for the connection without relying on the global due-page order. */
  private void processConnection(ConnectedLink link) {
    syncService.processOne(workId(link));
  }

  private UUID workId(ConnectedLink link) {
    return jdbc.queryForObject(
        "SELECT id FROM connection_sync_work WHERE connection_id = ?::uuid",
        UUID.class,
        link.connectionId());
  }

  /** Registers one demand without running a round; the caller controls round execution. */
  private void demand(ConnectedLink link) {
    new TransactionTemplate(transactionManager)
        .execute(
            status -> {
              demands.demand(UUID.fromString(link.connectionId()), Instant.now());
              return null;
            });
  }

  /** Registers demand directly (bypassing the manual interval) and runs one targeted round. */
  private void demandAndProcess(ConnectedLink link) {
    new TransactionTemplate(transactionManager)
        .execute(
            status -> {
              demands.demand(UUID.fromString(link.connectionId()), Instant.now());
              return null;
            });
    UUID workId =
        jdbc.queryForObject(
            "SELECT id FROM connection_sync_work WHERE connection_id = ?::uuid",
            UUID.class,
            link.connectionId());
    syncService.processOne(workId);
  }

  @Test
  void removalReplayIsExactAndInvalidRevivalCommits() throws Exception {
    Agent owner = signedInAgent("sync-replay");
    String householdId = createHousehold(owner, "Replay home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(List.of(), List.of("tx-ghost"), "cursor-ghost-1", false, true));
    demandAndProcess(link);
    assertThat(
            jdbc.queryForMap(
                "SELECT state, tombstone, version FROM connection_observations"
                    + " WHERE connection_id = ?::uuid",
                link.connectionId()))
        .containsEntry("state", "REMOVED")
        .containsEntry("tombstone", true)
        .containsEntry("version", 0);

    // Exact replay of the same removal neither bumps the version nor rewrites the tombstone.
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(List.of(), List.of("tx-ghost"), "cursor-ghost-2", false, true));
    demandAndProcess(link);
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isZero();

    // A later identifiable invalid revision of that identity commits as a visible INVALID row.
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                providerTransaction(
                    link.remoteCheckingId(),
                    "tx-ghost",
                    false,
                    "CHF",
                    "1.00",
                    LocalDate.of(2026, 9, 6),
                    "Revived invalid")),
            List.of(),
            "cursor-ghost-3",
            false,
            true));
    demandAndProcess(link);
    assertThat(
            jdbc.queryForMap(
                "SELECT state, tombstone, invalid_reason, version FROM connection_observations"
                    + " WHERE connection_id = ?::uuid",
                link.connectionId()))
        .containsEntry("state", "INVALID")
        .containsEntry("tombstone", false)
        .containsEntry("invalid_reason", "UNSUPPORTED_CURRENCY")
        .containsEntry("version", 1);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-ghost-3");
  }

  @Test
  void unselectedAndNeverAdmittedPayloadsAreConsumedOnly() throws Exception {
    Agent owner = signedInAgent("sync-consume");
    String householdId = createHousehold(owner, "Consume home");
    // Add an ineligible account that can never be admitted.
    fake.setExtraAccounts(
        List.of(
            new com.housesync.finance.connection.plaid.RemoteAccount(
                "fake-remote-loan-probe", "Loan probe", "UNSUPPORTED", "USD")));
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    assertThat(
            jdbc.queryForMap(
                "SELECT eligible, selected, local_account_id FROM"
                    + " financial_connection_account_mappings WHERE id = ?::uuid",
                link.savingsMappingId()))
        .containsEntry("eligible", true)
        .containsEntry("selected", false)
        .containsEntry("local_account_id", null);
    String loanMappingId =
        jdbc.queryForObject(
            "SELECT id FROM financial_connection_account_mappings"
                + " WHERE connection_id = ?::uuid AND remote_account_digest = ?",
            String.class,
            link.connectionId(),
            com.housesync.finance.connection.crypto.ConnectionCrypto.sha256Hex(
                "PLAID\0SANDBOX\0fake-remote-loan-probe"));
    assertThat(
            jdbc.queryForMap(
                "SELECT eligible, selected, local_account_id FROM"
                    + " financial_connection_account_mappings WHERE id = ?::uuid",
                loanMappingId))
        .containsEntry("eligible", false)
        .containsEntry("selected", false)
        .containsEntry("local_account_id", null);

    // Valid and invalid deltas for the unselected eligible savings mapping and the ineligible
    // never-admitted loan mapping: all four are consumed only to advance the Item cursor.
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                providerTransaction(
                    link.remoteSavingsId(),
                    "tx-unsel-valid",
                    false,
                    "CAD",
                    "10.00",
                    LocalDate.of(2026, 9, 8),
                    "Unselected valid"),
                providerTransaction(
                    link.remoteSavingsId(),
                    "tx-unsel-invalid",
                    false,
                    "CHF",
                    "1.00",
                    LocalDate.of(2026, 9, 8),
                    "Unselected invalid"),
                providerTransaction(
                    "fake-remote-loan-probe",
                    "tx-loan-valid",
                    false,
                    "USD",
                    "3.00",
                    LocalDate.of(2026, 9, 8),
                    "Loan valid"),
                providerTransaction(
                    "fake-remote-loan-probe",
                    "tx-loan-invalid",
                    false,
                    "CHF",
                    "1.00",
                    LocalDate.of(2026, 9, 8),
                    "Loan invalid")),
            List.of(),
            "cursor-consumed-only",
            false,
            true));
    demandAndProcess(link);

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-consumed-only");
  }

  @Test
  void multiPageRoundIsInvisibleUntilFinalCommit() throws Exception {
    Agent owner = signedInAgent("sync-multipage");
    String householdId = createHousehold(owner, "Multipage home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);
    processConnection(link);
    String cursorBefore =
        jdbc.queryForObject(
            "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
            String.class,
            link.connectionId());
    demand(link);

    // The first page is staged and the second fetch blocks, so the round cannot commit yet.
    fake.setSyncGate(new CountDownLatch(0));
    CountDownLatch secondPageGate = new CountDownLatch(1);
    fake.setSyncGate(secondPageGate);
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                providerTransaction(
                    link.remoteCheckingId(),
                    "tx-page-1",
                    false,
                    "USD",
                    "11.00",
                    LocalDate.of(2026, 9, 9),
                    "Page one")),
            List.of(),
            "cursor-page-1",
            true,
            false));
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                providerTransaction(
                    link.remoteCheckingId(),
                    "tx-page-2",
                    false,
                    "USD",
                    "22.00",
                    LocalDate.of(2026, 9, 9),
                    "Page two")),
            List.of(),
            "cursor-page-2",
            false,
            true));

    UUID workId = workId(link);
    Thread worker = new Thread(() -> syncService.processOne(workId));
    worker.start();
    long deadline = System.currentTimeMillis() + 15_000;
    while (System.currentTimeMillis() < deadline
        && jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'STAGING'"
                    + " AND delta_count >= 1",
                Integer.class,
                link.connectionId())
            == 0) {
      Thread.sleep(50);
    }

    // Staged pages are invisible: no observation, no cursor move, and no readiness flip.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo(cursorBefore);
    assertThat(
            jdbc.queryForMap(
                "SELECT has_more, delta_count FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'STAGING'",
                link.connectionId()))
        .containsEntry("has_more", true)
        .containsEntry("delta_count", 1);

    secondPageGate.countDown();
    worker.join(10_000);

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(2);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-page-2");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'STAGING'",
                Integer.class,
                link.connectionId()))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'APPLIED'",
                Integer.class,
                link.connectionId()))
        .isEqualTo(2);
  }

  @Test
  void paginationRestartDiscardsStagedPagesAndRestartsFromCommittedCursor() throws Exception {
    Agent owner = signedInAgent("sync-restart");
    String householdId = createHousehold(owner, "Restart home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);
    processConnection(link);
    String cursorBefore =
        jdbc.queryForObject(
            "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
            String.class,
            link.connectionId());
    UUID workId = workId(link);

    List<PlaidAdapter.SyncPage> replayPages =
        List.of(
            new PlaidAdapter.SyncPage(
                List.of(
                    providerTransaction(
                        link.remoteCheckingId(),
                        "tx-restart-1",
                        false,
                        "USD",
                        "31.00",
                        LocalDate.of(2026, 9, 9),
                        "Restart one")),
                List.of(),
                "cursor-restart-1",
                true,
                false),
            new PlaidAdapter.SyncPage(
                List.of(
                    providerTransaction(
                        link.remoteCheckingId(),
                        "tx-restart-2",
                        false,
                        "USD",
                        "32.00",
                        LocalDate.of(2026, 9, 9),
                        "Restart two")),
                List.of(),
                "cursor-restart-2",
                false,
                true));
    for (PlaidAdapter.SyncPage page : replayPages) {
      fake.enqueueSyncPage(link.accessToken(), page);
    }
    demand(link);
    long callsBefore = fake.syncCallCount(link.accessToken());
    fake.failSyncOnCall(
        link.accessToken(),
        callsBefore + 2,
        com.housesync.finance.connection.plaid.ProviderErrorClass.PAGINATION_RESTART);
    processConnection(link);

    // The staged page is discarded, nothing became visible, and the original cursor is retained.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo(cursorBefore);
    assertThat(
            jdbc.queryForMap(
                "SELECT state, last_error FROM connection_sync_work WHERE id = ?::uuid",
                workId.toString()))
        .containsEntry("state", "RETRY_WAIT")
        .containsEntry("last_error", "PAGINATION_RESTART");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'STAGING'",
                Integer.class,
                link.connectionId()))
        .isZero();

    // A due retry replays from the original committed cursor and commits atomically. The provider
    // replays both pages from the cursor; any page the failed round never consumed is discarded.
    jdbc.update(
        "UPDATE connection_sync_work SET next_retry_at = now() - interval '1 second'"
            + " WHERE id = ?::uuid",
        workId.toString());
    fake.clearSyncPages(link.accessToken());
    for (PlaidAdapter.SyncPage page : replayPages) {
      fake.enqueueSyncPage(link.accessToken(), page);
    }
    int cursorLogBefore = fake.syncCursors(link.accessToken()).size();
    processConnection(link);

    assertThat(fake.syncCursors(link.accessToken()).get(cursorLogBefore)).isEqualTo(cursorBefore);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(2);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-restart-2");
  }

  @Test
  void identityConflictObservationsAreVisibleAndIdentityIsUnchanged() throws Exception {
    Agent owner = signedInAgent("sync-conflict");
    String householdId = createHousehold(owner, "Conflict home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    // The provider later classifies the admitted mapping differently: the mapping is blocked but
    // its admitted identity must not change.
    jdbc.update(
        "UPDATE financial_connection_account_mappings"
            + " SET selected = false, eligible = false, exclusion_reason = 'IDENTITY_CONFLICT'"
            + " WHERE id = ?::uuid",
        link.checkingMappingId());

    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                providerTransaction(
                    link.remoteCheckingId(),
                    "tx-conflict-1",
                    false,
                    "USD",
                    "8.00",
                    LocalDate.of(2026, 9, 7),
                    "Conflict txn")),
            List.of(),
            "cursor-conflict-1",
            false,
            true));
    demandAndProcess(link);

    assertThat(
            jdbc.queryForMap(
                "SELECT state, invalid_reason, tombstone FROM connection_observations"
                    + " WHERE connection_id = ?::uuid AND provider_description = 'Conflict txn'",
                link.connectionId()))
        .containsEntry("state", "INVALID")
        .containsEntry("invalid_reason", "IDENTITY_CONFLICT")
        .containsEntry("tombstone", false);
    assertThat(
            jdbc.queryForMap(
                "SELECT kind, currency, exclusion_reason FROM financial_connection_account_mappings"
                    + " WHERE id = ?::uuid",
                link.checkingMappingId()))
        .containsEntry("kind", "CHECKING")
        .containsEntry("currency", "USD")
        .containsEntry("exclusion_reason", "IDENTITY_CONFLICT");
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-conflict-1");
  }

  @Test
  void expiredWebhookEventsAndOrphanStagingRoundsAreScrubbed() throws Exception {
    Agent owner = signedInAgent("sync-scrub");
    String householdId = createHousehold(owner, "Scrub home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    String staleHash = "a".repeat(64);
    jdbc.update(
        "INSERT INTO provider_webhook_events"
            + " (id, provider, environment, signed_jwt_hash, body_hash, received_at)"
            + " VALUES (?::uuid, 'PLAID', 'SANDBOX', ?, ?, now() - interval '2 days')",
        UUID.randomUUID().toString(),
        staleHash,
        "b".repeat(64));
    webhookIngress.scrubExpiredWebhookEvents();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM provider_webhook_events WHERE signed_jwt_hash = ?",
                Integer.class,
                staleHash))
        .isZero();

    // A crashed worker's orphaned STAGING round is abandoned and removed after its TTL.
    UUID roundId = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO connection_sync_rounds"
            + " (id, connection_id, generation, lease_fence, original_cursor, next_cursor,"
            + " has_more, delta_count, byte_count, history_ready, state, created_at, updated_at)"
            + " VALUES (?::uuid, ?::uuid, 0, 99, NULL, NULL, true, 1, 10, false, 'STAGING',"
            + " now() - interval '2 days', now() - interval '2 days')",
        roundId.toString(),
        link.connectionId());
    jdbc.update(
        "INSERT INTO connection_sync_round_deltas"
            + " (round_id, sequence, remote_transaction_digest, removed)"
            + " VALUES (?::uuid, 1, ?, false)",
        roundId.toString(),
        "c".repeat(64));
    syncService.scrubExpiredSyncData();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds WHERE id = ?::uuid",
                Integer.class,
                roundId.toString()))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_round_deltas WHERE round_id = ?::uuid",
                Integer.class,
                roundId.toString()))
        .isZero();
  }

  @Test
  void bankActivityPagingBoundsRejectInvalidValues() throws Exception {
    Agent owner = signedInAgent("sync-paging");
    String householdId = createHousehold(owner, "Paging home");
    linkAndSelect(owner, householdId, true, false);

    for (String query :
        List.of(
            "limit=99999999999999999999",
            "limit=0",
            "limit=abc",
            "limit=101",
            "offset=-1",
            "offset=100000")) {
      Resp response = owner.get("/api/households/" + householdId + "/bank-activity?" + query);
      assertThat(response.status()).as(query).isEqualTo(400);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    }
  }

  @Test
  void inactiveConnectionFailsPendingSyncOperations() throws Exception {
    Agent owner = signedInAgent("sync-inactive");
    String householdId = createHousehold(owner, "Inactive home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    int version = liveConnectionVersion(owner, householdId, link.connectionId());
    Resp sync =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + link.connectionId()
                + "/sync",
            "{\"expectedVersion\":" + version + "}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(sync.status()).isEqualTo(202);
    String operationId = sync.json().path("id").asText();

    jdbc.update(
        "UPDATE financial_connections SET state = 'REAUTH_REQUIRED' WHERE id = ?::uuid",
        link.connectionId());
    processConnection(link);

    assertThat(
            jdbc.queryForMap(
                "SELECT state, error_code FROM connection_operations WHERE id = ?::uuid",
                operationId))
        .containsEntry("state", "FAILED")
        .containsEntry("error_code", "REAUTH_REQUIRED");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("REAUTH_REQUIRED");
    assertThat(
            jdbc.queryForObject(
                "SELECT demand_sequence = committed_sequence FROM connection_sync_work"
                    + " WHERE connection_id = ?::uuid",
                Boolean.class,
                link.connectionId()))
        .isTrue();
  }

  @Test
  void webhookTrustBoundaryAndConservativeHealthHandling() throws Exception {
    Agent owner = signedInAgent("sync-webhook");
    String householdId = createHousehold(owner, "Webhook home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);

    KeyPair pair = PlaidWebhookFixture.keyPair();
    String kid = "kid-" + UUID.randomUUID();
    fake.registerVerificationKey(new PlaidAdapter.VerificationKey(kid, pair.getPublic(), null));
    String itemId = "fake-item-" + link.seed();
    byte[] body = PlaidWebhookFixture.body("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", itemId, null);
    String jwt = PlaidWebhookFixture.signedJwt(pair, kid, body, Instant.now());

    long demandBefore =
        jdbc.queryForObject(
            "SELECT demand_sequence FROM connection_sync_work WHERE connection_id = ?::uuid",
            Long.class,
            link.connectionId());

    Resp accepted = postWebhook(body, jwt);
    assertThat(accepted.status()).isEqualTo(200);
    assertThat(
            jdbc.queryForObject(
                "SELECT demand_sequence FROM connection_sync_work WHERE connection_id = ?::uuid",
                Long.class,
                link.connectionId()))
        .isEqualTo(demandBefore + 1);
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_webhook_events", Integer.class))
        .isEqualTo(1);

    // Replay commits nothing new but still returns 200.
    assertThat(postWebhook(body, jwt).status()).isEqualTo(200);
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM provider_webhook_events", Integer.class))
        .isEqualTo(1);

    assertThat(
            postWebhook(
                    body,
                    PlaidWebhookFixture.signedJwt(pair, kid, body, Instant.now().minusSeconds(600)))
                .status())
        .isEqualTo(401);
    KeyPair otherPair = PlaidWebhookFixture.keyPair();
    assertThat(
            postWebhook(body, PlaidWebhookFixture.signedJwt(otherPair, kid, body, Instant.now()))
                .status())
        .isEqualTo(401);
    assertThat(
            postWebhook(
                    body, PlaidWebhookFixture.signedJwt(pair, kid, "HS256", body, Instant.now()))
                .status())
        .isEqualTo(401);
    assertThat(
            postWebhook(
                    body,
                    PlaidWebhookFixture.signedJwt(
                        pair, "unknown-kid-" + UUID.randomUUID(), body, Instant.now()))
                .status())
        .isEqualTo(401);
    byte[] tampered = PlaidWebhookFixture.body("ITEM", "ERROR", itemId, "ITEM_LOGIN_REQUIRED");
    assertThat(postWebhook(tampered, jwt).status()).isEqualTo(401);

    // Unknown Items are verified and acknowledged without revealing existence.
    byte[] unknownItem =
        PlaidWebhookFixture.body("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", "unknown-item", null);
    assertThat(
            postWebhook(
                    unknownItem,
                    PlaidWebhookFixture.signedJwt(pair, kid, unknownItem, Instant.now()))
                .status())
        .isEqualTo(200);

    // Bad format and oversized bodies are rejected before verification.
    assertThat(
            owner
                .raw("POST", "/api/provider-webhooks/plaid", "{}", null, null, "text/plain")
                .status())
        .isEqualTo(400);
    String oversized = "{\"webhook_type\":\"" + "x".repeat(1024 * 1024) + "\"}";
    assertThat(
            owner
                .raw(
                    "POST",
                    "/api/provider-webhooks/plaid",
                    oversized,
                    null,
                    null,
                    "application/json")
                .status())
        .isEqualTo(413);

    // Key infrastructure outage is a 503, never a verification success.
    String outageKid = "outage-" + UUID.randomUUID();
    fake.setKeyFetchFailure(com.housesync.finance.connection.plaid.ProviderErrorClass.TRANSIENT);
    byte[] outageBody =
        PlaidWebhookFixture.body("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", itemId, null);
    assertThat(
            postWebhook(
                    outageBody,
                    PlaidWebhookFixture.signedJwt(pair, outageKid, outageBody, Instant.now()))
                .status())
        .isEqualTo(503);
    fake.setKeyFetchFailure(null);

    // Health events stop fetching conservatively and never reactivate a connection.
    long fetchCountBefore = fake.syncCallCount(link.accessToken());
    byte[] loginRequired = PlaidWebhookFixture.body("ITEM", "ERROR", itemId, "ITEM_LOGIN_REQUIRED");
    assertThat(
            postWebhook(
                    loginRequired,
                    PlaidWebhookFixture.signedJwt(pair, kid, loginRequired, Instant.now()))
                .status())
        .isEqualTo(200);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("REAUTH_REQUIRED");
    processConnection(link);
    assertThat(fake.syncCallCount(link.accessToken())).isEqualTo(fetchCountBefore);

    byte[] consentRevoked =
        PlaidWebhookFixture.body(
            "USER_PERMISSION_REVOKED", "USER_PERMISSION_REVOKED", itemId, null);
    assertThat(
            postWebhook(
                    consentRevoked,
                    PlaidWebhookFixture.signedJwt(pair, kid, consentRevoked, Instant.now()))
                .status())
        .isEqualTo(200);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("SUSPENDED");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_revocation_work WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
  }

  private Resp postWebhook(byte[] body, String jwt) throws Exception {
    java.net.http.HttpRequest request =
        java.net.http.HttpRequest.newBuilder(
                java.net.URI.create("http://localhost:" + port + "/api/provider-webhooks/plaid"))
            .timeout(java.time.Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .header("Plaid-Verification", jwt)
            .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(body))
            .build();
    java.net.http.HttpResponse<String> response =
        client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
    return new Resp(response.statusCode(), response.body(), response.headers());
  }

  private static PlaidAdapter.SyncPage fencePage(
      ConnectedLink link, String transactionId, String description, String cursor) {
    return new PlaidAdapter.SyncPage(
        List.of(
            providerTransaction(
                link.remoteCheckingId(),
                transactionId,
                false,
                "USD",
                "3.33",
                LocalDate.of(2026, 9, 12),
                description)),
        List.of(),
        cursor,
        false,
        true);
  }

  private static PlaidAdapter.ProviderTransaction providerTransaction(
      String accountId,
      String transactionId,
      boolean pending,
      String currency,
      String amount,
      LocalDate date,
      String description) {
    return new PlaidAdapter.ProviderTransaction(
        accountId,
        transactionId,
        null,
        pending,
        currency,
        null,
        new BigDecimal(amount),
        date,
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
}
