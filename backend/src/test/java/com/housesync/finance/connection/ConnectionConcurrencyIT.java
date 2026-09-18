package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
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
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      "app.auth.ip-max-attempts=1000",
      "app.connected-finance.enabled=true",
      "app.connected-finance.provider=fake",
      "app.connected-finance.fake-allowed=true",
      "app.connected-finance.encryption-keys=test-key-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      "app.connected-finance.revocation-poll-ms=3600000"
    })
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class ConnectionConcurrencyIT extends ConnectedFinanceITSupport {

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

  @AfterEach
  void resetFake() {
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
  }

  @Test
  void concurrentLinkStartUnderOneKeyCreatesOneAttempt() throws Exception {
    Agent owner = signedInAgent("race-start");
    String householdId = createHousehold(owner, "Race home");
    UUID key = UUID.randomUUID();

    List<Resp> responses = race(8, () -> startLink(owner, householdId, key));
    for (Resp response : responses) {
      assertThat(response.status()).as(response.body()).isIn(200, 201, 503);
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_operation_idempotency_keys"
                    + " WHERE idempotency_key = ?::uuid AND operation = 'LINK_START'",
                Integer.class,
                key.toString()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(DISTINCT resource_id) FROM"
                    + " connection_operation_idempotency_keys"
                    + " WHERE idempotency_key = ?::uuid AND operation = 'LINK_START'",
                Integer.class,
                key.toString()))
        .isEqualTo(1);
  }

  /**
   * Deterministic reproduction of the reserved-attempt window: the winning starter is held inside
   * the provider Link-token call after its durable key reservation commits. A same-key starter that
   * arrives in that window must converge on an allowed replay/retryable outcome, never a version or
   * idempotency conflict, and the one-attempt/one-resource invariants must hold.
   */
  @Test
  void concurrentLinkStartConvergesWhileTheWinningTokenIsInFlight() throws Exception {
    Agent owner = signedInAgent("race-start-window");
    String householdId = createHousehold(owner, "Race window home");
    UUID key = UUID.randomUUID();

    CountDownLatch gate = new CountDownLatch(1);
    fake.setLinkTokenGate(gate);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<Resp> winner = pool.submit(() -> startLink(owner, householdId, key));
      long deadline = System.currentTimeMillis() + 15_000;
      while (System.currentTimeMillis() < deadline
          && jdbc.queryForObject(
                  "SELECT COUNT(*) FROM connection_operation_idempotency_keys"
                      + " WHERE idempotency_key = ?::uuid AND operation = 'LINK_START'",
                  Integer.class,
                  key.toString())
              == 0) {
        Thread.sleep(25);
      }
      // The winner holds the reservation and is blocked before attaching the token.
      Resp racing = startLink(owner, householdId, key);
      gate.countDown();
      Resp winnerResponse = winner.get(30, TimeUnit.SECONDS);

      assertThat(racing.status()).as(racing.body()).isIn(200, 503);
      assertThat(winnerResponse.status()).as(winnerResponse.body()).isIn(201, 200, 503);
    } finally {
      gate.countDown();
      pool.shutdownNow();
    }

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_operation_idempotency_keys"
                    + " WHERE idempotency_key = ?::uuid AND operation = 'LINK_START'",
                Integer.class,
                key.toString()))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(DISTINCT resource_id) FROM"
                    + " connection_operation_idempotency_keys"
                    + " WHERE idempotency_key = ?::uuid AND operation = 'LINK_START'",
                Integer.class,
                key.toString()))
        .isEqualTo(1);
  }

  @Test
  void concurrentCompletionUnderOneKeyCreatesOneOperation() throws Exception {
    Agent owner = signedInAgent("race-complete");
    String householdId = createHousehold(owner, "Race complete home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();
    String body =
        "{\"publicToken\":\"" + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId)) + "\"}";
    UUID key = UUID.randomUUID();

    List<Resp> responses = race(8, () -> completeLink(owner, householdId, attemptId, key, body));
    for (Resp response : responses) {
      assertThat(response.status()).isIn(202, 503);
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_operations WHERE attempt_id = ?::uuid",
                Integer.class,
                attemptId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_connections"
                    + " WHERE household_id = ?::uuid AND owner_user_id = ?::uuid",
                Integer.class,
                householdId,
                owner.userId()))
        .isEqualTo(1);
  }

  @Test
  void concurrentSelectionUnderOneKeyBumpsVersionOnce() throws Exception {
    Agent owner = signedInAgent("race-select");
    String householdId = createHousehold(owner, "Race select home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();
    Resp completed =
        completeLink(
            owner,
            householdId,
            attemptId,
            UUID.randomUUID(),
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    String connectionId = completed.json().path("connectionId").asText();
    String mappingId =
        owner
            .get(
                "/api/households/"
                    + householdId
                    + "/financial-connections/"
                    + connectionId
                    + "/accounts")
            .json()
            .path("items")
            .get(0)
            .path("mappingId")
            .asText();
    UUID key = UUID.randomUUID();
    String body = "{\"expectedVersion\":0,\"accountMappingIds\":[\"" + mappingId + "\"]}";

    List<Resp> responses =
        race(
            8,
            () ->
                owner.request(
                    "POST",
                    "/api/households/"
                        + householdId
                        + "/financial-connections/"
                        + connectionId
                        + "/account-selection",
                    body,
                    owner.csrfToken,
                    key));
    for (Resp response : responses) {
      assertThat(response.status()).isIn(200, 409, 503);
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_connections WHERE id = ?::uuid",
                Integer.class,
                connectionId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid"
                    + " AND source = 'CONNECTED'",
                Integer.class,
                householdId))
        .isEqualTo(1);
  }

  private List<Resp> race(int threads, Callable<Resp> task) throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    try {
      List<Future<Resp>> futures = new ArrayList<>();
      for (int i = 0; i < threads; i++) {
        futures.add(pool.submit(task));
      }
      List<Resp> responses = new ArrayList<>();
      for (Future<Resp> future : futures) {
        responses.add(future.get(60, TimeUnit.SECONDS));
      }
      return responses;
    } finally {
      pool.shutdownNow();
    }
  }
}
