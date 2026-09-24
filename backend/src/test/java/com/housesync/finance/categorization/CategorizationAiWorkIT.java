package com.housesync.finance.categorization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.categorization.application.CategorizationAiProvider;
import com.housesync.finance.categorization.application.CategorizationAiWorkService;
import com.housesync.finance.categorization.application.CategorizationAiWorker;
import com.housesync.finance.transaction.application.FinancialTransactionService;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

@SpringBootTest(
    properties = {
      "app.categorization-ai.enabled=true", "app.categorization-ai.model=test-model",
      "app.categorization-ai.key=test-key", "app.categorization-ai.policy=AI_POLICY_V1",
      "app.categorization-ai.poll-ms=600000"
    })
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class CategorizationAiWorkIT {
  private static final HttpServer FAKE;
  private static final AtomicInteger fakeStatus = new AtomicInteger(200);
  private static final AtomicReference<String> fakeBody =
      new AtomicReference<>(
          "{\"model\":\"test-model\",\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"{\\\"category\\\":\\\"GROCERIES\\\",\\\"confidence\\\":\\\"MEDIUM\\\",\\\"reasonCode\\\":\\\"MERCHANT_CONTEXT\\\",\\\"model\\\":\\\"test-model\\\",\\\"policy\\\":\\\"AI_POLICY_V1\\\"}\"}}]}");
  private static final AtomicInteger requests = new AtomicInteger();

  static {
    try {
      FAKE = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      FAKE.createContext(
          "/v1/chat/completions",
          exchange -> {
            try (exchange) {
              requests.incrementAndGet();
              exchange.getRequestBody().readAllBytes();
              byte[] bytes = fakeBody.get().getBytes(StandardCharsets.UTF_8);
              exchange.sendResponseHeaders(fakeStatus.get(), bytes.length);
              exchange.getResponseBody().write(bytes);
            }
          });
      FAKE.start();
    } catch (java.io.IOException failure) {
      throw new ExceptionInInitializerError(failure);
    }
  }

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer("postgres:17-alpine")
          .withDatabaseName("housesync")
          .withUsername("housesync")
          .withPassword("integration-test-only");

  @DynamicPropertySource
  static void database(DynamicPropertyRegistry registry) {
    registry.add("DB_HOST", POSTGRES::getHost);
    registry.add("DB_PORT", POSTGRES::getFirstMappedPort);
    registry.add("DB_NAME", POSTGRES::getDatabaseName);
    registry.add("DB_USER", POSTGRES::getUsername);
    registry.add("DB_PASSWORD", POSTGRES::getPassword);
    registry.add(
        "app.categorization-ai.base-url",
        () -> "http://127.0.0.1:" + FAKE.getAddress().getPort() + "/v1/chat/completions");
  }

  @Autowired JdbcTemplate jdbc;
  @Autowired TransactionTemplate transaction;
  @Autowired CategorizationAiWorkService work;
  @Autowired FinancialTransactionService ledgerService;
  @Autowired CategorizationAiWorker worker;
  @Autowired FinancialTransactionRepository transactions;
  private UUID owner;
  private UUID household;
  private UUID account;
  private UUID ledger;

  @AfterAll
  static void stopFake() {
    FAKE.stop(0);
  }

  @BeforeEach
  void fixture() {
    jdbc.update("DELETE FROM categorization_ai_work");
    fakeStatus.set(200);
    requests.set(0);
    owner = UUID.randomUUID();
    household = UUID.randomUUID();
    account = UUID.randomUUID();
    ledger = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,now())",
        owner,
        UUID.randomUUID() + "@example.test",
        "{bcrypt}$2a$12$integrationtestonlyhashvalue00000000000000000000000");
    jdbc.update("INSERT INTO households(id,name,created_at) VALUES(?,'AI test',now())", household);
    jdbc.update(
        "INSERT INTO household_members(household_id,user_id,role) VALUES(?,?,'OWNER')",
        household,
        owner);
    jdbc.update(
        "INSERT INTO financial_accounts(id,household_id,owner_user_id,name,kind,currency,source,visibility,status,version,created_at,updated_at) VALUES(?,?,?,'Card','CHECKING','USD','MANUAL','PRIVATE','ACTIVE',0,now(),now())",
        account,
        household,
        owner);
    jdbc.update(
        "INSERT INTO financial_transactions(id,household_id,owner_user_id,account_id,kind,amount,currency,occurred_on,description,source,visibility,status,category,category_origin,category_assigned_at,version,created_at,updated_at) VALUES(?,?,?,?,'EXPENSE',-12.00,'USD',DATE '2026-09-23','Unfamiliar Corner Shop','MANUAL','PRIVATE','POSTED',NULL,'NONE',now(),0,now(),now())",
        ledger,
        household,
        owner,
        account);
  }

  private void enqueue() {
    transaction.executeWithoutResult(
        status ->
            work.enqueue(
                transactions.findOwnedScoped(household, ledger, owner).orElseThrow(), null));
  }

  @Test
  void realWorkerCallsLocalTransportAndPublishesReview() {
    enqueue();
    worker.poll();
    assertThat(requests.get()).isEqualTo(1);
    assertThat(work.status(household, owner).pendingCount()).isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT confidence FROM categorization_reviews WHERE transaction_id=? AND source='AI'",
                String.class,
                ledger))
        .isEqualTo("MEDIUM");
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id=?", String.class, ledger))
        .isNull();
  }

  @Test
  void providerOutageRetriesDueWorkOnlyThreeTimes() {
    enqueue();
    fakeStatus.set(503);
    for (int attempt = 1; attempt <= 3; attempt++) {
      worker.poll();
      assertThat(requests.get()).isEqualTo(attempt);
      assertThat(
              jdbc.queryForObject(
                  "SELECT attempts FROM categorization_ai_work WHERE transaction_id=?",
                  Integer.class,
                  ledger))
          .isEqualTo(attempt);
      jdbc.update(
          "UPDATE categorization_ai_work SET due_at=now()-interval '1 second' WHERE transaction_id=?",
          ledger);
    }
    worker.poll();
    assertThat(requests.get()).isEqualTo(3);
    assertThat(work.status(household, owner).failedCount()).isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_reviews WHERE transaction_id=?",
                Integer.class,
                ledger))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id=?", String.class, ledger))
        .isNull();
  }

  @Test
  void realCreateEnqueuesAfterHeuristicMissAndKeepsVersionZero() {
    var created =
        ledgerService
            .create(
                household,
                owner,
                UUID.randomUUID(),
                new FinancialTransactionService.CreateFields(
                    account.toString(),
                    "EXPENSE",
                    "-8.00",
                    "USD",
                    "2026-09-24",
                    "Totally Unknown Merchant",
                    null,
                    false,
                    null,
                    false,
                    null,
                    false))
            .transaction();
    assertThat(created.version()).isZero();
    assertThat(created.category()).isNull();
    assertThat(work.status(household, owner).pendingCount()).isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_ai_work WHERE transaction_id=?",
                Integer.class,
                created.id()))
        .isEqualTo(1);
  }

  @Test
  void publishesOnlyReviewAndFencesOldClaims() {
    enqueue();
    enqueue();
    assertThat(work.status(household, owner).pendingCount()).isEqualTo(1);
    var claimed = work.claim();
    assertThat(work.evidence(claimed).description()).isEqualTo("unfamiliar corner shop");
    var suggestion = new CategorizationAiProvider.Candidate("GROCERIES", "LOW", "MERCHANT_CONTEXT");
    work.finish(claimed, suggestion, false);
    work.finish(claimed, suggestion, false);
    assertThat(work.status(household, owner).pendingCount()).isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_reviews WHERE transaction_id=? AND source='AI' AND status='OPEN'",
                Integer.class,
                ledger))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id=?", String.class, ledger))
        .isNull();
  }

  @Test
  void staleUserDecisionWinsAndOnlyOwnerCanSeeCounts() {
    enqueue();
    var claimed = work.claim();
    jdbc.update(
        "UPDATE financial_transactions SET category='DINING',category_origin='USER',version=version+1 WHERE id=?",
        ledger);
    work.finish(
        claimed,
        new CategorizationAiProvider.Candidate("GROCERIES", "HIGH", "MERCHANT_CONTEXT"),
        false);
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_reviews WHERE transaction_id=?",
                Integer.class,
                ledger))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id=?", String.class, ledger))
        .isEqualTo("DINING");
    assertThat(work.status(household, owner).pendingCount()).isZero();
    UUID outsider = UUID.randomUUID();
    assertThatThrownBy(() -> work.status(household, outsider))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  @Test
  void expiredLeaseReclaimsAndFencesDelayedWorker() {
    enqueue();
    var first = work.claim();
    jdbc.update(
        "UPDATE categorization_ai_work SET lease_until=now()-interval '1 second' WHERE id=?",
        first.id());
    var replacement = work.claim();
    assertThat(replacement.id()).isEqualTo(first.id());
    assertThat(replacement.fence()).isGreaterThan(first.fence());
    var candidate =
        new CategorizationAiProvider.Candidate("DINING", "MEDIUM", "TRANSACTION_CONTEXT");
    work.finish(first, candidate, false);
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_reviews WHERE transaction_id=?",
                Integer.class,
                ledger))
        .isZero();
    work.finish(replacement, candidate, false);
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_reviews WHERE transaction_id=?",
                Integer.class,
                ledger))
        .isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id=?", String.class, ledger))
        .isNull();
  }

  @Test
  void oldModelPolicyWorkIsRejectedBeforeTransportAndReview() {
    enqueue();
    jdbc.update(
        "UPDATE categorization_ai_work SET policy_version='old-model-policy' WHERE transaction_id=?",
        ledger);
    worker.poll();
    assertThat(requests.get()).isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM categorization_ai_work WHERE transaction_id=?",
                String.class,
                ledger))
        .isEqualTo("STALE");
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_reviews WHERE transaction_id=?",
                Integer.class,
                ledger))
        .isZero();
  }

  @Test
  void removedOwnerClaimSettlesStaleWithoutNetworkOrReview() {
    enqueue();
    var claimed = work.claim();
    jdbc.update(
        "DELETE FROM household_members WHERE household_id=? AND user_id=?", household, owner);
    // Preflight must not send a former member's description to the provider.
    assertThat(work.evidence(claimed)).isNull();
    work.finish(claimed, null, false);
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM categorization_ai_work WHERE id=?", String.class, claimed.id()))
        .isEqualTo("STALE");
    assertThat(
            jdbc.queryForObject(
                "SELECT count(*) FROM categorization_reviews WHERE transaction_id=?",
                Integer.class,
                ledger))
        .isZero();
    assertThatThrownBy(() -> work.status(household, owner))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  @Test
  void failureIsOwnerOnlyAndRetainsUncategorizedLedger() {
    enqueue();
    work.finish(work.claim(), null, false);
    assertThat(work.status(household, owner).failedCount()).isEqualTo(1);
    assertThat(
            jdbc.queryForObject(
                "SELECT category FROM financial_transactions WHERE id=?", String.class, ledger))
        .isNull();
    jdbc.update(
        "DELETE FROM household_members WHERE household_id=? AND user_id=?", household, owner);
    assertThatThrownBy(() -> work.status(household, owner))
        .isInstanceOf(HouseholdNotFoundException.class);
  }

  @Test
  void ownerCorrectionClearsActionableFailureWithoutDeletingWorkHistory() {
    enqueue();
    work.finish(work.claim(), null, false);
    assertThat(work.status(household, owner).failedCount()).isEqualTo(1);
    jdbc.update(
        "UPDATE financial_transactions SET category='SHOPPING',category_origin='USER',version=version+1 WHERE id=?",
        ledger);
    assertThat(work.status(household, owner).failedCount()).isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT state FROM categorization_ai_work WHERE transaction_id=?",
                String.class,
                ledger))
        .isEqualTo("FAILED");
  }
}
