package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.activity.persistence.ConnectionObservationRepository;
import com.housesync.finance.connection.application.ConnectionLifecycleService;
import com.housesync.finance.connection.application.RevocationRetryPolicy;
import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionAccountMappingRepository;
import com.housesync.finance.connection.persistence.ConnectionLinkAttemptRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationIdempotencyRepository;
import com.housesync.finance.connection.persistence.ConnectionOperationRepository;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import com.housesync.finance.connection.plaid.ProviderErrorClass;
import com.housesync.finance.connection.plaid.RemoteAccount;
import com.housesync.household.application.HouseholdService;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;

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
class ConnectedFinanceReviewIT extends ConnectedFinanceITSupport {

  private static final String ORIGINAL_KEYS =
      "test-key-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

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

  @Autowired private FakePlaidAdapter fake;
  @Autowired private ConnectionLifecycleService lifecycle;
  @Autowired private ConnectedFinanceProperties properties;
  @Autowired private FinancialConnectionRepository connectionRepository;
  @Autowired private ConnectionAccountMappingRepository mappingRepository;
  @Autowired private ConnectionObservationRepository observationRepository;
  @Autowired private ConnectionLinkAttemptRepository attemptRepository;
  @Autowired private ConnectionOperationRepository operationRepository;
  @Autowired private ConnectionOperationIdempotencyRepository idempotencyRepository;
  @Autowired private ConnectionRevocationWorkRepository revocationRepository;
  @Autowired private HouseholdService householdService;
  @Autowired private ConnectionCrypto connectionCrypto;
  @Autowired private Clock clock;
  @Autowired private PlatformTransactionManager transactionManager;
  @Autowired private RevocationRetryPolicy retryPolicy;

  @AfterEach
  void resetReviewSeams() {
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    fake.setAccountsFailure(null);
    fake.setExtraAccounts(List.of());
    fake.setRemovalRetryAfterSeconds(-1);
    fake.setRemovalGate(null);
    properties.setEncryptionKeys(ORIGINAL_KEYS);
  }

  @Test
  void connectionListPaginationReportsHasMore() throws Exception {
    Agent owner = signedInAgent("page-conn");
    String householdId = createHousehold(owner, "Paging home");
    for (int i = 0; i < 3; i++) {
      link(owner, householdId);
    }

    JsonNode first =
        owner
            .get("/api/households/" + householdId + "/financial-connections?limit=2&offset=0")
            .json();
    assertThat(first.path("items").size()).isEqualTo(2);
    assertThat(first.path("hasMore").asBoolean()).isTrue();
    assertThat(first.path("limit").asInt()).isEqualTo(2);

    JsonNode second =
        owner
            .get("/api/households/" + householdId + "/financial-connections?limit=2&offset=2")
            .json();
    assertThat(second.path("items").size()).isEqualTo(1);
    assertThat(second.path("hasMore").asBoolean()).isFalse();
  }

  @Test
  void linkUserIdIsOpaqueStableAndOwnerScoped() throws Exception {
    Agent owner = signedInAgent("opaque-user");
    String householdId = createHousehold(owner, "Opaque home");
    Agent other = signedInAgent("opaque-other");
    addMember(householdId, other.userId(), "MEMBER");

    startLink(owner, householdId, UUID.randomUUID());
    String first = fake.lastClientUserId();
    startLink(owner, householdId, UUID.randomUUID());
    String second = fake.lastClientUserId();
    startLink(other, householdId, UUID.randomUUID());
    String foreign = fake.lastClientUserId();

    for (String candidate : List.of(first, second, foreign)) {
      assertThat(candidate).matches("[0-9a-f]{64}");
    }
    assertThat(second).isEqualTo(first);
    assertThat(foreign).isNotEqualTo(first);
    assertThat(first).doesNotContain("@");
    assertThat(first)
        .doesNotContain(owner.userId())
        .doesNotContain(householdId)
        .doesNotContain("opaque");
  }

  @Test
  void rotationMidAttemptStillReplaysAndMixedKeysOperate() throws Exception {
    Agent owner = signedInAgent("rotation");
    String householdId = createHousehold(owner, "Rotation home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();

    fake.setFaultMode(FakePlaidAdapter.FaultMode.TRANSIENT_EXCHANGE);
    UUID key = UUID.randomUUID();
    Resp failed =
        completeLink(
            owner,
            householdId,
            attemptId,
            key,
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(failed.status()).isEqualTo(503);
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);

    properties.setEncryptionKeys(rotatedKeys());
    Resp replayed =
        completeLink(
            owner,
            householdId,
            attemptId,
            key,
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(replayed.status()).isEqualTo(202);
    assertThat(replayed.json().path("state").asText()).isEqualTo("FAILED");

    // Mixed-key operation after rotation: old credential decrypts, new ciphertext encrypts.
    String freshConnection = link(owner, householdId);
    assertThat(
            jdbc.queryForObject(
                "SELECT credential_key_id FROM financial_connections WHERE id = ?::uuid",
                String.class,
                freshConnection))
        .isEqualTo("test-key-2");
  }

  @Test
  void expiredAttemptsAreScrubbedWithoutClientTouch() throws Exception {
    Agent owner = signedInAgent("scrub");
    String householdId = createHousehold(owner, "Scrub home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_link_token FROM connection_link_attempts WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isNotNull();
    jdbc.update(
        "UPDATE connection_link_attempts SET expires_at = NOW() - INTERVAL '1 second'"
            + " WHERE id = ?::uuid",
        attemptId);

    lifecycle.scrubExpiredAttempts();

    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_link_attempts WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isEqualTo("EXPIRED");
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_link_token FROM connection_link_attempts WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isNull();

    Resp completed =
        completeLink(
            owner,
            householdId,
            attemptId,
            UUID.randomUUID(),
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(completed.status()).isEqualTo(409);
    assertThat(completed.json().path("code").asText()).isEqualTo("LINK_ATTEMPT_EXPIRED");
  }

  @Test
  void crashedLeaseIsReclaimedWithFencing() throws Exception {
    Agent owner = signedInAgent("crash");
    String householdId = createHousehold(owner, "Crash home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);

    String workId = openWorkId(connectionId);
    jdbc.update(
        "UPDATE connection_revocation_work SET state = 'IN_PROGRESS', lease_owner = 'dead-worker',"
            + " lease_expires_at = NOW() - INTERVAL '1 second', lease_fence = 5, attempt_count = 1,"
            + " next_retry_at = NOW() - INTERVAL '1 second' WHERE id = ?::uuid",
        workId);

    lifecycle.processOneRevocation(UUID.fromString(workId));

    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("DONE");
    assertThat(
            jdbc.queryForObject(
                "SELECT lease_fence FROM connection_revocation_work WHERE id = ?::uuid",
                Long.class,
                workId))
        .isEqualTo(6L);
    assertThat(
            jdbc.queryForObject(
                "SELECT lease_owner FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isNotEqualTo("dead-worker");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTED");
  }

  @Test
  void concurrentClaimsElectASingleWinner() throws Exception {
    Agent owner = signedInAgent("claim-race");
    String householdId = createHousehold(owner, "Claim home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);
    String workId = openWorkId(connectionId);

    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      CountDownLatch ready = new CountDownLatch(2);
      CountDownLatch go = new CountDownLatch(1);
      Future<?> first =
          pool.submit(
              () -> {
                ready.countDown();
                go.await(30, TimeUnit.SECONDS);
                lifecycle.processOneRevocation(UUID.fromString(workId));
                return null;
              });
      Future<?> second =
          pool.submit(
              () -> {
                ready.countDown();
                go.await(30, TimeUnit.SECONDS);
                lifecycle.processOneRevocation(UUID.fromString(workId));
                return null;
              });
      assertThat(ready.await(30, TimeUnit.SECONDS)).isTrue();
      go.countDown();
      first.get(60, TimeUnit.SECONDS);
      second.get(60, TimeUnit.SECONDS);
    } finally {
      pool.shutdownNow();
    }

    assertThat(
            jdbc.queryForObject(
                "SELECT attempt_count FROM connection_revocation_work WHERE id = ?::uuid",
                Integer.class,
                workId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("DONE");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTED");
  }

  @Test
  void rateLimitedRemovalHonorsRetryAfterAndTransientStaysBounded() throws Exception {
    Agent owner = signedInAgent("retry-after");
    String householdId = createHousehold(owner, "Retry-After home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);
    String workId = openWorkId(connectionId);

    fake.setFaultMode(FakePlaidAdapter.FaultMode.RATE_LIMITED_REMOVAL);
    fake.setRemovalRetryAfterSeconds(120);
    Instant before = Instant.now();
    lifecycle.processOneRevocation(UUID.fromString(workId));
    Instant after = Instant.now();

    Instant nextRetry =
        jdbc.queryForObject(
                "SELECT next_retry_at FROM connection_revocation_work WHERE id = ?::uuid",
                java.time.OffsetDateTime.class,
                workId)
            .toInstant();
    assertThat(nextRetry).isAfterOrEqualTo(before.plusSeconds(119));
    assertThat(nextRetry).isBeforeOrEqualTo(after.plusSeconds(125));
    assertThat(
            jdbc.queryForObject(
                "SELECT last_error FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("RATE_LIMITED");

    fake.setFaultMode(FakePlaidAdapter.FaultMode.TRANSIENT_REMOVAL);
    jdbc.update(
        "UPDATE connection_revocation_work SET next_retry_at = NOW() WHERE id = ?::uuid", workId);
    Instant retryBefore = Instant.now();
    lifecycle.processOneRevocation(UUID.fromString(workId));
    Instant retryNext =
        jdbc.queryForObject(
                "SELECT next_retry_at FROM connection_revocation_work WHERE id = ?::uuid",
                java.time.OffsetDateTime.class,
                workId)
            .toInstant();
    assertThat(retryNext).isBeforeOrEqualTo(retryBefore.plusSeconds(30));
  }

  @Test
  void terminalFailureCapsRetriesThenOwnerRequeueRecovers() throws Exception {
    Agent owner = signedInAgent("cap");
    String householdId = createHousehold(owner, "Cap home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);
    String workId = openWorkId(connectionId);

    fake.setFaultMode(FakePlaidAdapter.FaultMode.TRANSIENT_REMOVAL);
    for (int i = 0; i < 6; i++) {
      jdbc.update(
          "UPDATE connection_revocation_work SET next_retry_at = NOW() WHERE id = ?::uuid", workId);
      lifecycle.processOneRevocation(UUID.fromString(workId));
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("FAILED");
    assertThat(
            jdbc.queryForObject(
                "SELECT attempt_count FROM connection_revocation_work WHERE id = ?::uuid",
                Integer.class,
                workId))
        .isEqualTo(6);

    int version =
        owner
            .get("/api/households/" + householdId + "/financial-connections/" + connectionId)
            .json()
            .path("version")
            .asInt();
    Resp retried =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/disconnect",
            "{\"expectedVersion\":" + version + "}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(retried.status()).isEqualTo(202);
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
        .isZero();

    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    lifecycle.processOneRevocation(UUID.fromString(workId));
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTED");
  }

  @Test
  void malformedRuntimeKeysFailClosedWithoutRawLeaks() throws Exception {
    Agent owner = signedInAgent("badkeys");
    String householdId = createHousehold(owner, "Bad keys home");

    properties.setEncryptionKeys("no-colon-here");
    Resp start =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/connection-link-attempts",
            "{}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(start.status()).isEqualTo(500);
    assertThat(start.json().path("code").asText()).isEqualTo("INTERNAL_ERROR");
    assertThat(start.body())
        .doesNotContain("StringIndexOutOfBounds", "base64", "IllegalArgument", "ArrayIndex");
  }

  @Test
  void unsupportedAccountsKeepNullClassificationAndRefuseSelection() throws Exception {
    Agent owner = signedInAgent("unsupported");
    String householdId = createHousehold(owner, "Unsupported home");

    fake.setExtraAccounts(
        List.of(
            new RemoteAccount("fake-remote-loan-x", "Fake Loan", "UNSUPPORTED", "USD"),
            new RemoteAccount("fake-remote-odd-x", "Fake Odd", "CHECKING", "XX")));
    String connectionId = link(owner, householdId);

    JsonNode mappings =
        owner
            .get(
                "/api/households/"
                    + householdId
                    + "/financial-connections/"
                    + connectionId
                    + "/accounts")
            .json();
    assertThat(mappings.path("items").size()).isEqualTo(4);
    JsonNode loan = null;
    JsonNode odd = null;
    for (JsonNode item : mappings.path("items")) {
      if ("Fake Loan".equals(item.path("name").asText())) {
        loan = item;
      }
      if ("Fake Odd".equals(item.path("name").asText())) {
        odd = item;
      }
    }
    assertThat(loan).isNotNull();
    assertThat(odd).isNotNull();
    assertThat(loan.path("eligible").asBoolean()).isFalse();
    assertThat(loan.path("kind").isNull()).isTrue();
    assertThat(loan.path("exclusionReason").asText()).isEqualTo("UNSUPPORTED_KIND");
    assertThat(odd.path("eligible").asBoolean()).isFalse();
    assertThat(odd.path("currency").isNull()).isTrue();
    assertThat(odd.path("exclusionReason").asText()).isEqualTo("UNSUPPORTED_CURRENCY");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_connection_account_mappings"
                    + " WHERE connection_id = ?::uuid AND kind IS NULL",
                Integer.class,
                connectionId))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_connection_account_mappings"
                    + " WHERE connection_id = ?::uuid AND currency IS NULL",
                Integer.class,
                connectionId))
        .isEqualTo(1);

    Resp selected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":0,\"accountMappingIds\":[\""
                + loan.path("mappingId").asText()
                + "\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(selected.status()).isEqualTo(400);

    try {
      jdbc.update(
          "INSERT INTO financial_connection_account_mappings (id, connection_id, household_id,"
              + " owner_user_id, remote_account_digest, display_name, kind, currency, selected,"
              + " eligible, created_at, updated_at) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid,"
              + " 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'Cash',"
              + " 'CASH', 'USD', FALSE, FALSE, NOW(), NOW())",
          UUID.randomUUID().toString(),
          connectionId,
          householdId,
          owner.userId());
      assertThat(false).as("CASH mapping kind must violate the narrowed check").isTrue();
    } catch (org.springframework.dao.DataIntegrityViolationException expected) {
      assertThat(expected.getMessage()).isNotNull();
    }
  }

  @Test
  void exhaustedVersionMapsToConflictOnReconnectAndDisconnect() throws Exception {
    Agent owner = signedInAgent("exhausted-conn");
    String householdId = createHousehold(owner, "Exhausted home");
    String connectionId = link(owner, householdId);
    jdbc.update(
        "UPDATE financial_connections SET version = 2147483647 WHERE id = ?::uuid", connectionId);

    Resp reconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":2147483647}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(reconnected.status()).isEqualTo(409);
    assertThat(reconnected.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");

    Resp disconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/disconnect",
            "{\"expectedVersion\":2147483647}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(disconnected.status()).isEqualTo(409);
    assertThat(disconnected.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
  }

  @Test
  void consentRevokedRecoverySuspendsAndQueuesCleanup() throws Exception {
    Agent owner = signedInAgent("consent");
    String householdId = createHousehold(owner, "Consent home");
    String connectionId = linkAndSelect(owner, householdId);

    Resp reconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    String attemptId = reconnected.json().path("id").asText();

    fake.setAccountsFailure(ProviderErrorClass.CONSENT_REVOKED);
    Resp completed = completeLink(owner, householdId, attemptId, UUID.randomUUID(), "{}");
    assertThat(completed.status()).isEqualTo(409);
    assertThat(completed.json().path("code").asText()).isEqualTo("CONNECTION_DISCONNECTED");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_operations WHERE attempt_id = ?::uuid",
                String.class,
                attemptId))
        .isEqualTo("FAILED");
    assertThat(
            jdbc.queryForObject(
                "SELECT error_code FROM connection_operations WHERE attempt_id = ?::uuid",
                String.class,
                attemptId))
        .isEqualTo("CONSENT_REVOKED");

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
        .isEqualTo(2L);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_revocation_work"
                    + " WHERE connection_id = ?::uuid AND state = 'QUEUED'",
                Integer.class,
                connectionId))
        .isEqualTo(1);
  }

  @Test
  void permanentRecoveryFailureSuspendsInsteadOfStayingActive() throws Exception {
    Agent owner = signedInAgent("gone-item");
    String householdId = createHousehold(owner, "Gone home");
    String connectionId = linkAndSelect(owner, householdId);

    Resp reconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    String attemptId = reconnected.json().path("id").asText();

    fake.setAccountsFailure(ProviderErrorClass.PERMANENT);
    Resp completed = completeLink(owner, householdId, attemptId, UUID.randomUUID(), "{}");
    assertThat(completed.status()).isEqualTo(409);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("SUSPENDED");
  }

  @Test
  void ambiguousRemovalLaterConfirmFlipsOperationToSuccess() throws Exception {
    Agent owner = signedInAgent("amb-confirm");
    String householdId = createHousehold(owner, "Ambiguous confirm home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);
    String workId = openWorkId(connectionId);
    String operationId =
        jdbc.queryForObject(
            "SELECT id FROM connection_operations WHERE connection_id = ?::uuid"
                + " AND operation_type = 'DISCONNECT'",
            String.class,
            connectionId);

    fake.setFaultMode(FakePlaidAdapter.FaultMode.AMBIGUOUS_REMOVAL);
    lifecycle.processOneRevocation(UUID.fromString(workId));
    assertThat(operationState(operationId)).isEqualTo("OUTCOME_UNKNOWN");

    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    jdbc.update(
        "UPDATE connection_revocation_work SET next_retry_at = NOW() WHERE id = ?::uuid", workId);
    lifecycle.processOneRevocation(UUID.fromString(workId));

    assertThat(operationState(operationId)).isEqualTo("SUCCEEDED");
    Resp polled =
        owner.get("/api/households/" + householdId + "/connection-operations/" + operationId);
    assertThat(polled.status()).isEqualTo(200);
    assertThat(polled.json().path("state").asText()).isEqualTo("SUCCEEDED");
  }

  @Test
  void ambiguousRemovalBudgetCapsThenOwnerRequeueRecovers() throws Exception {
    Agent owner = signedInAgent("amb-cap");
    String householdId = createHousehold(owner, "Ambiguous cap home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);
    String workId = openWorkId(connectionId);

    fake.setFaultMode(FakePlaidAdapter.FaultMode.AMBIGUOUS_REMOVAL);
    for (int i = 0; i < 6; i++) {
      jdbc.update(
          "UPDATE connection_revocation_work SET next_retry_at = NOW() WHERE id = ?::uuid", workId);
      lifecycle.processOneRevocation(UUID.fromString(workId));
    }
    assertThat(workState(workId)).isEqualTo("FAILED");
    assertThat(
            jdbc.queryForObject(
                "SELECT attempt_count FROM connection_revocation_work WHERE id = ?::uuid",
                Integer.class,
                workId))
        .isEqualTo(6);
    assertThat(
            jdbc.queryForObject(
                "SELECT last_error FROM connection_revocation_work WHERE id = ?::uuid",
                String.class,
                workId))
        .isEqualTo("REMOVAL_UNKNOWN");
    // The credential is retained for explicit recovery, never erased on ambiguity.
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_credential FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isNotNull();

    int version = connectionVersion(owner, householdId, connectionId);
    Resp retried =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/disconnect",
            "{\"expectedVersion\":" + version + "}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(retried.status()).isEqualTo(202);
    assertThat(workState(workId)).isEqualTo("QUEUED");

    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
    lifecycle.processOneRevocation(UUID.fromString(workId));
    assertThat(connectionState(connectionId)).isEqualTo("DISCONNECTED");
  }

  @Test
  void legacyNullLeaseWorkIsReclaimable() throws Exception {
    Agent owner = signedInAgent("legacy");
    String householdId = createHousehold(owner, "Legacy home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);
    String workId = openWorkId(connectionId);

    jdbc.update(
        "UPDATE connection_revocation_work SET state = 'IN_PROGRESS', lease_owner = 'legacy',"
            + " lease_expires_at = NULL, lease_fence = 0, attempt_count = 0"
            + " WHERE id = ?::uuid",
        workId);
    lifecycle.processOneRevocation(UUID.fromString(workId));

    assertThat(workState(workId)).isEqualTo("DONE");
    assertThat(connectionState(connectionId)).isEqualTo("DISCONNECTED");
  }

  @Test
  void providerTokenExpiryAloneTriggersScrub() throws Exception {
    Agent owner = signedInAgent("token-expiry");
    String householdId = createHousehold(owner, "Token expiry home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();
    jdbc.update(
        "UPDATE connection_link_attempts SET expires_at = NOW() + INTERVAL '1 hour',"
            + " link_token_expires_at = NOW() - INTERVAL '1 second' WHERE id = ?::uuid",
        attemptId);

    lifecycle.scrubExpiredAttempts();

    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_link_attempts WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isEqualTo("EXPIRED");
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_link_token FROM connection_link_attempts WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isNull();
  }

  @Test
  void staleLoserCannotCommitOverReclaimingWorker() throws Exception {
    Agent owner = signedInAgent("stale");
    String householdId = createHousehold(owner, "Stale home");
    String connectionId = linkAndSelect(owner, householdId);
    disconnect(owner, householdId, connectionId, 1);
    String workId = openWorkId(connectionId);
    String operationId =
        jdbc.queryForObject(
            "SELECT id FROM connection_operations WHERE connection_id = ?::uuid"
                + " AND operation_type = 'DISCONNECT'",
            String.class,
            connectionId);

    ConnectionLifecycleService workerB =
        new ConnectionLifecycleService(
            properties,
            connectionRepository,
            mappingRepository,
            observationRepository,
            attemptRepository,
            operationRepository,
            idempotencyRepository,
            revocationRepository,
            householdService,
            connectionCrypto,
            fake,
            clock,
            transactionManager,
            retryPolicy,
            "test-worker-B");

    CountDownLatch gate = new CountDownLatch(1);
    fake.setFaultMode(FakePlaidAdapter.FaultMode.BLOCK_REMOVAL);
    fake.setRemovalGate(gate);
    ExecutorService pool = Executors.newSingleThreadExecutor();
    Future<?> stale;
    try {
      stale =
          pool.submit(
              () -> {
                lifecycle.processOneRevocation(UUID.fromString(workId));
                return null;
              });
      assertThat(waitForWorkState(workId, "IN_PROGRESS", java.time.Duration.ofSeconds(30)))
          .isTrue();
      long staleFence = workFence(workId);

      // The stale holder's lease lapses; worker B reclaims and confirms removal.
      jdbc.update(
          "UPDATE connection_revocation_work SET lease_expires_at = NOW() - INTERVAL '1 second'"
              + " WHERE id = ?::uuid",
          workId);
      fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);
      workerB.processOneRevocation(UUID.fromString(workId));
      assertThat(workState(workId)).isEqualTo("DONE");
      assertThat(workFence(workId)).isEqualTo(staleFence + 1);
      assertThat(workOwner(workId)).isEqualTo("test-worker-B");

      // The stale holder's late commit must abort without clobbering the winner.
      gate.countDown();
      stale.get(60, TimeUnit.SECONDS);
      assertThat(workState(workId)).isEqualTo("DONE");
      assertThat(workFence(workId)).isEqualTo(staleFence + 1);
      assertThat(workOwner(workId)).isEqualTo("test-worker-B");
      assertThat(connectionState(connectionId)).isEqualTo("DISCONNECTED");
      assertThat(operationState(operationId)).isEqualTo("SUCCEEDED");
    } finally {
      gate.countDown();
      pool.shutdownNow();
    }
  }

  @Test
  void exhaustedVersionInRecoveryTransitionLeavesDurableFailure() throws Exception {
    Agent owner = signedInAgent("exhaust-rec");
    String householdId = createHousehold(owner, "Exhausted recovery home");
    String connectionId = linkAndSelect(owner, householdId);

    Resp reconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":1}",
            owner.csrfToken,
            UUID.randomUUID());
    String attemptId = reconnected.json().path("id").asText();
    jdbc.update(
        "UPDATE financial_connections SET version = 2147483647 WHERE id = ?::uuid", connectionId);

    fake.setAccountsFailure(ProviderErrorClass.REAUTH_REQUIRED);
    Resp completed = completeLink(owner, householdId, attemptId, UUID.randomUUID(), "{}");
    assertThat(completed.status()).isEqualTo(409);
    assertThat(completed.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    assertThat(attemptState(attemptId)).isEqualTo("FAILED");
    assertThat(
            jdbc.queryForObject(
                "SELECT error_code FROM connection_link_attempts WHERE id = ?::uuid",
                String.class,
                attemptId))
        .isEqualTo("VERSION_EXHAUSTED");
    // No strand: the operation carries the terminal failure and the state is untouched.
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM connection_operations WHERE attempt_id = ?::uuid",
                String.class,
                attemptId))
        .isEqualTo("FAILED");
    assertThat(connectionState(connectionId)).isEqualTo("ACTIVE");
  }

  @Test
  void retiredHmacKeyReplayMapsToSafeConflict() throws Exception {
    Agent owner = signedInAgent("retired");
    String householdId = createHousehold(owner, "Retired key home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    String attemptId = started.json().path("id").asText();
    fake.setFaultMode(FakePlaidAdapter.FaultMode.TRANSIENT_EXCHANGE);
    UUID key = UUID.randomUUID();
    Resp failed =
        completeLink(
            owner,
            householdId,
            attemptId,
            key,
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(failed.status()).isEqualTo(503);
    fake.setFaultMode(FakePlaidAdapter.FaultMode.NONE);

    properties.setEncryptionKeys(keyTwoOnly());
    Resp conflicted =
        completeLink(
            owner,
            householdId,
            attemptId,
            key,
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(conflicted.status()).isEqualTo(409);
    assertThat(conflicted.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
  }

  private String link(Agent agent, String householdId) throws Exception {
    Resp started = startLink(agent, householdId, UUID.randomUUID());
    assertThat(started.status()).isEqualTo(201);
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
    assertThat(completed.json().path("state").asText()).isEqualTo("SUCCEEDED");
    return completed.json().path("connectionId").asText();
  }

  private String linkAndSelect(Agent agent, String householdId) throws Exception {
    String connectionId = link(agent, householdId);
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

  private void disconnect(Agent agent, String householdId, String connectionId, int version)
      throws Exception {
    Resp response =
        agent.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/disconnect",
            "{\"expectedVersion\":" + version + "}",
            agent.csrfToken,
            UUID.randomUUID());
    assertThat(response.status()).isEqualTo(202);
  }

  private String openWorkId(String connectionId) {
    return jdbc.queryForObject(
        "SELECT id FROM connection_revocation_work WHERE connection_id = ?::uuid"
            + " AND state = 'QUEUED'",
        String.class,
        connectionId);
  }

  private static String rotatedKeys() {
    return "test-key-2:" + keyTwoRaw() + ",test-key-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  }

  private static String keyTwoOnly() {
    return "test-key-2:" + keyTwoRaw();
  }

  private static String keyTwoRaw() {
    byte[] raw = new byte[32];
    for (int i = 0; i < raw.length; i++) {
      raw[i] = (byte) (100 + i);
    }
    return Base64.getEncoder().encodeToString(raw);
  }

  private String operationState(String operationId) {
    return jdbc.queryForObject(
        "SELECT state FROM connection_operations WHERE id = ?::uuid", String.class, operationId);
  }

  private String workState(String workId) {
    return jdbc.queryForObject(
        "SELECT state FROM connection_revocation_work WHERE id = ?::uuid", String.class, workId);
  }

  private long workFence(String workId) {
    return jdbc.queryForObject(
        "SELECT lease_fence FROM connection_revocation_work WHERE id = ?::uuid",
        Long.class,
        workId);
  }

  private String workOwner(String workId) {
    return jdbc.queryForObject(
        "SELECT lease_owner FROM connection_revocation_work WHERE id = ?::uuid",
        String.class,
        workId);
  }

  private String connectionState(String connectionId) {
    return jdbc.queryForObject(
        "SELECT state FROM financial_connections WHERE id = ?::uuid", String.class, connectionId);
  }

  private String attemptState(String attemptId) {
    return jdbc.queryForObject(
        "SELECT state FROM connection_link_attempts WHERE id = ?::uuid", String.class, attemptId);
  }

  private int connectionVersion(Agent agent, String householdId, String connectionId)
      throws Exception {
    return agent
        .get("/api/households/" + householdId + "/financial-connections/" + connectionId)
        .json()
        .path("version")
        .asInt();
  }

  private boolean waitForWorkState(String workId, String state, java.time.Duration timeout)
      throws Exception {
    Instant deadline = Instant.now().plus(timeout);
    while (Instant.now().isBefore(deadline)) {
      if (state.equals(workState(workId))) {
        return true;
      }
      Thread.sleep(50);
    }
    return state.equals(workState(workId));
  }
}
