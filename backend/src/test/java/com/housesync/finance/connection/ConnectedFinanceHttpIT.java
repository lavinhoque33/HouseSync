package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.connection.application.ConnectionLifecycleService;
import com.housesync.finance.connection.plaid.FakePlaidAdapter;
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
class ConnectedFinanceHttpIT extends ConnectedFinanceITSupport {

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
  void fullLinkSelectReconnectDisconnectLifecycle() throws Exception {
    Agent owner = signedInAgent("connected");
    String householdId = createHousehold(owner, "Connected home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    assertThat(started.status()).isEqualTo(201);
    JsonNode attempt = started.json();
    assertThat(attempt.propertyNames())
        .containsExactlyInAnyOrder(
            "id", "flow", "provider", "connectionId", "linkToken", "expiresAt");
    assertThat(attempt.path("flow").asText()).isEqualTo("NEW");
    assertThat(attempt.path("provider").asText()).isEqualTo("PLAID");
    assertThat(attempt.path("connectionId").isNull()).isTrue();
    assertThat(attempt.path("linkToken").asText()).startsWith("fake-link-");
    assertThat(started.cacheControl()).contains("no-store");
    String attemptId = attempt.path("id").asText();

    Resp replayedStart = startLink(owner, householdId, UUID.fromString(keyOf(started, attemptId)));
    assertThat(replayedStart.status()).isEqualTo(200);
    assertThat(replayedStart.json().path("id").asText()).isEqualTo(attemptId);
    assertThat(replayedStart.json().path("linkToken").asText())
        .isEqualTo(attempt.path("linkToken").asText());

    Resp missingToken = completeLink(owner, householdId, attemptId, UUID.randomUUID(), "{}");
    assertThat(missingToken.status()).isEqualTo(400);

    String publicToken = FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId));
    UUID completeKey = UUID.randomUUID();
    Resp completed =
        completeLink(
            owner,
            householdId,
            attemptId,
            completeKey,
            "{\"publicToken\":\"" + publicToken + "\"}");
    assertThat(completed.status()).isEqualTo(202);
    JsonNode operation = completed.json();
    assertThat(operation.path("operationType").asText()).isEqualTo("LINK_COMPLETE");
    assertThat(operation.path("state").asText()).isEqualTo("SUCCEEDED");
    assertThat(operation.path("errorCode").isNull()).isTrue();
    assertThat(operation.path("statusUrl").asText())
        .isEqualTo(
            "/api/households/"
                + householdId
                + "/connection-operations/"
                + operation.path("id").asText());
    String operationId = operation.path("id").asText();
    String connectionId = operation.path("connectionId").asText();
    assertThat(completed.cacheControl()).contains("no-store");

    // Retry with the same key returns the persisted operation, never a second exchange.
    Resp replayedComplete =
        completeLink(
            owner,
            householdId,
            attemptId,
            completeKey,
            "{\"publicToken\":\"" + publicToken + "\"}");
    assertThat(replayedComplete.status()).isEqualTo(202);
    assertThat(replayedComplete.json().path("id").asText()).isEqualTo(operationId);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM connection_operations WHERE attempt_id = ?::uuid",
                Integer.class,
                attemptId))
        .isEqualTo(1);

    Resp polled =
        owner.get("/api/households/" + householdId + "/connection-operations/" + operationId);
    assertThat(polled.status()).isEqualTo(200);
    assertThat(polled.json().path("state").asText()).isEqualTo("SUCCEEDED");

    Resp listed = owner.get("/api/households/" + householdId + "/financial-connections");
    assertThat(listed.status()).isEqualTo(200);
    JsonNode connection = listed.json().path("items").get(0);
    assertThat(listed.json().path("items").size()).isEqualTo(1);
    assertThat(connection.propertyNames())
        .containsExactlyInAnyOrder(
            "id",
            "householdId",
            "provider",
            "environment",
            "state",
            "generation",
            "version",
            "lastSuccessfulSyncAt",
            "createdAt",
            "updatedAt");
    assertThat(connection.path("provider").asText()).isEqualTo("PLAID");
    assertThat(connection.path("environment").asText()).isEqualTo("SANDBOX");
    assertThat(connection.path("state").asText()).isEqualTo("ACTIVE");
    assertThat(connection.path("generation").asLong()).isZero();
    assertThat(connection.path("version").asInt()).isZero();
    assertThat(listed.body())
        .doesNotContain("fake-access", "fake-item", "credential", "remoteItem");
    assertThat(
            jdbc.queryForObject(
                "SELECT remote_item_digest FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .matches("[0-9a-f]{64}");
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_credential FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .startsWith("test-key-1:")
        .doesNotContain("fake-access");

    Resp discovered =
        owner.get(
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/accounts");
    assertThat(discovered.status()).isEqualTo(200);
    assertThat(discovered.json().path("items").size()).isEqualTo(2);
    JsonNode checking = null;
    JsonNode savings = null;
    for (JsonNode item : discovered.json().path("items")) {
      if ("CHECKING".equals(item.path("kind").asText())) {
        checking = item;
      } else {
        savings = item;
      }
    }
    assertThat(checking).isNotNull();
    assertThat(savings).isNotNull();
    assertThat(checking.propertyNames())
        .containsExactlyInAnyOrder(
            "mappingId",
            "localAccountId",
            "name",
            "kind",
            "currency",
            "selected",
            "eligible",
            "exclusionReason");
    assertThat(checking.path("kind").asText()).isEqualTo("CHECKING");
    assertThat(checking.path("currency").asText()).isEqualTo("USD");
    assertThat(checking.path("selected").asBoolean()).isFalse();
    assertThat(checking.path("eligible").asBoolean()).isTrue();
    assertThat(checking.path("localAccountId").isNull()).isTrue();
    assertThat(savings.path("currency").asText()).isEqualTo("CAD");
    String checkingMapping = checking.path("mappingId").asText();
    String savingsMapping = savings.path("mappingId").asText();

    Resp staleSelect =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":99,\"accountMappingIds\":[\"" + checkingMapping + "\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(staleSelect.status()).isEqualTo(409);
    assertThat(staleSelect.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    UUID selectKey = UUID.randomUUID();
    Resp selected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":0,\"accountMappingIds\":[\""
                + checkingMapping
                + "\",\""
                + savingsMapping
                + "\"]}",
            owner.csrfToken,
            selectKey);
    assertThat(selected.status()).isEqualTo(200);
    assertThat(selected.json().path("version").asInt()).isEqualTo(1);
    assertThat(selected.json().path("accounts").size()).isEqualTo(2);
    assertThat(selected.json().path("accounts").get(0).path("source").asText())
        .isEqualTo("CONNECTED");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid"
                    + " AND source = 'CONNECTED'",
                Integer.class,
                householdId))
        .isEqualTo(2);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_accounts WHERE household_id = ?::uuid"
                    + " AND currency = 'CAD'",
                Integer.class,
                householdId))
        .isEqualTo(1);

    Resp replayedSelect =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":0,\"accountMappingIds\":[\""
                + savingsMapping
                + "\",\""
                + checkingMapping
                + "\"]}",
            owner.csrfToken,
            selectKey);
    assertThat(replayedSelect.status()).isEqualTo(200);
    assertThat(replayedSelect.json().path("version").asInt()).isEqualTo(1);

    Resp deselected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":1,\"accountMappingIds\":[\"" + checkingMapping + "\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(deselected.status()).isEqualTo(200);
    assertThat(deselected.json().path("version").asInt()).isEqualTo(2);
    assertThat(
            jdbc.queryForObject(
                "SELECT local_account_id FROM financial_connection_account_mappings"
                    + " WHERE id = ?::uuid AND selected = FALSE",
                String.class,
                savingsMapping))
        .isNotNull();

    UUID reconnectKey = UUID.randomUUID();
    Resp reconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":2}",
            owner.csrfToken,
            reconnectKey);
    assertThat(reconnected.status()).isEqualTo(201);
    assertThat(reconnected.json().path("flow").asText()).isEqualTo("UPDATE");
    assertThat(reconnected.json().path("provider").asText()).isEqualTo("PLAID");
    assertThat(reconnected.json().path("connectionId").asText()).isEqualTo(connectionId);
    String updateAttemptId = reconnected.json().path("id").asText();
    assertThat(
            jdbc.queryForObject(
                "SELECT generation FROM financial_connections WHERE id = ?::uuid",
                Long.class,
                connectionId))
        .isEqualTo(1L);

    Resp reconnectReplay =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":2}",
            owner.csrfToken,
            reconnectKey);
    assertThat(reconnectReplay.status()).isEqualTo(200);
    assertThat(reconnectReplay.json().path("id").asText()).isEqualTo(updateAttemptId);

    Resp reconnectCompleted =
        completeLink(owner, householdId, updateAttemptId, UUID.randomUUID(), "{}");
    assertThat(reconnectCompleted.status()).isEqualTo(202);
    assertThat(reconnectCompleted.json().path("state").asText()).isEqualTo("SUCCEEDED");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("ACTIVE");

    Resp disconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/disconnect",
            "{\"expectedVersion\":3}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(disconnected.status()).isEqualTo(202);
    assertThat(disconnected.json().path("operationType").asText()).isEqualTo("DISCONNECT");
    String disconnectOperation = disconnected.json().path("id").asText();
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTING");
    assertThat(
            jdbc.queryForObject(
                "SELECT generation FROM financial_connections WHERE id = ?::uuid",
                Long.class,
                connectionId))
        .isEqualTo(2L);

    String workId =
        jdbc.queryForObject(
            "SELECT id FROM connection_revocation_work WHERE connection_id = ?::uuid"
                + " AND state = 'QUEUED'",
            String.class,
            connectionId);
    lifecycle.processOneRevocation(UUID.fromString(workId));

    Resp disconnectPolled =
        owner.get(
            "/api/households/" + householdId + "/connection-operations/" + disconnectOperation);
    assertThat(disconnectPolled.json().path("state").asText()).isEqualTo("SUCCEEDED");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTED");
    assertThat(
            jdbc.queryForObject(
                "SELECT encrypted_credential FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isNull();

    Resp secondDisconnect =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/disconnect",
            "{\"expectedVersion\":4}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(secondDisconnect.status()).isEqualTo(409);
    assertThat(secondDisconnect.json().path("code").asText()).isEqualTo("CONNECTION_DISCONNECTED");

    Resp selectAfterDisconnect =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":4,\"accountMappingIds\":[]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(selectAfterDisconnect.status()).isEqualTo(409);
  }

  @Test
  void manualPostStaysManualOnlyWithStrictCadRules() throws Exception {
    Agent owner = signedInAgent("cad-rules");
    String householdId = createHousehold(owner, "CAD home");

    Resp cadAccount =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/financial-accounts",
            "{\"name\":\"Loonie chequing\",\"kind\":\"CHECKING\",\"currency\":\"CAD\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(cadAccount.status()).isEqualTo(201);
    assertThat(cadAccount.json().path("currency").asText()).isEqualTo("CAD");
    String accountId = cadAccount.json().path("id").asText();

    Resp overscale =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            transactionJson(accountId, "INCOME", "10.001", "CAD"),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(overscale.status()).isEqualTo(400);

    Resp exact =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            transactionJson(accountId, "INCOME", "10.00", "CAD"),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(exact.status()).isEqualTo(201);

    Resp wrongCurrency =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            transactionJson(accountId, "INCOME", "10.00", "USD"),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(wrongCurrency.status()).isEqualTo(400);

    Resp currencyFilter =
        owner.get(
            "/api/households/" + householdId + "/transactions?view=OWN&currency=CAD&limit=10");
    assertThat(currencyFilter.status()).isEqualTo(200);
    Resp badCurrency =
        owner.get("/api/households/" + householdId + "/transactions?view=OWN&currency=XXX");
    assertThat(badCurrency.status()).isEqualTo(400);

    // CONNECTED accounts reject manual entry.
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
    JsonNode mappings =
        owner
            .get(
                "/api/households/"
                    + householdId
                    + "/financial-connections/"
                    + connectionId
                    + "/accounts")
            .json();
    String mappingId = mappings.path("items").get(0).path("mappingId").asText();
    Resp selected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":0,\"accountMappingIds\":[\"" + mappingId + "\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    String connectedAccount = selected.json().path("accounts").get(0).path("id").asText();
    Resp manualOnConnected =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/transactions",
            transactionJson(connectedAccount, "EXPENSE", "-5.00", "USD"),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(manualOnConnected.status()).isEqualTo(400);
    assertThat(manualOnConnected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
  }

  @Test
  void reconnectFencingExpiryAndIdempotencyEdges() throws Exception {
    Agent owner = signedInAgent("fencing");
    String householdId = createHousehold(owner, "Fencing home");

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

    Resp reconnected =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/reconnect",
            "{\"expectedVersion\":0}",
            owner.csrfToken,
            UUID.randomUUID());
    String updateAttemptId = reconnected.json().path("id").asText();

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
    assertThat(disconnected.status()).isEqualTo(202);

    Resp lateCompletion =
        completeLink(owner, householdId, updateAttemptId, UUID.randomUUID(), "{}");
    assertThat(lateCompletion.status()).isEqualTo(409);
    assertThat(lateCompletion.json().path("code").asText()).isEqualTo("CONNECTION_NOT_READY");
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM financial_connections WHERE id = ?::uuid",
                String.class,
                connectionId))
        .isEqualTo("DISCONNECTING");

    // Completed attempt with another key cannot trigger a second exchange.
    Resp secondKey =
        completeLink(
            owner,
            householdId,
            attemptId,
            UUID.randomUUID(),
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(attemptId))
                + "\"}");
    assertThat(secondKey.status()).isEqualTo(409);
    assertThat(secondKey.json().path("code").asText()).isEqualTo("CONNECTION_NOT_READY");

    // Expired attempt: both start replay and completion report expiry.
    UUID expiringKey = UUID.randomUUID();
    Resp expiring = startLink(owner, householdId, expiringKey);
    String expiringId = expiring.json().path("id").asText();
    jdbc.update(
        "UPDATE connection_link_attempts SET expires_at = NOW() - INTERVAL '1 second'"
            + " WHERE id = ?::uuid",
        expiringId);
    Resp expiredReplay = startLink(owner, householdId, expiringKey);
    assertThat(expiredReplay.status()).isEqualTo(409);
    assertThat(expiredReplay.json().path("code").asText()).isEqualTo("LINK_ATTEMPT_EXPIRED");
    Resp expiredComplete = completeLink(owner, householdId, expiringId, UUID.randomUUID(), "{}");
    assertThat(expiredComplete.status()).isEqualTo(409);

    // Unknown attempts are connection 404s; a household the actor never joined is a
    // household 404, matching the manual-finance membership-first convention.
    Agent stranger = signedInAgent("fencing-stranger");
    String strangerHousehold = createHousehold(stranger, "Stranger home");
    Resp unknown =
        completeLink(owner, householdId, UUID.randomUUID().toString(), UUID.randomUUID(), "{}");
    assertThat(unknown.status()).isEqualTo(404);
    assertThat(unknown.json().path("code").asText()).isEqualTo("FINANCIAL_CONNECTION_NOT_FOUND");
    Resp crossHousehold =
        completeLink(owner, strangerHousehold, attemptId, UUID.randomUUID(), "{}");
    assertThat(crossHousehold.status()).isEqualTo(404);
    assertThat(crossHousehold.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    // Duplicate and unknown selection IDs fail before any state change.
    Resp duplicate =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + connectionId
                + "/account-selection",
            "{\"expectedVersion\":2,\"accountMappingIds\":[\"00000000-0000-0000-0000-000000000000\","
                + "\"00000000-0000-0000-0000-000000000000\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(duplicate.status()).isEqualTo(400);

    // Ineligible mappings cannot be admitted (fresh ACTIVE connection for this check).
    Resp freshStarted = startLink(owner, householdId, UUID.randomUUID());
    String freshAttempt = freshStarted.json().path("id").asText();
    Resp freshCompleted =
        completeLink(
            owner,
            householdId,
            freshAttempt,
            UUID.randomUUID(),
            "{\"publicToken\":\""
                + FakePlaidAdapter.publicTokenFor(UUID.fromString(freshAttempt))
                + "\"}");
    String freshConnection = freshCompleted.json().path("connectionId").asText();
    JsonNode mappings =
        owner
            .get(
                "/api/households/"
                    + householdId
                    + "/financial-connections/"
                    + freshConnection
                    + "/accounts")
            .json();
    String mappingId = mappings.path("items").get(0).path("mappingId").asText();
    jdbc.update(
        "UPDATE financial_connection_account_mappings SET eligible = FALSE,"
            + " selected = FALSE, exclusion_reason = 'UNSUPPORTED_KIND' WHERE id = ?::uuid",
        mappingId);
    Resp ineligible =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + freshConnection
                + "/account-selection",
            "{\"expectedVersion\":0,\"accountMappingIds\":[\"" + mappingId + "\"]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(ineligible.status()).isEqualTo(400);
  }

  @Test
  void strictTransportSecurityAndMigrationBounds() throws Exception {
    Agent owner = signedInAgent("strict");
    String householdId = createHousehold(owner, "Strict home");

    Agent anonymous = new Agent();
    String anonymousCsrf = anonymous.csrfToken();
    Resp anonymousStart =
        anonymous.request(
            "POST",
            "/api/households/" + householdId + "/connection-link-attempts",
            "{}",
            anonymousCsrf,
            UUID.randomUUID());
    assertThat(anonymousStart.status()).isEqualTo(401);
    assertThat(anonymousStart.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");

    Resp missingCsrf =
        owner.raw(
            "POST",
            "/api/households/" + householdId + "/connection-link-attempts",
            "{}",
            null,
            UUID.randomUUID().toString(),
            "application/json");
    assertThat(missingCsrf.status()).isEqualTo(403);

    Resp unknownField =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/connection-link-attempts",
            "{\"provider\":\"plaid\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(unknownField.status()).isEqualTo(400);

    Resp missingKey =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/connection-link-attempts",
            "{}",
            owner.csrfToken,
            null);
    assertThat(missingKey.status()).isEqualTo(400);

    Resp badQuery =
        owner.get("/api/households/" + householdId + "/financial-connections?unknown=1");
    assertThat(badQuery.status()).isEqualTo(400);

    Resp syncMissing =
        owner.request(
            "POST",
            "/api/households/"
                + householdId
                + "/financial-connections/"
                + UUID.randomUUID()
                + "/sync",
            "{\"expectedVersion\":0}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(syncMissing.status()).isEqualTo(403);

    // Widened-but-bounded checks: CONNECTED and CAD pass, foreign tokens still fail.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM information_schema.check_constraints"
                    + " WHERE constraint_name = 'financial_accounts_source_check'",
                Integer.class))
        .isEqualTo(1);
    try {
      jdbc.update(
          "INSERT INTO financial_accounts (id, household_id, owner_user_id, name, kind,"
              + " currency, source, visibility, status, version, created_at, updated_at)"
              + " VALUES (?::uuid, ?::uuid, ?::uuid, 'Bad', 'CHECKING', 'CHF', 'MANUAL',"
              + " 'PRIVATE', 'ACTIVE', 0, NOW(), NOW())",
          UUID.randomUUID().toString(),
          householdId,
          owner.userId());
      assertThat(false).as("CHF account insert must violate the currency check").isTrue();
    } catch (org.springframework.dao.DataIntegrityViolationException expected) {
      assertThat(expected.getMessage()).isNotNull();
    }
    try {
      jdbc.update(
          "INSERT INTO financial_accounts (id, household_id, owner_user_id, name, kind,"
              + " currency, source, visibility, status, version, created_at, updated_at)"
              + " VALUES (?::uuid, ?::uuid, ?::uuid, 'Bad', 'CHECKING', 'CAD', 'PLAID',"
              + " 'PRIVATE', 'ACTIVE', 0, NOW(), NOW())",
          UUID.randomUUID().toString(),
          householdId,
          owner.userId());
      assertThat(false).as("foreign source insert must violate the source check").isTrue();
    } catch (org.springframework.dao.DataIntegrityViolationException expected) {
      assertThat(expected.getMessage()).isNotNull();
    }
    // Provider identities persist only as opaque digests, never raw.
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_connections"
                    + " WHERE remote_item_digest LIKE 'fake-item%'"
                    + " OR encrypted_credential LIKE 'fake-access%'",
                Integer.class))
        .isZero();
  }

  private String keyOf(Resp started, String attemptId) throws Exception {
    // Replays reuse the original idempotency key; recover it from the idempotency table.
    return jdbc.queryForObject(
        "SELECT idempotency_key FROM connection_operation_idempotency_keys"
            + " WHERE resource_id = ?::uuid AND operation = 'LINK_START'",
        String.class,
        attemptId);
  }

  private static String transactionJson(
      String accountId, String kind, String amount, String currency) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\""
        + kind
        + "\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},"
        + "\"occurredOn\":\"2026-09-01\",\"description\":\"CAD probe\"}";
  }
}
