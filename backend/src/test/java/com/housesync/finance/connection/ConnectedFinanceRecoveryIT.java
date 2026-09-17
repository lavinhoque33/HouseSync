package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.connection.application.ConnectionLifecycleService;
import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import java.util.List;
import java.util.UUID;
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
class ConnectedFinanceRecoveryIT extends ConnectedFinanceITSupport {

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
  @Autowired private ConnectionLifecycleService lifecycle;

  @AfterEach
  void resetFake() {
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
  }

  @Test
  void ambiguousExchangeStaysUnknownWithoutBlindRetry() throws Exception {
    Agent owner = signedInAgent("ambiguous");
    String householdId = createHousehold(owner, "Ambiguous home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();

    fake.setFaultMode(FakePlaidAdapter.FaultMode.AMBIGUOUS_EXCHANGE);
    UUID key = UUID.randomUUID();
    Resp completed =
        completeLink(
            owner,
            householdId,
            attemptId,
            key,
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(completed.status()).isEqualTo(202);
    assertThat(completed.json().path("state").asText()).isEqualTo("OUTCOME_UNKNOWN");
    assertThat(completed.json().path("errorCode").asText()).isEqualTo("EXCHANGE_UNKNOWN");
    assertThat(completed.json().path("connectionId").isNull()).isTrue();
    String operationId = completed.json().path("id").asText();

    // Transient tokens are erased on the terminal unknown outcome.
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_public_token FROM connection_link_attempts"
                    + " WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isNull();
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_link_token FROM connection_link_attempts WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isNull();

    // Same-key retry returns the persisted unknown operation instead of re-exchanging.
    Resp retry =
        completeLink(
            owner,
            householdId,
            attemptId,
            key,
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(retry.status()).isEqualTo(202);
    assertThat(retry.json().path("id").asText()).isEqualTo(operationId);
    assertThat(retry.json().path("state").asText()).isEqualTo("OUTCOME_UNKNOWN");
  }

  @Test
  void transientExchangeFailsDurablyAndVisibly() throws Exception {
    Agent owner = signedInAgent("transient");
    String householdId = createHousehold(owner, "Transient home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();

    fake.setFaultMode(FakePlaidAdapter.FaultMode.TRANSIENT_EXCHANGE);
    Resp completed =
        completeLink(
            owner,
            householdId,
            attemptId,
            UUID.randomUUID(),
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(completed.status()).isEqualTo(503);
    assertThat(completed.json().path("code").asText()).isEqualTo("FINANCE_BUSY");
  }

  @Test
  void ambiguousRemovalStaysRetryableThenConfirms() throws Exception {
    Agent owner = signedInAgent("removal");
    String householdId = createHousehold(owner, "Removal home");

    String connectionId = linkAndSelect(owner, householdId);
    Resp disconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/disconnect",
            "{\"expectedVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    String operationId = disconnected.json().path("id").asText();

    fake.setFaultMode(FakePlaidAdapter.FaultMode.AMBIGUOUS_REMOVAL);
    String workId =
        jdbc.queryForObject(
            "SELECT id FROM connection_revocation_work WHERE connection_id = ?::uuid",
            String.class,
            connectionId);
    lifecycle.processOneRevocation(UUID.fromString(workId));

    // Credentials are retained and the operation reports the unknown outcome visibly.
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("QUEUED");
    assertThat(
            jdbc.queryForObject(
                "SELECT last_error FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("REMOVAL_UNKNOWN");
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_credential FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isNotNull();
    Resp polled =
        owner.get("/api/households/" + householdId + "/connection-operations/" + operationId);
    assertThat(polled.json().path("state").asText()).isEqualTo("OUTCOME_UNKNOWN");

    // Recovery without membership loss: the same durable work confirms removal.
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    jdbc.update(
        "UPDATE connection_revocation_work SET next_retry_at = NOW() WHERE id = ?::uuid", workId);
    lifecycle.processOneRevocation(UUID.fromString(workId));
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTED");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("DONE");
  }

  @Test
  void transientRemovalRetriesWithBackoff() throws Exception {
    Agent owner = signedInAgent("retry");
    String householdId = createHousehold(owner, "Retry home");

    String connectionId = linkAndSelect(owner, householdId);
    owner.request(
        "POST",
        "/api/households/" + householdId + "/financial-connections/" + connectionId + "/disconnect",
        "{\"expectedVersion\":1}",
        owner.csrfToken,
        UUID.randomUUID());

    fake.setFaultMode(FakePlaidAdapter.FaultMode.TRANSIENT_REMOVAL);
    String workId =
        jdbc.queryForObject(
            "SELECT id FROM connection_revocation_work WHERE connection_id = ?::uuid",
            String.class,
            connectionId);
    lifecycle.processOneRevocation(UUID.fromString(workId));
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("QUEUED");
    assertThat(
            jdbc.queryForObject(
                "SELECT attempt_count FROM connection_revocation_work WHERE id = ?::uuid",
                Integer.class,
                workId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTING");
  }

  @Test
  void membershipLossSuspendsQueuesRevocationAndHides() throws Exception {
    Agent owner = signedInAgent("owner-loss");
    String householdId = createHousehold(owner, "Loss home");
    Agent member = signedInAgent("member-loss");
    addMember(householdId, member.userId(), "MEMBER");

    String connectionId = linkAndSelect(member, householdId);

    // Same-household other owner cannot inspect the private connection.
    for (Resp hidden :
        List.of(
            owner.get("/api/households/" + householdId + "/financial-connections/" + connectionId),
            owner.get(
                "/api/households/"
                    + householdId
                    + "/financial-connections/"
                    + connectionId
                    + "/accounts"))) {
      assertThat(hidden.status()).isEqualTo(404);
      assertThat(hidden.json().path("code").asText()).isEqualTo("FINANCIAL_CONNECTION_NOT_FOUND");
      assertThat(hidden.body()).doesNotContain(connectionId);
    }

    // Removal suspends with fencing and queues revocation in the lifecycle transaction.
    Resp removed =
        owner.raw(
            "DELETE",
            "/api/households/" + householdId + "/members/" + member.userId(),
            null,
            owner.csrfToken,
            null,
            null);
    assertThat(removed.status()).isEqualTo(204);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("SUSPENDED");
    assertThat(
            jdbc.queryForObject(
                "SELECT generation FROM financial_connections WHERE id = ?::uuid",
                Long.class,
                connectionId))
        .isEqualTo(1L);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_revocation_work"
                    + " WHERE connection_id = ?::uuid AND state = 'QUEUED'",
                Integer.class,
                connectionId))
        .isEqualTo(1);

    // Former member reads collapse to 404 without existence disclosure.
    Resp formerRead =
        member.get("/api/households/" + householdId + "/financial-connections/" + connectionId);
    assertThat(formerRead.status()).isEqualTo(404);

    // The worker needs no membership to finish remote cleanup.
    String workId =
        jdbc.queryForObject(
            "SELECT id FROM connection_revocation_work WHERE connection_id = ?::uuid",
            String.class,
            connectionId);
    lifecycle.processOneRevocation(UUID.fromString(workId));
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTED");

    // Rejoining restores ledger access, never bank consent.
    addMember(householdId, member.userId(), "MEMBER");
    int currentVersion =
        member
            .get("/api/households/" + householdId + "/financial-connections/" + connectionId)
            .json()
            .path("version")
            .asInt();
    Resp relinked =
        member.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":" + currentVersion + "}",
            member.csrfToken,
            UUID.randomUUID());
    assertThat(relinked.status()).isEqualTo(409);
    assertThat(relinked.json().path("code").asText()).isEqualTo("CONNECTION_DISCONNECTED");
  }

  @Test
  void leaveSuspendsOwnConnections() throws Exception {
    Agent first = signedInAgent("leave-first");
    String householdId = createHousehold(first, "Leave home");
    Agent second = signedInAgent("leave-second");
    addMember(householdId, second.userId(), "OWNER");

    String connectionId = linkAndSelect(first, householdId);
    Resp left =
        first.raw(
            "POST", "/api/households/" + householdId + "/leave", null, first.csrfToken, null, null);
    assertThat(left.status()).isEqualTo(204);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("SUSPENDED");
  }

  private String linkAndSelect(Agent agent, String householdId) throws Exception {
    Resp started = startLink(agent, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();
    Resp completed =
        completeLink(
            agent,
            householdId,
            attemptId,
            UUID.randomUUID(),
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(completed.status()).isEqualTo(202);
    String connectionId = completed.json().path("connectionId").asText();
    String mappingId =
        agent
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
    Resp selected =
        agent.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":0,\"accountMappingIds\":[\"" + mappingId + "\"]}",
            agent.csrfToken,
            UUID.randomUUID());
    assertThat(selected.status()).isEqualTo(200);
    return connectionId;
  }
}
