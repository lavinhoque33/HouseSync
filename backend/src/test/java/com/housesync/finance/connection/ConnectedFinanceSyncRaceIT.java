package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.activity.application.BankActivityService;
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
import com.housesync.finance.connection.web.ConnectionExceptions.ObservationAlreadyConfirmedException;
import com.housesync.finance.connection.webhook.PlaidWebhookFixture;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.household.application.HouseholdService;
import java.math.BigDecimal;
import java.security.KeyPair;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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

/**
 * Barrier-style real-PostgreSQL regressions for sync-worker races: the worker takes
 * the connection lock before its connection-scoped work row, a signed health event cannot overwrite
 * a concurrent disconnect, a superseded worker cannot fail the reclaiming worker's state or
 * operations, concurrent first demand is one monotonic row, and a concurrent second confirmation is
 * a safe 409 rather than a 500.
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
class ConnectedFinanceSyncRaceIT extends ConnectedFinanceITSupport {

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
  @Autowired private BankActivityService bankActivityService;
  @Autowired private ConnectionSyncDemandRegistrar demands;

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
  @Autowired private com.housesync.finance.connection.application.RevocationRetryPolicy retryPolicy;

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
        "sync-race-second-worker");
  }

  private ConnectedLink linkedCheckingOnly(String tag) throws Exception {
    Agent owner = signedInAgent(tag);
    String householdId = createHousehold(owner, tag + " home");
    return linkAndSelect(owner, householdId, true, false);
  }

  private UUID workId(ConnectedLink link) {
    return jdbc.queryForObject(
        "SELECT id FROM connection_sync_work WHERE connection_id = ?::uuid",
        UUID.class,
        link.connectionId());
  }

  private void importPage(ConnectedLink link, List<PlaidAdapter.ProviderTransaction> upserts)
      throws Exception {
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(upserts, List.of(), "cursor-" + UUID.randomUUID(), false, true));
    new TransactionTemplate(transactionManager)
        .execute(
            status -> {
              demands.demand(UUID.fromString(link.connectionId()), Instant.now());
              return null;
            });
    syncService.processOne(workId(link));
  }

  private static PlaidAdapter.ProviderTransaction transaction(
      ConnectedLink link, String transactionId, String amount, String description) {
    return new PlaidAdapter.ProviderTransaction(
        link.remoteCheckingId(),
        transactionId,
        null,
        false,
        "USD",
        null,
        new BigDecimal(amount),
        LocalDate.of(2026, 9, 12),
        null,
        description,
        null);
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

  @Test
  void workerWaitsForConnectionLockBeforeClaiming() throws Exception {
    ConnectedLink link = linkedCheckingOnly("race-order");
    UUID workId = workId(link);

    CountDownLatch lockHeld = new CountDownLatch(1);
    Thread holder =
        new Thread(
            () ->
                new TransactionTemplate(transactionManager)
                    .execute(
                        status -> {
                          jdbc.queryForObject(
                              "SELECT id FROM financial_connections WHERE id = ?::uuid FOR UPDATE",
                              UUID.class,
                              link.connectionId());
                          lockHeld.countDown();
                          try {
                            Thread.sleep(700);
                          } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                          }
                          return null;
                        }));
    holder.start();
    assertThat(lockHeld.await(5, TimeUnit.SECONDS)).isTrue();

    Thread worker = new Thread(() -> syncService.processOne(workId));
    worker.start();
    Thread.sleep(300);

    // If the worker claimed the work row before the connection row, the claim would already be
    // RUNNING while the connection lock is still held elsewhere.
    assertThat(
            jdbc.queryForMap(
                "SELECT state, lease_fence FROM connection_sync_work WHERE id = ?::uuid",
                workId.toString()))
        .containsEntry("state", "QUEUED")
        .containsEntry("lease_fence", 0L);

    // Deterministic lock evidence: a separate transaction must be able to lock the work row with
    // NOWAIT while the worker waits, proving the worker holds no work-row lock yet.
    try {
      Boolean workRowUnlocked =
          new TransactionTemplate(transactionManager)
              .execute(
                  status ->
                      jdbc.queryForObject(
                              "SELECT id FROM connection_sync_work WHERE id = ?::uuid"
                                  + " FOR UPDATE NOWAIT",
                              UUID.class,
                              workId.toString())
                          != null);
      assertThat(workRowUnlocked).isTrue();
    } catch (org.springframework.dao.PessimisticLockingFailureException lockedEarly) {
      throw new AssertionError("worker locked the work row before the connection row", lockedEarly);
    }

    holder.join(10_000);
    worker.join(10_000);
    assertThat(
            jdbc.queryForObject(
                "SELECT lease_fence FROM connection_sync_work WHERE id = ?::uuid",
                Long.class,
                workId.toString()))
        .isEqualTo(1L);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isNotBlank();
  }

  @Test
  void webhookHealthCannotOverwriteConcurrentDisconnect() throws Exception {
    ConnectedLink link = linkedCheckingOnly("race-webhook");
    KeyPair pair = PlaidWebhookFixture.keyPair();
    String kid = "kid-" + UUID.randomUUID();
    fake.registerVerificationKey(new PlaidAdapter.VerificationKey(kid, pair.getPublic(), null));
    String itemId = "fake-item-" + link.seed();
    byte[] body = PlaidWebhookFixture.body("ITEM", "ERROR", itemId, "ITEM_LOGIN_REQUIRED");
    String jwt = PlaidWebhookFixture.signedJwt(pair, kid, body, Instant.now());

    long generationBefore =
        jdbc.queryForObject(
            "SELECT generation FROM financial_connections WHERE id = ?::uuid",
            Long.class,
            link.connectionId());
    int versionBefore =
        jdbc.queryForObject(
            "SELECT version FROM financial_connections WHERE id = ?::uuid",
            Integer.class,
            link.connectionId());

    CountDownLatch lockHeld = new CountDownLatch(1);
    Thread holder =
        new Thread(
            () ->
                new TransactionTemplate(transactionManager)
                    .execute(
                        status -> {
                          jdbc.queryForObject(
                              "SELECT id FROM financial_connections WHERE id = ?::uuid FOR UPDATE",
                              UUID.class,
                              link.connectionId());
                          lockHeld.countDown();
                          try {
                            Thread.sleep(400);
                          } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                          }
                          jdbc.update(
                              "UPDATE financial_connections"
                                  + " SET state = 'DISCONNECTING', generation = generation + 1,"
                                  + " version = version + 1, updated_at = now()"
                                  + " WHERE id = ?::uuid",
                              link.connectionId());
                          return null;
                        }));
    holder.start();
    assertThat(lockHeld.await(5, TimeUnit.SECONDS)).isTrue();

    AtomicInteger webhookStatus = new AtomicInteger(-1);
    Thread webhook =
        new Thread(
            () -> {
              try {
                webhookStatus.set(postWebhook(body, jwt).status());
              } catch (Exception unexpected) {
                webhookStatus.set(-2);
              }
            });
    webhook.start();
    Thread.sleep(250);

    // The signed event cannot finish while the concurrent disconnect transaction holds the
    // connection row lock.
    assertThat(webhook.isAlive()).isTrue();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM provider_webhook_events WHERE signed_jwt_hash = ?",
                Integer.class,
                ConnectionCrypto.sha256Hex(jwt)))
        .isZero();

    holder.join(10_000);
    webhook.join(10_000);
    assertThat(webhookStatus.get()).isEqualTo(200);
    // The stale health event must observe the disconnect and leave it alone: no REAUTH overwrite
    // and no extra generation/version bump.
    assertThat(
            jdbc.queryForMap(
                "SELECT state, generation, version FROM financial_connections WHERE id = ?::uuid",
                link.connectionId()))
        .containsEntry("state", "DISCONNECTING")
        .containsEntry("generation", generationBefore + 1)
        .containsEntry("version", versionBefore + 1);
  }

  @Test
  void supersededWorkerCannotFailReclaimedWork() throws Exception {
    Agent owner = signedInAgent("race-supersede");
    String householdId = createHousehold(owner, "Supersede home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);
    UUID workId = workId(link);

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

    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(transaction(link, "tx-supersede-1", "4.44", "Supersede page")),
            List.of(),
            "cursor-supersede-1",
            false,
            true));
    CountDownLatch gateA = new CountDownLatch(1);
    fake.setSyncGate(gateA);
    Thread workerA = new Thread(() -> syncService.processOne(workId));
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

    // The reclaiming worker supersedes the blocked worker's lease and completes the round.
    jdbc.update(
        "UPDATE connection_sync_work SET lease_expires_at = now() - interval '1 second'"
            + " WHERE id = ?::uuid",
        workId.toString());
    secondWorker().processOne(workId);
    assertThat(
            jdbc.queryForMap(
                "SELECT state FROM connection_operations WHERE id = ?::uuid", operationId))
        .containsEntry("state", "SUCCEEDED");

    // The superseded worker now fails unchecked; it must not fail the connection, the work row, or
    // the already-succeeded operations.
    fake.failNextSyncWithRuntimeException(link.accessToken());
    gateA.countDown();
    workerA.join(10_000);

    assertThat(
            jdbc.queryForMap(
                "SELECT state, last_error FROM connection_sync_work WHERE id = ?::uuid",
                workId.toString()))
        .containsEntry("state", "IDLE")
        .containsEntry("last_error", null);
    assertThat(
            jdbc.queryForObject(
                "SELECT sync_state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("IDLE");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_operations WHERE id = ?::uuid AND state = 'FAILED'",
                Integer.class,
                operationId))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations"
                    + " WHERE connection_id = ?::uuid AND provider_description = 'Supersede page'",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'ABANDONED'",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
  }

  @Test
  void webhookLockTimeoutIsBoundedAndSurfacesAsServiceUnavailable() throws Exception {
    ConnectedLink link = linkedCheckingOnly("race-lock-timeout");
    KeyPair pair = PlaidWebhookFixture.keyPair();
    String kid = "kid-" + UUID.randomUUID();
    fake.registerVerificationKey(new PlaidAdapter.VerificationKey(kid, pair.getPublic(), null));
    String itemId = "fake-item-" + link.seed();
    byte[] body = PlaidWebhookFixture.body("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", itemId, null);
    String jwt = PlaidWebhookFixture.signedJwt(pair, kid, body, Instant.now());

    CountDownLatch lockHeld = new CountDownLatch(1);
    Thread holder =
        new Thread(
            () ->
                new TransactionTemplate(transactionManager)
                    .execute(
                        status -> {
                          jdbc.queryForObject(
                              "SELECT id FROM financial_connections WHERE id = ?::uuid FOR UPDATE",
                              UUID.class,
                              link.connectionId());
                          lockHeld.countDown();
                          try {
                            Thread.sleep(5500);
                          } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                          }
                          return null;
                        }));
    holder.start();
    assertThat(lockHeld.await(5, TimeUnit.SECONDS)).isTrue();

    // The five-second connection lock timeout bounds the wait; the timed-out admission is the
    // shared generic 503 and rolls back completely rather than waiting indefinitely.
    Resp timedOut = postWebhook(body, jwt);
    assertThat(timedOut.status()).isEqualTo(503);
    assertThat(timedOut.json().path("code").asText()).isEqualTo("FINANCE_BUSY");
    holder.join(10_000);

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM provider_webhook_events WHERE signed_jwt_hash = ?",
                Integer.class,
                ConnectionCrypto.sha256Hex(jwt)))
        .isZero();
    // Once the lock is released the same signed event is admitted normally.
    assertThat(postWebhook(body, jwt).status()).isEqualTo(200);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM provider_webhook_events WHERE signed_jwt_hash = ?",
                Integer.class,
                ConnectionCrypto.sha256Hex(jwt)))
        .isEqualTo(1);
  }

  @Test
  void concurrentFirstDemandCreatesOneMonotonicRow() throws Exception {
    ConnectedLink link = linkedCheckingOnly("race-demand");
    jdbc.update(
        "DELETE FROM connection_sync_work WHERE connection_id = ?::uuid", link.connectionId());

    CyclicBarrier barrier = new CyclicBarrier(2);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Future<Object>> futures = new ArrayList<>();
      for (int index = 0; index < 2; index++) {
        futures.add(
            pool.submit(
                (Callable<Object>)
                    () -> {
                      barrier.await(5, TimeUnit.SECONDS);
                      return new TransactionTemplate(transactionManager)
                          .execute(
                              status -> {
                                demands.demand(UUID.fromString(link.connectionId()), Instant.now());
                                return null;
                              });
                    }));
      }
      for (Future<Object> future : futures) {
        future.get(20, TimeUnit.SECONDS);
      }
    } finally {
      pool.shutdownNow();
    }

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_work WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForMap(
                "SELECT demand_sequence, committed_sequence, state FROM connection_sync_work"
                    + " WHERE connection_id = ?::uuid",
                link.connectionId()))
        .containsEntry("demand_sequence", 2L)
        .containsEntry("committed_sequence", 0L)
        .containsEntry("state", "QUEUED");
  }

  /**
   * Regression for the CI `connection_sync_work_timestamp_order` violation: two concurrent first
   * demands can carry call timestamps in either order, so an older conflicting demand must never
   * move `updated_at` backwards past `created_at`. The row is placed in the future so a naive
   * assignment would definitely violate the constraint; GREATEST keeps it ordered and the demand
   * sequence still advances.
   */
  @Test
  void olderConflictingDemandNeverMovesUpdatedAtBackwards() throws Exception {
    ConnectedLink link = linkedCheckingOnly("race-demand-clock");
    UUID workId = workId(link);
    jdbc.update(
        "UPDATE connection_sync_work"
            + " SET created_at = now() + interval '1 hour', updated_at = now() + interval '1 hour'"
            + " WHERE id = ?::uuid",
        workId.toString());
    long before =
        jdbc.queryForObject(
            "SELECT demand_sequence FROM connection_sync_work WHERE id = ?::uuid",
            Long.class,
            workId.toString());

    new TransactionTemplate(transactionManager)
        .execute(
            status -> {
              demands.demand(
                  UUID.fromString(link.connectionId()),
                  Instant.now().minus(java.time.Duration.ofHours(2)));
              return null;
            });

    assertThat(
            jdbc.queryForMap(
                "SELECT demand_sequence, updated_at >= created_at AS ordered,"
                    + " updated_at > now() AS future FROM connection_sync_work WHERE id = ?::uuid",
                workId.toString()))
        .containsEntry("demand_sequence", before + 1)
        .containsEntry("ordered", true)
        .containsEntry("future", true);
  }

  /**
   * Concurrent variant of the same hazard: both starters race for the first demand with inverted
   * clock readings. Exactly one row exists with a monotonic sequence and ordered timestamps.
   */
  @Test
  void concurrentInvertedDemandTimestampsKeepOrderAndSequence() throws Exception {
    ConnectedLink link = linkedCheckingOnly("race-demand-inverted");
    jdbc.update(
        "DELETE FROM connection_sync_work WHERE connection_id = ?::uuid", link.connectionId());

    CyclicBarrier barrier = new CyclicBarrier(2);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Future<Object>> futures = new ArrayList<>();
      Instant base = Instant.now();
      for (int index = 0; index < 2; index++) {
        Instant requestedAt = index == 0 ? base : base.minus(java.time.Duration.ofMinutes(5));
        futures.add(
            pool.submit(
                (Callable<Object>)
                    () -> {
                      barrier.await(5, TimeUnit.SECONDS);
                      return new TransactionTemplate(transactionManager)
                          .execute(
                              status -> {
                                demands.demand(UUID.fromString(link.connectionId()), requestedAt);
                                return null;
                              });
                    }));
      }
      for (Future<Object> future : futures) {
        future.get(20, TimeUnit.SECONDS);
      }
    } finally {
      pool.shutdownNow();
    }

    assertThat(
            jdbc.queryForMap(
                "SELECT demand_sequence, updated_at >= created_at AS ordered"
                    + " FROM connection_sync_work WHERE connection_id = ?::uuid",
                link.connectionId()))
        .containsEntry("demand_sequence", 2L)
        .containsEntry("ordered", true);
  }

  @Test
  void concurrentConfirmsAdmitExactlyOnce() throws Exception {
    Agent owner = signedInAgent("race-confirm");
    String householdId = createHousehold(owner, "Confirm home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);
    importPage(link, List.of(transaction(link, "tx-race-confirm", "6.66", "Race confirm")));

    var row =
        jdbc.queryForMap(
            "SELECT id, version FROM connection_observations"
                + " WHERE connection_id = ?::uuid AND provider_description = 'Race confirm'",
            link.connectionId());
    UUID observationId = (UUID) row.get("id");
    int observationVersion = (Integer) row.get("version");
    UUID actorId = UUID.fromString(owner.userId());

    CyclicBarrier barrier = new CyclicBarrier(2);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Callable<Object> confirm =
          () -> {
            barrier.await(5, TimeUnit.SECONDS);
            try {
              return bankActivityService.confirm(
                  UUID.fromString(householdId),
                  observationId,
                  actorId,
                  UUID.randomUUID(),
                  new BankActivityService.ConfirmRequest(
                      observationVersion,
                      TransactionKind.EXPENSE,
                      "Race confirm",
                      null,
                      false,
                      null,
                      false));
            } catch (RuntimeException failure) {
              return failure;
            }
          };
      List<Future<Object>> futures = new ArrayList<>();
      for (int index = 0; index < 2; index++) {
        futures.add(pool.submit(confirm));
      }
      List<Object> results = new ArrayList<>();
      for (Future<Object> future : futures) {
        results.add(future.get(30, TimeUnit.SECONDS));
      }

      long successes =
          results.stream().filter(result -> result instanceof BankActivityService.Decision).count();
      assertThat(successes).isEqualTo(1);
      Object failure =
          results.stream()
              .filter(result -> !(result instanceof BankActivityService.Decision))
              .findFirst()
              .orElseThrow();
      // Both are documented safe 409s: the winner's version bump makes the loser stale, and a
      // loser that still passes the version check observes the current association/state.
      assertThat(failure)
          .isInstanceOfAny(
              ObservationAlreadyConfirmedException.class,
              com.housesync.finance.account.web.FinancialAccountExceptions
                  .ResourceVersionConflictException.class);
    } finally {
      pool.shutdownNow();
    }

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid"
                    + " AND source = 'CONNECTED'",
                Integer.class,
                householdId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_ledger_associations"
                    + " WHERE household_id = ?::uuid AND state = 'CURRENT'",
                Integer.class,
                householdId))
        .isEqualTo(1);
  }
}
