package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.activity.persistence.ConnectionObservationRepository;
import com.housesync.finance.connection.application.ConnectionSyncDemandRegistrar;
import com.housesync.finance.connection.application.ConnectionSyncService;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundDeltaRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncRoundRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncWorkRepository;
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

/**
 * Over-limit round acceptance with a diagnostic-low configured bound: the failure is visible and
 * resumable, the committed cursor and observations are untouched, and production ceilings are
 * enforced by configuration validation (the bound may only be lowered, never raised).
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      "app.auth.ip-max-attempts=1000",
      "app.connected-finance.enabled=true",
      "app.connected-finance.provider=fake",
      "app.connected-finance.fake-allowed=true",
      "app.connected-finance.encryption-keys=test-key-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      "app.connected-finance.sync-max-round-deltas=2",
      "app.connected-finance.revocation-poll-ms=3600000",
      "app.connected-finance.attempt-cleanup-ms=3600000",
      "app.connected-finance.sync-poll-ms=3600000",
      "app.connected-finance.sync-sweep-ms=3600000",
      "app.connected-finance.sync-scrub-ms=3600000"
    })
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class ConnectedFinanceSyncLimitsIT extends ConnectedFinanceITSupport {

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
  @Autowired private ConnectionSyncDemandRegistrar demands;
  @Autowired private ConnectionSyncWorkRepository syncWork;
  @Autowired private ConnectionSyncRoundRepository syncRounds;
  @Autowired private ConnectionSyncRoundDeltaRepository syncDeltas;
  @Autowired private ConnectionObservationRepository observations;
  @Autowired private PlatformTransactionManager transactionManager;

  @AfterEach
  void resetFake() {
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    fake.setSyncGate(null);
  }

  private UUID workId(ConnectedLink link) {
    return jdbc.queryForObject(
        "SELECT id FROM connection_sync_work WHERE connection_id = ?::uuid",
        UUID.class,
        link.connectionId());
  }

  private void demandAndProcess(ConnectedLink link) {
    new TransactionTemplate(transactionManager)
        .execute(
            status -> {
              demands.demand(UUID.fromString(link.connectionId()), Instant.now());
              return null;
            });
    syncService.processOne(workId(link));
  }

  private static PlaidAdapter.ProviderTransaction transaction(
      ConnectedLink link, String transactionId, String description) {
    return new PlaidAdapter.ProviderTransaction(
        link.remoteCheckingId(),
        transactionId,
        null,
        false,
        "USD",
        null,
        new BigDecimal("5.00"),
        LocalDate.of(2026, 9, 9),
        null,
        description,
        null,
        null,
        null,
        null,
        null);
  }

  @Test
  void overLimitRoundFailsVisiblyAndResumesWithoutSkippingRecords() throws Exception {
    Agent owner = signedInAgent("sync-limit");
    String householdId = createHousehold(owner, "Limit home");
    ConnectedLink link = linkAndSelect(owner, householdId, true, false);
    // The initial empty round commits the starting cursor under the low bound.
    demandAndProcess(link);
    String cursorBefore =
        jdbc.queryForObject(
            "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
            String.class,
            link.connectionId());

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

    // Three staged deltas exceed the configured bound of two.
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(
                transaction(link, "tx-limit-1", "Limit one"),
                transaction(link, "tx-limit-2", "Limit two"),
                transaction(link, "tx-limit-3", "Limit three")),
            List.of(),
            "cursor-limit",
            false,
            true));
    syncService.processOne(workId(link));

    assertThat(
            jdbc.queryForMap(
                "SELECT state, last_error FROM connection_sync_work WHERE connection_id = ?::uuid",
                link.connectionId()))
        .containsEntry("state", "FAILED")
        .containsEntry("last_error", "ROUND_LIMIT");
    assertThat(
            jdbc.queryForObject(
                "SELECT sync_state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("FAILED");
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
                "SELECT state, error_code FROM connection_operations WHERE id = ?::uuid",
                operationId))
        .containsEntry("state", "FAILED")
        .containsEntry("error_code", "ROUND_LIMIT");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_sync_rounds"
                    + " WHERE connection_id = ?::uuid AND state = 'STAGING'",
                Integer.class,
                link.connectionId()))
        .isZero();

    // The failure is resumable: a later demand replays from the retained cursor and the records
    // that exceeded the bound are not skipped.
    fake.enqueueSyncPage(
        link.accessToken(),
        new PlaidAdapter.SyncPage(
            List.of(transaction(link, "tx-limit-1", "Limit one")),
            List.of(),
            "cursor-limit-resumed",
            false,
            true));
    demandAndProcess(link);

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_observations WHERE connection_id = ?::uuid",
                Integer.class,
                link.connectionId()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT cursor FROM financial_connections WHERE id = ?::uuid",
                String.class,
                link.connectionId()))
        .isEqualTo("cursor-limit-resumed");
  }
}
