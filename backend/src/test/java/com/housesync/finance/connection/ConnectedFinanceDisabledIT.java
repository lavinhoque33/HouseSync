package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Default-disabled application: the context starts with no provider secrets or keys, connected-finance routes
 * fail closed, and manual finance remains usable.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class ConnectedFinanceDisabledIT extends ConnectedFinanceITSupport {

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

  @Test
  void disabledConnectedFinanceFailsClosedWhileManualFinanceWorks() throws Exception {
    Agent owner = signedInAgent("disabled");
    String householdId = createHousehold(owner, "Disabled home");

    Resp started = startLink(owner, householdId, UUID.randomUUID());
    assertThat(started.status()).isEqualTo(503);
    assertThat(started.json().path("code").asText()).isEqualTo("CONNECTED_FINANCE_DISABLED");

    Resp listed = owner.get("/api/households/" + householdId + "/financial-connections");
    assertThat(listed.status()).isEqualTo(503);

    Resp operation =
        owner.get("/api/households/" + householdId + "/connection-operations/" + UUID.randomUUID());
    assertThat(operation.status()).isEqualTo(503);

    Resp manual =
        owner.request(
            "POST",
            "/api/households/" + householdId + "/financial-accounts",
            "{\"name\":\"Cash\",\"kind\":\"CASH\",\"currency\":\"USD\"}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(manual.status()).isEqualTo(201);
  }
}
