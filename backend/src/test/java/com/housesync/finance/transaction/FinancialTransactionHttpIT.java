package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Transaction HTTP contract against real PostgreSQL: exact DTO and defaults, signed exact money,
 * private-only visibility, linked capped refunds with void dependencies, correction and version
 * rules, durable idempotent creation, lifecycle-safe membership, and bounded lock behavior with no
 * partial state.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class FinancialTransactionHttpIT {

  private static final String PASSWORD = "correct horse battery staple 123!";

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

  @Autowired private com.housesync.identity.application.IdentityGrants grants;
  @Autowired private JdbcTemplate jdbc;
  @Autowired private DataSource dataSource;
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void createProducesExactSignedAmountStringsForAllSixCurrencies() throws Exception {
    Agent actor = signedInAgent("six-currencies");
    String householdId = createHousehold(actor, "Currency home");
    String brl = createAccount(actor, householdId, UUID.randomUUID(), "BRL", "CHECKING", "BRL");
    String usd = createAccount(actor, householdId, UUID.randomUUID(), "USD", "SAVINGS", "USD");
    String eur = createAccount(actor, householdId, UUID.randomUUID(), "EUR", "CHECKING", "EUR");
    String gbp = createAccount(actor, householdId, UUID.randomUUID(), "GBP", "SAVINGS", "GBP");
    String jpy = createAccount(actor, householdId, UUID.randomUUID(), "JPY", "CASH", "JPY");
    String kwd = createAccount(actor, householdId, UUID.randomUUID(), "KWD", "CASH", "KWD");

    Resp brlEntry =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(brl, "EXPENSE", "-12.3", "BRL", "Groceries"));
    Resp usdEntry =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(usd, "INCOME", "9.99", "USD", "Gift"));
    Resp eurEntry =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(eur, "EXPENSE", "-0.01", "EUR", "Cent"));
    Resp gbpEntry =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(gbp, "TRANSFER", "7", "GBP", "Move"));
    Resp jpyEntry =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(jpy, "EXPENSE", "-1000", "JPY", "Cash"));
    Resp kwdEntry =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(kwd, "TRANSFER", "-1.234", "KWD", "Convert"));

    assertThat(brlEntry.status).isEqualTo(201);
    assertThat(usdEntry.status).isEqualTo(201);
    assertThat(eurEntry.status).isEqualTo(201);
    assertThat(gbpEntry.status).isEqualTo(201);
    assertThat(jpyEntry.status).isEqualTo(201);
    assertThat(kwdEntry.status).isEqualTo(201);
    assertThat(moneyAmount(brlEntry.json())).isEqualTo("-12.30");
    assertThat(moneyAmount(usdEntry.json())).isEqualTo("9.99");
    assertThat(moneyAmount(eurEntry.json())).isEqualTo("-0.01");
    assertThat(moneyAmount(gbpEntry.json())).isEqualTo("7.00");
    assertThat(moneyAmount(jpyEntry.json())).isEqualTo("-1000");
    assertThat(moneyAmount(kwdEntry.json())).isEqualTo("-1.234");
    assertThat(brlEntry.json().path("kind").asText()).isEqualTo("EXPENSE");
    assertThat(usdEntry.json().path("kind").asText()).isEqualTo("INCOME");
    assertThat(gbpEntry.json().path("kind").asText()).isEqualTo("TRANSFER");
    for (Resp entry : List.of(brlEntry, usdEntry, eurEntry, gbpEntry, jpyEntry, kwdEntry)) {
      assertThat(entry.json().path("visibility").asText()).isEqualTo("PRIVATE");
      assertThat(entry.json().path("source").asText()).isEqualTo("MANUAL");
      assertThat(entry.json().path("status").asText()).isEqualTo("POSTED");
      assertThat(entry.json().path("category").isNull()).isTrue();
      assertThat(entry.json().path("version").asInt()).isZero();
      assertThat(entry.json().path("refundOfTransactionId").isNull()).isTrue();
      assertThat(entry.json().path("money").propertyNames()).containsExactly("amount", "currency");
      assertThat(entry.cacheControl()).contains("no-store");
    }
  }

  @Test
  void moneyValidationRejectsMalformedAmountsSignsScalesAndForgedFields() throws Exception {
    Agent actor = signedInAgent("money-rules");
    String householdId = createHousehold(actor, "Money rules home");
    String brl = createAccount(actor, householdId, UUID.randomUUID(), "BRL", "CHECKING", "BRL");
    String jpy = createAccount(actor, householdId, UUID.randomUUID(), "JPY", "CASH", "JPY");

    // Grammar violations: the safe field error never echoes the submitted text.
    for (String amount :
        new String[] {"+1.00", "01.00", "1e5", " 1.00", "1,000", "$5", "1.230", "1000000000000"}) {
      Resp rejected =
          actor.createTransaction(
              householdId, UUID.randomUUID(), entry(brl, "EXPENSE", amount, "BRL", "Bad"));
      assertThat(rejected.status).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("fieldErrors").has("money.amount")).isTrue();
      assertThat(rejected.body).doesNotContain(amount);
    }
    // An empty amount is rejected too, without an impossible empty echo assertion.
    Resp emptyAmount =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(brl, "EXPENSE", "", "BRL", "Bad"));
    assertThat(emptyAmount.status).isEqualTo(400);
    assertThat(emptyAmount.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(emptyAmount.json().path("fieldErrors").has("money.amount")).isTrue();
    // Zero and negative zero are nonzero-value violations; the message names no value.
    for (String amount : new String[] {"-0", "-0.00", "0", "0.00"}) {
      Resp rejected =
          actor.createTransaction(
              householdId, UUID.randomUUID(), entry(brl, "EXPENSE", amount, "BRL", "Bad"));
      assertThat(rejected.status).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("fieldErrors").has("money.amount")).isTrue();
    }
    // Excess precision fails even though trimming would preserve the numeric value.
    Resp excessPrecision =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(brl, "EXPENSE", "-999999999999.999", "BRL", "Bad"));
    assertThat(excessPrecision.status).isEqualTo(400);
    assertThat(excessPrecision.json().path("fieldErrors").has("money.amount")).isTrue();
    assertThat(
            actor.createTransaction(
                    householdId, UUID.randomUUID(), entry(jpy, "EXPENSE", "1.0", "JPY", "Bad"))
                .status)
        .isEqualTo(400);

    Resp numericMoney =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + brl
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":12.34,\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Numeric\"}");
    assertThat(numericMoney.status).isEqualTo(400);

    Resp positiveExpense =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(brl, "EXPENSE", "10.00", "BRL", "Wrong"));
    Resp negativeIncome =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(brl, "INCOME", "-10.00", "BRL", "Wrong"));
    Resp negativeRefund =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(brl, "REFUND", "-10.00", "BRL", "Wrong"));
    for (Resp response : List.of(positiveExpense, negativeIncome, negativeRefund)) {
      assertThat(response.status).isEqualTo(400);
      assertThat(response.json().path("fieldErrors").has("money.amount")).isTrue();
    }

    Resp mismatch =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(brl, "INCOME", "10.00", "USD", "Wrong"));
    assertThat(mismatch.status).isEqualTo(400);
    assertThat(mismatch.json().path("fieldErrors").has("money.currency")).isTrue();

    Resp earlyDate =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(brl, "INCOME", "10.00", "BRL", "Old", "1899-12-31"));
    Resp lateDate =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(brl, "INCOME", "10.00", "BRL", "Late", "9999-12-31"));

    Resp refundFieldOnExpense =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + brl
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":\"-10.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Bad\","
                + "\"refundOfTransactionId\":null}");
    Resp refundWithoutSource =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(brl, "REFUND", "10.00", "BRL", "Bad"));
    Resp forgedOwner =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + brl
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":\"-10.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Bad\","
                + "\"ownerUserId\":\""
                + UUID.randomUUID()
                + "\"}");
    Resp forgedStatus =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + brl
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":\"-10.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Bad\","
                + "\"status\":\"VOIDED\"}");
    for (Resp response :
        List.of(
            earlyDate,
            lateDate,
            refundFieldOnExpense,
            refundWithoutSource,
            forgedOwner,
            forgedStatus)) {
      assertThat(response.status).isEqualTo(400);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(response.json().path("correlationId").asText()).isNotBlank();
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();
  }

  @Test
  void listDeliversOrderedBoundedOwnPagesWithSqlFilters() throws Exception {
    Agent actor = signedInAgent("listing");
    String householdId = createHousehold(actor, "Feed home");
    String brl = createAccount(actor, householdId, UUID.randomUUID(), "BRL", "CHECKING", "BRL");
    String usd = createAccount(actor, householdId, UUID.randomUUID(), "USD", "SAVINGS", "USD");

    created(
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            entry(brl, "EXPENSE", "-10.00", "BRL", "B new", "2026-09-12")));
    String middle =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(brl, "EXPENSE", "-20.00", "BRL", "B middle", "2026-09-11")));
    String oldest =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(usd, "INCOME", "5.00", "USD", "USD old", "2026-09-10")));

    JsonNode page = actor.get(transactionPath(householdId)).json();
    assertThat(page.propertyNames())
        .containsExactlyInAnyOrder("items", "limit", "offset", "hasMore");
    assertThat(items(page).size()).isEqualTo(3);
    assertThat(items(page).get(0).path("description").asText()).isEqualTo("B new");
    assertThat(items(page).get(1).path("description").asText()).isEqualTo("B middle");
    assertThat(items(page).get(2).path("description").asText()).isEqualTo("USD old");
    assertThat(page.path("limit").asInt()).isEqualTo(50);
    assertThat(page.path("hasMore").asBoolean()).isFalse();

    JsonNode firstPage = actor.get(transactionPath(householdId) + "?limit=2").json();
    assertThat(items(firstPage).size()).isEqualTo(2);
    assertThat(firstPage.path("hasMore").asBoolean()).isTrue();
    JsonNode secondPage = actor.get(transactionPath(householdId) + "?limit=2&offset=2").json();
    assertThat(items(secondPage).size()).isEqualTo(1);
    assertThat(secondPage.path("hasMore").asBoolean()).isFalse();

    JsonNode brlOnly = actor.get(transactionPath(householdId) + "?accountId=" + brl).json();
    assertThat(items(brlOnly).size()).isEqualTo(2);
    assertThat(items(brlOnly).toString()).doesNotContain("USD old");

    JsonNode usdOnly = actor.get(transactionPath(householdId) + "?currency=USD").json();
    assertThat(items(usdOnly).size()).isEqualTo(1);
    assertThat(items(usdOnly).get(0).path("description").asText()).isEqualTo("USD old");

    JsonNode halfOpen =
        actor.get(transactionPath(householdId) + "?from=2026-09-11&to=2026-09-12").json();
    assertThat(items(halfOpen).size()).isEqualTo(1);
    assertThat(items(halfOpen).get(0).path("description").asText()).isEqualTo("B middle");

    Resp voided =
        actor.patchTransaction(
            householdId, oldest, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);
    assertThat(items(actor.get(transactionPath(householdId)).json()).size()).isEqualTo(2);
    assertThat(items(actor.get(transactionPath(householdId) + "?status=ALL").json()).size())
        .isEqualTo(3);
    assertThat(items(actor.get(transactionPath(householdId) + "?status=VOIDED").json()).size())
        .isEqualTo(1);

    Resp householdView = actor.get(transactionPath(householdId) + "?view=HOUSEHOLD");
    assertThat(householdView.status).isEqualTo(200);
    assertThat(items(householdView.json()).size()).isZero();
    assertThat(householdView.cacheControl()).contains("no-store");

    Resp foreignAccount =
        actor.get(transactionPath(householdId) + "?accountId=" + UUID.randomUUID());
    assertThat(foreignAccount.status).isEqualTo(404);
    assertThat(foreignAccount.json().path("code").asText())
        .isEqualTo("FINANCIAL_ACCOUNT_NOT_FOUND");

    Agent member = signedInAgent("feed-member");
    addMember(householdId, member.userId(), "MEMBER");
    Agent outsider = signedInAgent("feed-outsider");
    assertThat(items(member.get(transactionPath(householdId)).json()).size()).isZero();
    assertThat(items(actor.get(transactionPath(householdId)).json()).size()).isEqualTo(2);
    Resp outsiderList = outsider.get(transactionPath(householdId));
    Resp outsiderFiltered = outsider.get(transactionPath(householdId) + "?accountId=" + brl);
    assertThat(outsiderList.status).isEqualTo(404);
    assertThat(outsiderList.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(outsiderFiltered.status).isEqualTo(404);
    assertThat(outsiderFiltered.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
  }

  @Test
  void visibilityScopeFiltersOwnEntriesInSqlBeforeThePageBoundary() throws Exception {
    Agent owner = signedInAgent("scope-paging");
    String householdId = createHousehold(owner, "Scope paging home");
    String accountId =
        createAccount(owner, householdId, UUID.randomUUID(), "Everyday", "CHECKING", "BRL");

    // 121 shared entries dated 2026-01-01..2026-05-01 sit behind five newer private entries. A
    // scope applied after LIMIT would show an empty or short shared page, so the page contents
    // prove membership/ownership/visibility run in SQL with the other filters before the page
    // boundary and hasMore. Only the fixture volume uses direct inserts; the rows that anchor the
    // boundary on both sides are created through the real create contract.
    List<String> sharedIds = insertSharedHistory(householdId, owner.userId(), accountId, 120);
    String oldestShared =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                visibilityEntry(
                    accountId, "EXPENSE", "-1.00", "BRL", "Shared 0", "2026-01-01", "HOUSEHOLD")));
    List<String> expectedShared = new ArrayList<>(sharedIds);
    expectedShared.add(oldestShared);

    List<String> expectedPrivate = new ArrayList<>();
    for (int index = 0; index < 5; index++) {
      expectedPrivate.add(
          created(
              owner.createTransaction(
                  householdId,
                  UUID.randomUUID(),
                  visibilityEntry(
                      accountId,
                      "EXPENSE",
                      "-2.00",
                      "BRL",
                      "Private " + index,
                      "2026-05-0" + (6 - index),
                      "PRIVATE"))));
    }

    JsonNode sharedFirst =
        owner.get(transactionPath(householdId) + "?visibility=HOUSEHOLD&limit=100").json();
    assertThat(ids(sharedFirst)).isEqualTo(expectedShared.subList(0, 100));
    assertThat(sharedFirst.path("limit").asInt()).isEqualTo(100);
    assertThat(sharedFirst.path("offset").asInt()).isZero();
    assertThat(sharedFirst.path("hasMore").asBoolean()).isTrue();

    JsonNode sharedSecond =
        owner
            .get(transactionPath(householdId) + "?visibility=HOUSEHOLD&limit=100&offset=100")
            .json();
    assertThat(ids(sharedSecond)).isEqualTo(expectedShared.subList(100, 121));
    assertThat(sharedSecond.path("hasMore").asBoolean()).isFalse();
    // The oldest shared match is reachable only because the scope predicate precedes the page.
    assertThat(ids(sharedSecond)).contains(oldestShared);
    assertThat(ids(sharedFirst)).doesNotContain(oldestShared);

    JsonNode privateOnly = owner.get(transactionPath(householdId) + "?visibility=PRIVATE").json();
    assertThat(ids(privateOnly)).isEqualTo(expectedPrivate);
    assertThat(privateOnly.path("hasMore").asBoolean()).isFalse();

    // An omitted scope still means both visibilities, in one coherent ordered sequence.
    JsonNode allFirst = owner.get(transactionPath(householdId) + "?limit=100").json();
    List<String> expectedAllFirst = new ArrayList<>(expectedPrivate);
    expectedAllFirst.addAll(expectedShared.subList(0, 95));
    assertThat(ids(allFirst)).isEqualTo(expectedAllFirst);
    assertThat(allFirst.path("hasMore").asBoolean()).isTrue();
    JsonNode allSecond = owner.get(transactionPath(householdId) + "?limit=100&offset=100").json();
    assertThat(ids(allSecond)).isEqualTo(expectedShared.subList(95, 121));
    assertThat(allSecond.path("hasMore").asBoolean()).isFalse();
    List<String> union = new ArrayList<>(ids(allFirst));
    union.addAll(ids(allSecond));
    assertThat(union).hasSize(126).doesNotHaveDuplicates();

    // The scope composes with the retained account, currency and half-open date predicates.
    JsonNode scopedWindow =
        owner
            .get(
                transactionPath(householdId)
                    + "?visibility=HOUSEHOLD&from=2026-04-27&to=2026-05-02&limit=100")
            .json();
    assertThat(ids(scopedWindow)).isEqualTo(expectedShared.subList(0, 5));
    assertThat(scopedWindow.path("hasMore").asBoolean()).isFalse();
    JsonNode scopedAccount =
        owner
            .get(
                transactionPath(householdId)
                    + "?visibility=HOUSEHOLD&accountId="
                    + accountId
                    + "&currency=BRL&limit=100&offset=100")
            .json();
    assertThat(items(scopedAccount).size()).isEqualTo(21);
    assertThat(scopedAccount.path("hasMore").asBoolean()).isFalse();
    JsonNode emptyScoped =
        owner.get(transactionPath(householdId) + "?visibility=PRIVATE&currency=USD").json();
    assertThat(items(emptyScoped).size()).isZero();
    assertThat(emptyScoped.path("hasMore").asBoolean()).isFalse();
    assertThat(emptyScoped.path("limit").asInt()).isEqualTo(50);
    assertThat(emptyScoped.path("offset").asInt()).isZero();

    // The inclusive offset cap still applies with a scope and never scans past it.
    JsonNode cappedOffset =
        owner.get(transactionPath(householdId) + "?visibility=PRIVATE&offset=10000").json();
    assertThat(items(cappedOffset).size()).isZero();
    assertThat(cappedOffset.path("offset").asInt()).isEqualTo(10000);
    assertThat(cappedOffset.path("hasMore").asBoolean()).isFalse();

    // Retained voided shared history stays discoverable through the scope with status=ALL,
    // is excluded from the default POSTED page, and hasMore follows the filtered population.
    Resp voided =
        owner.patchTransaction(
            householdId, oldestShared, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);
    JsonNode postedShared =
        owner.get(transactionPath(householdId) + "?visibility=HOUSEHOLD&limit=100").json();
    assertThat(items(postedShared).size()).isEqualTo(100);
    assertThat(postedShared.path("hasMore").asBoolean()).isTrue();
    JsonNode postedSharedSecond =
        owner
            .get(transactionPath(householdId) + "?visibility=HOUSEHOLD&limit=100&offset=100")
            .json();
    assertThat(items(postedSharedSecond).size()).isEqualTo(20);
    assertThat(postedSharedSecond.path("hasMore").asBoolean()).isFalse();
    assertThat(
            ids(
                owner
                    .get(transactionPath(householdId) + "?visibility=HOUSEHOLD&status=VOIDED")
                    .json()))
        .containsExactly(oldestShared);
    assertThat(
            items(
                    owner
                        .get(
                            transactionPath(householdId)
                                + "?visibility=HOUSEHOLD&status=ALL&limit=100&offset=100")
                        .json())
                .size())
        .isEqualTo(21);
  }

  @Test
  void listRejectsInvalidVisibilityScopesAndCombinationsSafely() throws Exception {
    Agent actor = signedInAgent("scope-validation");
    String householdId = createHousehold(actor, "Scope validation home");
    createAccount(actor, householdId, UUID.randomUUID(), "Cash", "CASH", "BRL");
    String path = transactionPath(householdId);

    List<Resp> rejected =
        List.of(
            actor.get(path + "?visibility="),
            actor.get(path + "?visibility=ALL"),
            actor.get(path + "?visibility=private"),
            actor.get(path + "?visibility=OWNERSHIP"),
            actor.get(path + "?visibility=PRIVATE&visibility=HOUSEHOLD"),
            actor.get(path + "?view=HOUSEHOLD&visibility=HOUSEHOLD"),
            actor.get(path + "?view=HOUSEHOLD&visibility=PRIVATE"),
            actor.get(path + "?visibility=PRIVATE&offset=10001"),
            actor.get(path + "?visibility=HOUSEHOLD&limit=101"),
            actor.get(path + "?visibility=HOUSEHOLD&limit=0"),
            actor.get(path + "?visibility=PRIVATE&unexpected=x"),
            actor.get(path + "?visibility=PRIVATE&accountId=not-a-uuid"));
    for (Resp response : rejected) {
      assertThat(response.status).isEqualTo(400);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(response.json().path("correlationId").asText()).isNotBlank();
      assertThat(response.cacheControl()).contains("no-store");
      assertThat(response.body).doesNotContain("OWNERSHIP", "SQL", "at com.housesync");
    }
    Resp unknownScope = actor.get(path + "?visibility=OWNERSHIP");
    assertThat(unknownScope.status).isEqualTo(400);
    assertThat(unknownScope.json().path("fieldErrors").propertyNames())
        .containsExactly("visibility");
    Resp scopedHouseholdView = actor.get(path + "?view=HOUSEHOLD&visibility=HOUSEHOLD");
    assertThat(scopedHouseholdView.status).isEqualTo(400);
    assertThat(scopedHouseholdView.json().path("fieldErrors").propertyNames())
        .containsExactly("visibility");

    // The two documented scopes and their omission stay valid with the retained bounds.
    for (String query :
        List.of(
            "", "?visibility=PRIVATE", "?visibility=HOUSEHOLD", "?view=OWN&visibility=PRIVATE")) {
      Resp accepted = actor.get(path + query);
      assertThat(accepted.status).isEqualTo(200);
      assertThat(accepted.cacheControl()).contains("no-store");
      assertThat(items(accepted.json()).size()).isZero();
      assertThat(accepted.json().path("hasMore").asBoolean()).isFalse();
    }
    Resp cappedOffset = actor.get(path + "?visibility=PRIVATE&offset=10000");
    assertThat(cappedOffset.status).isEqualTo(200);
    assertThat(cappedOffset.json().path("offset").asInt()).isEqualTo(10000);

    // A scoped foreign account still resolves to the generic account 404, not a scope error.
    Resp foreignAccount = actor.get(path + "?visibility=HOUSEHOLD&accountId=" + UUID.randomUUID());
    assertThat(foreignAccount.status).isEqualTo(404);
    assertThat(foreignAccount.json().path("code").asText())
        .isEqualTo("FINANCIAL_ACCOUNT_NOT_FOUND");
  }

  @Test
  void visibilityScopeNeverWidensOwnershipMembershipOrTheHouseholdFeed() throws Exception {
    Agent owner = signedInAgent("scope-owner");
    String householdId = createHousehold(owner, "Scope privacy home");
    Agent member = signedInAgent("scope-member");
    addMember(householdId, member.userId(), "MEMBER");
    Agent outsider = signedInAgent("scope-outsider");
    String ownerAccount =
        createAccount(owner, householdId, UUID.randomUUID(), "Owner card", "CREDIT_CARD", "BRL");
    String memberAccount =
        createAccount(member, householdId, UUID.randomUUID(), "Member cash", "CASH", "BRL");

    String ownerShared =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                visibilityEntry(
                    ownerAccount,
                    "EXPENSE",
                    "-11.00",
                    "BRL",
                    "Owner shared",
                    "2026-09-10",
                    "HOUSEHOLD")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            visibilityEntry(
                ownerAccount,
                "EXPENSE",
                "-12.00",
                "BRL",
                "Owner private",
                "2026-09-11",
                "PRIVATE")));
    String memberShared =
        created(
            member.createTransaction(
                householdId,
                UUID.randomUUID(),
                visibilityEntry(
                    memberAccount,
                    "EXPENSE",
                    "-13.00",
                    "BRL",
                    "Member shared",
                    "2026-09-12",
                    "HOUSEHOLD")));
    created(
        member.createTransaction(
            householdId,
            UUID.randomUUID(),
            visibilityEntry(
                memberAccount,
                "EXPENSE",
                "-14.00",
                "BRL",
                "Member private",
                "2026-09-13",
                "PRIVATE")));

    JsonNode ownerSharedPage =
        owner.get(transactionPath(householdId) + "?visibility=HOUSEHOLD").json();
    assertThat(ids(ownerSharedPage)).containsExactly(ownerShared);
    assertThat(items(ownerSharedPage).get(0).path("accountId").asText()).isEqualTo(ownerAccount);
    assertThat(ownerSharedPage.toString())
        .doesNotContain("Owner private", "Member shared", "Member private");
    JsonNode ownerPrivatePage =
        owner.get(transactionPath(householdId) + "?visibility=PRIVATE").json();
    assertThat(items(ownerPrivatePage).size()).isEqualTo(1);
    assertThat(items(ownerPrivatePage).get(0).path("description").asText())
        .isEqualTo("Owner private");

    JsonNode memberSharedPage =
        member.get(transactionPath(householdId) + "?visibility=HOUSEHOLD").json();
    assertThat(ids(memberSharedPage)).containsExactly(memberShared);
    assertThat(items(memberSharedPage).get(0).path("accountId").asText()).isEqualTo(memberAccount);
    assertThat(memberSharedPage.toString())
        .doesNotContain("Member private", "Owner shared", "Owner private");

    // The household feed keeps its own authorization and non-owner account redaction.
    JsonNode feed = member.get(transactionPath(householdId) + "?view=HOUSEHOLD").json();
    assertThat(ids(feed)).containsExactly(memberShared, ownerShared);
    for (JsonNode row : items(feed)) {
      boolean ownEntry = row.path("id").asText().equals(memberShared);
      assertThat(row.path("accountId").isNull()).isEqualTo(!ownEntry);
    }
    assertThat(feed.toString()).doesNotContain("Owner private", "Member private");

    // An empty scoped page still validates membership instead of leaking or failing.
    Agent freshMember = signedInAgent("scope-fresh");
    addMember(householdId, freshMember.userId(), "MEMBER");
    JsonNode freshScoped =
        freshMember.get(transactionPath(householdId) + "?visibility=HOUSEHOLD").json();
    assertThat(items(freshScoped).size()).isZero();
    assertThat(freshScoped.path("hasMore").asBoolean()).isFalse();

    Resp outsiderScoped = outsider.get(transactionPath(householdId) + "?visibility=HOUSEHOLD");
    Resp outsiderFeed = outsider.get(transactionPath(householdId) + "?view=HOUSEHOLD");
    for (Resp response : List.of(outsiderScoped, outsiderFeed)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
      assertThat(response.body).doesNotContain("Owner shared", "Member shared", householdId);
    }

    // Authority loss closes the scoped feed exactly like the unscoped one, while the owner keeps
    // the departed member's retained shared entry.
    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
        householdId,
        member.userId());
    Resp removedScoped = member.get(transactionPath(householdId) + "?visibility=HOUSEHOLD");
    assertThat(removedScoped.status).isEqualTo(404);
    assertThat(removedScoped.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(removedScoped.body).doesNotContain("Member shared", memberShared);
    JsonNode ownerAfterDeparture =
        owner.get(transactionPath(householdId) + "?visibility=HOUSEHOLD").json();
    assertThat(ids(ownerAfterDeparture)).containsExactly(ownerShared);
  }

  @Test
  void detailIsolatesHiddenForeignAndNonMemberAccess() throws Exception {
    Agent owner = signedInAgent("detail-owner");
    String householdId = createHousehold(owner, "Privacy feed");
    Agent member = signedInAgent("detail-member");
    addMember(householdId, member.userId(), "MEMBER");
    String accountId =
        createAccount(member, householdId, UUID.randomUUID(), "Private", "CASH", "BRL");
    String transactionId =
        created(
            member.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-30.00", "BRL", "Snacks")));

    Resp ownDetail = member.get(transactionPath(householdId) + "/" + transactionId);
    assertThat(ownDetail.status).isEqualTo(200);
    assertThat(ownDetail.json().path("description").asText()).isEqualTo("Snacks");
    assertThat(ownDetail.json().path("accountId").asText()).isEqualTo(accountId);

    Resp hiddenForOwner = owner.get(transactionPath(householdId) + "/" + transactionId);
    Resp missing = owner.get(transactionPath(householdId) + "/" + UUID.randomUUID());
    for (Resp response : List.of(hiddenForOwner, missing)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
      assertThat(response.body).doesNotContain("Snacks", transactionId);
    }
    assertThat(hiddenForOwner.json().path("message").asText())
        .isEqualTo(missing.json().path("message").asText());

    Agent outsider = signedInAgent("detail-outsider");
    Resp outsiderDetail = outsider.get(transactionPath(householdId) + "/" + transactionId);
    Resp outsiderList = outsider.get(transactionPath(householdId));
    for (Resp response : List.of(outsiderDetail, outsiderList)) {
      assertThat(response.status).isEqualTo(404);
      assertThat(response.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
      assertThat(response.body).doesNotContain("Snacks", transactionId);
    }
  }

  @Test
  void categorizationProvenanceIsExactOwnerOnlyAndTracksUserAndRefundDecisions() throws Exception {
    Agent owner = signedInAgent("categorization-owner");
    String householdId = createHousehold(owner, "Categorization home");
    Agent member = signedInAgent("categorization-member");
    addMember(householdId, member.userId(), "MEMBER");
    Agent outsider = signedInAgent("categorization-outsider");
    String accountId =
        createAccount(owner, householdId, UUID.randomUUID(), "Card", "CREDIT_CARD", "BRL");

    Resp explicit =
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + accountId
                + "\",\"kind\":\"EXPENSE\",\"money\":{\"amount\":\"-20.00\","
                + "\"currency\":\"BRL\"},\"occurredOn\":\"2026-09-16\","
                + "\"description\":\"Shared groceries\",\"visibility\":\"HOUSEHOLD\","
                + "\"category\":\"GROCERIES\"}");
    String explicitId = created(explicit);
    assertThat(explicit.json().size()).isEqualTo(16);
    assertThat(member.get(transactionPath(householdId) + "/" + explicitId).status).isEqualTo(200);

    String categorizationPath = transactionPath(householdId) + "/" + explicitId + "/categorization";
    Resp provenance = owner.get(categorizationPath);
    assertThat(provenance.status).isEqualTo(200);
    assertThat(provenance.cacheControl()).contains("no-store");
    assertThat(provenance.json().propertyNames())
        .containsExactly(
            "transactionId",
            "transactionVersion",
            "category",
            "origin",
            "assignedAt",
            "reviewState",
            "ruleEligible");
    assertThat(provenance.json().path("transactionId").asText()).isEqualTo(explicitId);
    assertThat(provenance.json().path("transactionVersion").asInt()).isZero();
    assertThat(provenance.json().path("category").asText()).isEqualTo("GROCERIES");
    assertThat(provenance.json().path("origin").asText()).isEqualTo("USER");
    assertThat(provenance.json().path("assignedAt").asText()).isNotBlank();
    assertThat(provenance.json().path("reviewState").asText()).isEqualTo("NONE");
    // A USER entry with a safe key and no active rule may be learned, and the capability never
    // leaks the derived match key.
    assertThat(provenance.json().path("ruleEligible").isBoolean()).isTrue();
    assertThat(provenance.json().path("ruleEligible").asBoolean()).isTrue();
    assertThat(provenance.body).doesNotContain("shared groceries", "matchKey");

    Resp memberProvenance = member.get(categorizationPath);
    assertThat(memberProvenance.status).isEqualTo(404);
    assertThat(memberProvenance.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
    assertThat(memberProvenance.body).doesNotContain("GROCERIES", explicitId);
    Resp outsiderProvenance = outsider.get(categorizationPath);
    assertThat(outsiderProvenance.status).isEqualTo(404);
    assertThat(outsiderProvenance.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    assertThat(owner.get(categorizationPath + "?extra=true").status).isEqualTo(400);

    String uncategorizedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-50.00", "BRL", "Uncategorized")));
    Resp initialNone =
        owner.get(transactionPath(householdId) + "/" + uncategorizedId + "/categorization");
    assertThat(initialNone.json().path("origin").asText()).isEqualTo("NONE");
    assertThat(initialNone.json().path("category").isNull()).isTrue();
    // An uncategorized NONE entry has no category to learn.
    assertThat(initialNone.json().path("ruleEligible").asBoolean()).isFalse();

    Resp explicitNull =
        owner.patchTransaction(
            householdId, uncategorizedId, "{\"expectedVersion\":0,\"category\":null}");
    assertThat(explicitNull.status).isEqualTo(200);
    assertThat(explicitNull.json().path("version").asInt()).isEqualTo(1);
    Resp userNull =
        owner.get(transactionPath(householdId) + "/" + uncategorizedId + "/categorization");
    assertThat(userNull.json().path("origin").asText()).isEqualTo("USER");
    assertThat(userNull.json().path("category").isNull()).isTrue();
    // An explicitly uncategorized USER entry has no category to learn either.
    assertThat(userNull.json().path("ruleEligible").asBoolean()).isFalse();

    String refundId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, explicitId, "5.00", "2026-09-17", "Partial refund")));
    Resp inherited = owner.get(transactionPath(householdId) + "/" + refundId + "/categorization");
    assertThat(inherited.json().path("origin").asText()).isEqualTo("INHERITED");
    assertThat(inherited.json().path("category").asText()).isEqualTo("GROCERIES");
    // Refunds classify by inheritance and never learn rules.
    assertThat(inherited.json().path("ruleEligible").asBoolean()).isFalse();

    String voidedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-3.00", "BRL", "Voided uncategorized")));
    assertThat(
            owner.patchTransaction(
                    householdId, voidedId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}")
                .status)
        .isEqualTo(200);
    Resp voidedDecision =
        owner.patchTransaction(householdId, voidedId, "{\"expectedVersion\":1,\"category\":null}");
    assertThat(voidedDecision.status).isEqualTo(200);
    assertThat(voidedDecision.json().path("version").asInt()).isEqualTo(2);
    assertThat(
            owner
                .get(transactionPath(householdId) + "/" + voidedId + "/categorization")
                .json()
                .path("origin")
                .asText())
        .isEqualTo("USER");
    // A voided entry is no longer posted and cannot learn a rule.
    assertThat(
            owner
                .get(transactionPath(householdId) + "/" + voidedId + "/categorization")
                .json()
                .path("ruleEligible")
                .asBoolean())
        .isFalse();
  }

  @Test
  void refundLifecycleEnforcesSourceCapDatesKindsAndVoidDependencies() throws Exception {
    Agent actor = signedInAgent("refund-rules");
    String householdId = createHousehold(actor, "Refund home");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Card", "CREDIT_CARD", "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-100.00", "BRL", "Purchase")));

    Resp beforeExpense =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(accountId, expenseId, "10.00", "2026-09-15", "Early"));
    assertThat(beforeExpense.status).isEqualTo(409);
    assertThat(beforeExpense.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");
    assertThat(beforeExpense.body).doesNotContain("Purchase", "100.00");

    Resp first =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(accountId, expenseId, "60.00", "2026-09-16", "Partial"));
    assertThat(first.status).isEqualTo(201);
    String firstRefundId = created(first);
    assertThat(first.json().path("refundOfTransactionId").asText()).isEqualTo(expenseId);
    assertThat(first.json().path("visibility").asText()).isEqualTo("PRIVATE");

    Resp beyondCap =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(accountId, expenseId, "40.01", "2026-09-17", "Over"));
    assertThat(beyondCap.status).isEqualTo(409);
    assertThat(beyondCap.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");

    Resp exactCap =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(accountId, expenseId, "40.00", "2026-09-17", "Rest"));
    assertThat(exactCap.status).isEqualTo(201);
    String secondRefundId = created(exactCap);

    Resp shrinkExpense =
        actor.patchTransaction(
            householdId,
            expenseId,
            "{\"expectedVersion\":2,\"money\":{\"amount\":\"-90.00\",\"currency\":\"BRL\"}}");
    assertThat(shrinkExpense.status).isEqualTo(409);
    assertThat(shrinkExpense.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");
    Resp moveExpenseAfterRefunds =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":2,\"occurredOn\":\"2026-09-18\"}");
    assertThat(moveExpenseAfterRefunds.status).isEqualTo(409);
    Resp voidExpenseWithLiveRefunds =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":2,\"status\":\"VOIDED\"}");
    assertThat(voidExpenseWithLiveRefunds.status).isEqualTo(409);
    assertThat(voidExpenseWithLiveRefunds.json().path("code").asText())
        .isEqualTo("REFUND_CONFLICT");

    Resp voidRefund =
        actor.patchTransaction(
            householdId, secondRefundId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voidRefund.status).isEqualTo(200);
    assertThat(voidRefund.json().path("status").asText()).isEqualTo("VOIDED");
    assertThat(voidRefund.json().path("description").asText()).isEqualTo("Rest");
    assertThat(voidRefund.json().path("version").asInt()).isEqualTo(1);

    // Voiding one refund frees the cap; each state-changing refund group operation
    // also moves the source expense version for stale-form protection.
    Resp freedRefund =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(accountId, expenseId, "10.00", "2026-09-17", "Reuse"));
    assertThat(freedRefund.status).isEqualTo(201);
    String freedRefundId = created(freedRefund);
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                expenseId))
        .isEqualTo(4);

    Resp voidExpenseAgain =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":4,\"status\":\"VOIDED\"}");
    assertThat(voidExpenseAgain.status).isEqualTo(409);
    assertThat(voidExpenseAgain.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");

    Resp voidOtherRefund =
        actor.patchTransaction(
            householdId, firstRefundId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    Resp voidFreedRefund =
        actor.patchTransaction(
            householdId, freedRefundId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voidOtherRefund.status).isEqualTo(200);
    assertThat(voidFreedRefund.status).isEqualTo(200);
    Resp voidExpenseNow =
        actor.patchTransaction(
            householdId, expenseId, "{\"expectedVersion\":6,\"status\":\"VOIDED\"}");
    assertThat(voidExpenseNow.status).isEqualTo(200);
    assertThat(voidExpenseNow.json().path("version").asInt()).isEqualTo(7);
  }

  @Test
  void refundSourcesRequireSameAccountAndDirectRefundVisibilityPatchesAreRejected()
      throws Exception {
    Agent actor = signedInAgent("refund-sources");
    String householdId = createHousehold(actor, "Sources home");
    String brl = createAccount(actor, householdId, UUID.randomUUID(), "BRL", "CHECKING", "BRL");
    String otherAccount =
        createAccount(actor, householdId, UUID.randomUUID(), "USD", "SAVINGS", "USD");
    String incomeId =
        created(
            actor.createTransaction(
                householdId, UUID.randomUUID(), entry(brl, "INCOME", "50.00", "BRL", "Wage")));
    String otherExpenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(otherAccount, "EXPENSE", "-70.00", "USD", "Other")));

    Resp incomeSource =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(brl, incomeId, "10.00", "2026-09-16", "Return"));
    assertThat(incomeSource.status).isEqualTo(409);
    assertThat(incomeSource.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");
    Resp crossAccountSource =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(brl, otherExpenseId, "10.00", "2026-09-16", "Return"));
    assertThat(crossAccountSource.status).isEqualTo(409);
    assertThat(crossAccountSource.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");
    Resp missingSource =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(brl, UUID.randomUUID().toString(), "10.00", "2026-09-16", "Return"));
    assertThat(missingSource.status).isEqualTo(404);
    assertThat(missingSource.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");

    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(brl, "EXPENSE", "-50.00", "BRL", "Returnable")));
    String refundId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                "{\"accountId\":\""
                    + brl
                    + "\",\"kind\":\"REFUND\","
                    + "\"money\":{\"amount\":\"5.00\",\"currency\":\"BRL\"},"
                    + "\"occurredOn\":\"2026-09-16\",\"description\":\"Return\","
                    + "\"refundOfTransactionId\":\""
                    + expenseId
                    + "\"}"));

    Resp directVisibility =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":0,\"visibility\":\"PRIVATE\"}");
    assertThat(directVisibility.status).isEqualTo(400);
    assertThat(directVisibility.json().path("fieldErrors").propertyNames())
        .containsExactly("visibility");

    Resp explicitMatch =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + brl
                + "\",\"kind\":\"REFUND\","
                + "\"money\":{\"amount\":\"5.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Matched\","
                + "\"visibility\":\"PRIVATE\",\"refundOfTransactionId\":\""
                + expenseId
                + "\"}");
    assertThat(explicitMatch.status).isEqualTo(201);
  }

  @Test
  void refundCorrectionsEnforceCapDateOrderingAndVersionRules() throws Exception {
    Agent actor = signedInAgent("refund-correction");
    String householdId = createHousehold(actor, "Correction refund home");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Card", "CREDIT_CARD", "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-100.00", "BRL", "Purchase")));
    String refundId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "60.00", "2026-09-16", "Partial")));
    String secondRefundId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "20.00", "2026-09-17", "Extra")));

    // Successful amount correction: live posted sum stays within the expense bound.
    Resp corrected =
        actor.patchTransaction(
            householdId,
            refundId,
            "{\"expectedVersion\":0,\"money\":{\"amount\":\"30.00\",\"currency\":\"BRL\"}}");
    assertThat(corrected.status).isEqualTo(200);
    assertThat(moneyAmount(corrected.json())).isEqualTo("30.00");
    assertThat(corrected.json().path("version").asInt()).isEqualTo(1);

    // A state-changing refund correction also moves the source expense version.
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                expenseId))
        .isEqualTo(3);

    // Correcting above the remaining bound conflicts under the locked group.
    Resp overCap =
        actor.patchTransaction(
            householdId,
            refundId,
            "{\"expectedVersion\":1,\"money\":{\"amount\":\"90.00\",\"currency\":\"BRL\"}}");
    assertThat(overCap.status).isEqualTo(409);
    assertThat(overCap.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");
    assertThat(overCap.body).doesNotContain("90.00", "100.00");

    // Correcting the refund date before its source expense conflicts.
    Resp beforeSource =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":1,\"occurredOn\":\"2026-09-15\"}");
    assertThat(beforeSource.status).isEqualTo(409);
    assertThat(beforeSource.json().path("code").asText()).isEqualTo("REFUND_CONFLICT");

    // A stale form cannot correct a refund whose group was just changed.
    Resp stale =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":0,\"description\":\"Stale\"}");
    assertThat(stale.status).isEqualTo(409);
    assertThat(stale.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");

    // Description-only correction succeeds and bumps the refund version.
    Resp described =
        actor.patchTransaction(
            householdId,
            refundId,
            "{\"expectedVersion\":1,\"description\":\"  Adjusted partial  \"}");
    assertThat(described.status).isEqualTo(200);
    assertThat(described.json().path("description").asText()).isEqualTo("Adjusted partial");
    assertThat(described.json().path("version").asInt()).isEqualTo(2);

    // A no-op refund correction bumps nothing: neither the refund nor its source expense.
    Resp refundNoOp =
        actor.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":2,\"description\":\"Adjusted partial\"}");
    assertThat(refundNoOp.status).isEqualTo(200);
    assertThat(refundNoOp.json().path("version").asInt()).isEqualTo(2);
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                expenseId))
        .isEqualTo(4);

    // The untouched second refund still stands and the posted sum stays conserved.
    Resp secondDetail = actor.get(transactionPath(householdId) + "/" + secondRefundId);
    assertThat(moneyAmount(secondDetail.json())).isEqualTo("20.00");
    assertThat(secondDetail.json().path("status").asText()).isEqualTo("POSTED");
  }

  @Test
  void otherMembersCannotReadOrCorrectAnotherMembersRefund() throws Exception {
    Agent owner = signedInAgent("refund-privacy-owner");
    String householdId = createHousehold(owner, "Refund privacy home");
    Agent member = signedInAgent("refund-privacy-member");
    addMember(householdId, member.userId(), "MEMBER");
    String accountId =
        createAccount(member, householdId, UUID.randomUUID(), "Private card", "CASH", "BRL");
    String expenseId =
        created(
            member.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-50.00", "BRL", "Snack run")));
    String refundId =
        created(
            member.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "10.00", "2026-09-16", "Return")));

    Resp hiddenDetail = owner.get(transactionPath(householdId) + "/" + refundId);
    assertThat(hiddenDetail.status).isEqualTo(404);
    assertThat(hiddenDetail.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
    assertThat(hiddenDetail.body).doesNotContain("Return", refundId, expenseId);

    Resp forbiddenPatch =
        owner.patchTransaction(
            householdId, refundId, "{\"expectedVersion\":0,\"description\":\"Stolen edit\"}");
    assertThat(forbiddenPatch.status).isEqualTo(404);
    assertThat(forbiddenPatch.json().path("code").asText()).isEqualTo("TRANSACTION_NOT_FOUND");
    assertThat(forbiddenPatch.body).doesNotContain("Stolen edit");

    // The owner's OWN feed shows nothing of the member's private refund group.
    assertThat(items(owner.get(transactionPath(householdId)).json()).size()).isZero();
    JsonNode ownList = member.get(transactionPath(householdId)).json();
    assertThat(items(ownList).size()).isEqualTo(2);
    // Same-day ordering is createdAt DESC: the refund precedes its expense.
    assertThat(items(ownList).get(0).path("refundOfTransactionId").asText()).isEqualTo(expenseId);
    assertThat(items(ownList).get(1).path("description").asText()).isEqualTo("Snack run");
  }

  @Test
  void concurrentRefundsSerializeThroughTheCap() throws Exception {
    Agent actor = signedInAgent("refund-race");
    String householdId = createHousehold(actor, "Race refund home");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Card", "CHECKING", "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-100.00", "BRL", "Race")));

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Future<Resp>> futures = new ArrayList<>();
      for (int index = 0; index < 2; index++) {
        String tag = String.valueOf(index);
        futures.add(
            pool.submit(
                () -> {
                  start.await(10, TimeUnit.SECONDS);
                  return actor.createTransaction(
                      householdId,
                      UUID.randomUUID(),
                      refundEntry(
                          accountId, expenseId, "60.00", "2026-09-16", "Concurrent " + tag));
                }));
      }
      start.countDown();
      Resp first = futures.get(0).get(30, TimeUnit.SECONDS);
      Resp second = futures.get(1).get(30, TimeUnit.SECONDS);
      assertThat(List.of(first.status, second.status)).containsExactlyInAnyOrder(201, 409);
    } finally {
      pool.shutdownNow();
    }
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions"
                    + " WHERE refund_of_transaction_id = ?::uuid AND status = 'POSTED'",
                Integer.class,
                expenseId))
        .isEqualTo(1);
  }

  @Test
  void concurrentSiblingRefundCorrectionsSerializeWithoutDeadlock() throws Exception {
    Agent actor = signedInAgent("sibling-corrections");
    String householdId = createHousehold(actor, "Sibling home");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Card", "CHECKING", "BRL");
    String expenseId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-100.00", "BRL", "Purchase")));
    String siblingOne =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "40.00", "2026-09-16", "Sibling one")));
    String siblingTwo =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                refundEntry(accountId, expenseId, "30.00", "2026-09-17", "Sibling two")));

    // Order the siblings by UUID so the concurrent pair always includes the case the
    // contract forbids: a patch whose target sorts after a sibling must not lock the
    // target before the lower sibling.
    String lowerSibling = siblingOne.compareTo(siblingTwo) < 0 ? siblingOne : siblingTwo;
    String higherSibling = lowerSibling.equals(siblingOne) ? siblingTwo : siblingOne;
    // The lower sibling is corrected to 20.00; the higher keeps its original amount, so
    // the expected posted sum depends on which row sorts lower.
    String higherOriginalAmount = higherSibling.equals(siblingOne) ? "40.000" : "30.000";

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<Resp> correctingLower =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return actor.patchTransaction(
                    householdId,
                    lowerSibling,
                    "{\"expectedVersion\":0,\"money\":{\"amount\":\"20.00\",\"currency\":\"BRL\"}}");
              });
      Future<Resp> correctingHigher =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return actor.patchTransaction(
                    householdId,
                    higherSibling,
                    "{\"expectedVersion\":0,\"occurredOn\":\"2026-09-18\"}");
              });
      start.countDown();
      Resp lower = correctingLower.get(30, TimeUnit.SECONDS);
      Resp higher = correctingHigher.get(30, TimeUnit.SECONDS);
      // Serialized by the household lock; the ordered group lock must neither deadlock
      // nor hit the bounded lock timeout while siblings correct different rows.
      assertThat(lower.status).isEqualTo(200);
      assertThat(higher.status).isEqualTo(200);
      assertThat(lower.json().path("version").asInt()).isEqualTo(1);
      assertThat(higher.json().path("version").asInt()).isEqualTo(1);
    } finally {
      pool.shutdownNow();
    }

    java.math.BigDecimal postedSum =
        jdbc.queryForObject(
            "SELECT COALESCE(SUM(amount), 0) FROM financial_transactions"
                + " WHERE refund_of_transaction_id = ?::uuid AND status = 'POSTED'",
            java.math.BigDecimal.class,
            expenseId);
    java.math.BigDecimal expectedSum =
        new java.math.BigDecimal("20.000").add(new java.math.BigDecimal(higherOriginalAmount));
    assertThat(postedSum.compareTo(expectedSum)).isZero();
    assertThat(moneyAmount(actor.get(transactionPath(householdId) + "/" + lowerSibling).json()))
        .isEqualTo("20.00");
    assertThat(
            actor
                .get(transactionPath(householdId) + "/" + higherSibling)
                .json()
                .path("occurredOn")
                .asText())
        .isEqualTo("2026-09-18");
    assertThat(
            jdbc.queryForObject(
                "SELECT version FROM financial_transactions WHERE id = ?::uuid",
                Integer.class,
                expenseId))
        .isEqualTo(4);
  }

  @Test
  void createIsDurablyIdempotentReplaysCurrentStateAndRejectsChangedPayloads() throws Exception {
    Agent actor = signedInAgent("idempotency-tx");
    String householdId = createHousehold(actor, "Retry ledger");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Card", "CHECKING", "BRL");
    UUID key = UUID.randomUUID();

    String payload =
        "{\"accountId\":\""
            + accountId
            + "\",\"kind\":\"EXPENSE\","
            + "\"money\":{\"amount\":\"-1.00\",\"currency\":\"BRL\"},"
            + "\"occurredOn\":\"2026-09-16\",\"description\":\"Groceries\"}";

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Future<Resp>> futures = new ArrayList<>();
      for (int index = 0; index < 2; index++) {
        futures.add(
            pool.submit(
                () -> {
                  start.await(10, TimeUnit.SECONDS);
                  return actor.createTransaction(householdId, key, payload);
                }));
      }
      start.countDown();
      Resp first = futures.get(0).get(30, TimeUnit.SECONDS);
      Resp second = futures.get(1).get(30, TimeUnit.SECONDS);
      assertThat(List.of(first.status, second.status)).containsExactlyInAnyOrder(200, 201);
      assertThat(first.json().path("id").asText()).isEqualTo(second.json().path("id").asText());
    } finally {
      pool.shutdownNow();
    }

    String createdId =
        jdbc.queryForObject(
            "SELECT resource_id FROM financial_transaction_idempotency_keys"
                + " WHERE household_id = ?::uuid LIMIT 1",
            String.class,
            householdId);

    Resp changedPayload =
        actor.createTransaction(
            householdId,
            key,
            "{\"accountId\":\""
                + accountId
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":\"-13.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Groceries\"}");
    assertThat(changedPayload.status).isEqualTo(409);
    assertThat(changedPayload.json().path("code").asText()).isEqualTo("IDEMPOTENCY_CONFLICT");
    assertThat(changedPayload.body).doesNotContain("13.00", key.toString());

    // Fewer fractional digits with the same numeric value share one fingerprint.
    Resp equivalentMoney =
        actor.createTransaction(
            householdId,
            key,
            "{\"accountId\":\""
                + accountId
                + "\",\"kind\":\"EXPENSE\","
                + "\"money\":{\"amount\":\"-1\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Groceries\"}");
    assertThat(equivalentMoney.status).isEqualTo(200);
    assertThat(equivalentMoney.json().path("id").asText())
        .isEqualTo(
            jdbc.queryForObject(
                "SELECT resource_id FROM financial_transaction_idempotency_keys"
                    + " WHERE household_id = ?::uuid LIMIT 1",
                String.class,
                householdId));

    Resp corrected =
        actor.patchTransaction(
            householdId, createdId, "{\"expectedVersion\":0,\"description\":\"  Market run  \"}");
    assertThat(corrected.status).isEqualTo(200);
    Resp voided =
        actor.patchTransaction(
            householdId, createdId, "{\"expectedVersion\":1,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);

    Resp replayAfterVoid = actor.createTransaction(householdId, key, payload);
    assertThat(replayAfterVoid.status).isEqualTo(200);
    assertThat(replayAfterVoid.json().path("id").asText()).isEqualTo(createdId);
    assertThat(replayAfterVoid.json().path("description").asText()).isEqualTo("Market run");
    assertThat(replayAfterVoid.json().path("status").asText()).isEqualTo("VOIDED");
    assertThat(replayAfterVoid.json().path("version").asInt()).isEqualTo(2);
    assertThat(replayAfterVoid.cacheControl()).contains("no-store");
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isEqualTo(1);
  }

  @Test
  void patchSupportsCorrectionVoidNoOpVersionConflictsAndExhaustion() throws Exception {
    Agent actor = signedInAgent("patching-tx");
    String householdId = createHousehold(actor, "Correction home");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Card", "SAVINGS", "EUR");
    String transactionId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-25.00", "EUR", "Fuel")));

    Resp corrected =
        actor.patchTransaction(
            householdId,
            transactionId,
            "{\"expectedVersion\":0,\"money\":{\"amount\":\"-25.5\",\"currency\":\"EUR\"},"
                + "\"occurredOn\":\"2026-09-17\",\"description\":\"  Fuel top-up  \"}");
    assertThat(corrected.status).isEqualTo(200);
    assertThat(moneyAmount(corrected.json())).isEqualTo("-25.50");
    assertThat(corrected.json().path("occurredOn").asText()).isEqualTo("2026-09-17");
    assertThat(corrected.json().path("description").asText()).isEqualTo("Fuel top-up");
    assertThat(corrected.json().path("version").asInt()).isEqualTo(1);

    Resp stale =
        actor.patchTransaction(
            householdId, transactionId, "{\"expectedVersion\":0,\"description\":\"Stale\"}");
    assertThat(stale.status).isEqualTo(409);
    assertThat(stale.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");
    assertThat(stale.body).doesNotContain("Fuel");

    Resp noOp =
        actor.patchTransaction(
            householdId,
            transactionId,
            "{\"expectedVersion\":1,\"money\":{\"amount\":\"-25.50\",\"currency\":\"EUR\"},"
                + "\"description\":\"Fuel top-up\",\"visibility\":\"PRIVATE\"}");
    assertThat(noOp.status).isEqualTo(200);
    assertThat(noOp.json().path("version").asInt()).isEqualTo(1);

    Resp wrongSign =
        actor.patchTransaction(
            householdId,
            transactionId,
            "{\"expectedVersion\":1,\"money\":{\"amount\":\"25.50\",\"currency\":\"EUR\"}}");
    assertThat(wrongSign.status).isEqualTo(400);
    assertThat(wrongSign.json().path("fieldErrors").has("money.amount")).isTrue();

    Resp statusWithOtherField =
        actor.patchTransaction(
            householdId,
            transactionId,
            "{\"expectedVersion\":1,\"status\":\"VOIDED\",\"description\":\"Void\"}");
    assertThat(statusWithOtherField.status).isEqualTo(400);

    Resp postedStatus =
        actor.patchTransaction(
            householdId, transactionId, "{\"expectedVersion\":1,\"status\":\"POSTED\"}");
    assertThat(postedStatus.status).isEqualTo(400);

    // Sharing accepts the disclosed visibility on the owner's own entry.
    Resp householdVisibility =
        actor.patchTransaction(
            householdId, transactionId, "{\"expectedVersion\":1,\"visibility\":\"HOUSEHOLD\"}");
    assertThat(householdVisibility.status).isEqualTo(200);
    assertThat(householdVisibility.json().path("visibility").asText()).isEqualTo("HOUSEHOLD");
    assertThat(householdVisibility.json().path("version").asInt()).isEqualTo(2);

    // Version exhaustion fails safely on a posted entry; no-op touches still return 200.
    jdbc.update(
        "UPDATE financial_transactions SET version = 2147483647 WHERE id = ?::uuid", transactionId);
    Resp exhausted =
        actor.patchTransaction(
            householdId,
            transactionId,
            "{\"expectedVersion\":2147483647,\"description\":\"Changed\"}");
    assertThat(exhausted.status).isEqualTo(409);
    assertThat(exhausted.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    Resp noOpAtMax =
        actor.patchTransaction(
            householdId,
            transactionId,
            "{\"expectedVersion\":2147483647,\"description\":\"Fuel top-up\"}");
    assertThat(noOpAtMax.status).isEqualTo(200);
    assertThat(noOpAtMax.json().path("version").asInt()).isEqualTo(2147483647);
    jdbc.update("UPDATE financial_transactions SET version = 1 WHERE id = ?::uuid", transactionId);

    Resp voided =
        actor.patchTransaction(
            householdId, transactionId, "{\"expectedVersion\":1,\"status\":\"VOIDED\"}");
    assertThat(voided.status).isEqualTo(200);
    assertThat(voided.json().path("status").asText()).isEqualTo("VOIDED");
    assertThat(moneyAmount(voided.json())).isEqualTo("-25.50");

    Resp voidNoOp =
        actor.patchTransaction(
            householdId, transactionId, "{\"expectedVersion\":2,\"status\":\"VOIDED\"}");
    assertThat(voidNoOp.status).isEqualTo(200);
    assertThat(voidNoOp.json().path("version").asInt()).isEqualTo(2);

    Resp editVoided =
        actor.patchTransaction(
            householdId,
            transactionId,
            "{\"expectedVersion\":2,\"money\":{\"amount\":\"-9.00\",\"currency\":\"EUR\"}}");
    assertThat(editVoided.status).isEqualTo(409);
    assertThat(editVoided.json().path("code").asText()).isEqualTo("TRANSACTION_VOIDED");
  }

  @Test
  void archivedAccountBlocksCreatesButRetainsHistoryAndCorrections() throws Exception {
    Agent actor = signedInAgent("archived-account");
    String householdId = createHousehold(actor, "Archive home");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Old card", "CHECKING", "BRL");
    String transactionId =
        created(
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                entry(accountId, "EXPENSE", "-8.00", "BRL", "Coffee")));

    Resp archived =
        actor.patchAccount(
            householdId, accountId, "{\"expectedVersion\":0,\"status\":\"ARCHIVED\"}");
    assertThat(archived.status).isEqualTo(200);

    Resp blockedCreate =
        actor.createTransaction(
            householdId, UUID.randomUUID(), entry(accountId, "EXPENSE", "-3.00", "BRL", "Blocked"));
    assertThat(blockedCreate.status).isEqualTo(409);
    assertThat(blockedCreate.json().path("code").asText()).isEqualTo("ACCOUNT_ARCHIVED");
    assertThat(blockedCreate.body).doesNotContain("Coffee", "Old card");

    Resp correction =
        actor.patchTransaction(
            householdId, transactionId, "{\"expectedVersion\":0,\"description\":\"Coffee beans\"}");
    assertThat(correction.status).isEqualTo(200);
    assertThat(items(actor.get(transactionPath(householdId)).json()).size()).isEqualTo(1);
  }

  @Test
  void removalSerializesWithCreateAndRetainedOwnershipReturnsAfterRejoin() throws Exception {
    Agent owner = signedInAgent("owner-race-tx");
    String householdId = createHousehold(owner, "Lifecycle ledger");
    Agent member = signedInAgent("member-race-tx");
    String memberId = member.userId();
    addMember(householdId, memberId, "MEMBER");
    String accountId =
        createAccount(member, householdId, UUID.randomUUID(), "Race card", "CASH", "USD");
    UUID key = UUID.randomUUID();
    String payload = entry(accountId, "EXPENSE", "-5.00", "USD", "Race entry");

    CountDownLatch start = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    Resp create;
    Resp remove;
    try {
      Future<Resp> creating =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return member.createTransaction(householdId, key, payload);
              });
      Future<Resp> removing =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "DELETE",
                    "/api/households/" + householdId + "/members/" + memberId,
                    null,
                    owner.csrfToken,
                    null);
              });
      start.countDown();
      create = creating.get(30, TimeUnit.SECONDS);
      remove = removing.get(30, TimeUnit.SECONDS);
    } finally {
      pool.shutdownNow();
    }

    assertThat(remove.status).isEqualTo(204);
    assertThat(create.status).isIn(201, 404);
    int retained =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid"
                + " AND owner_user_id = ?::uuid",
            Integer.class,
            householdId,
            memberId);
    assertThat(retained).isEqualTo(create.status == 201 ? 1 : 0);
    Resp revoked = member.get(transactionPath(householdId));
    assertThat(revoked.status).isEqualTo(404);
    assertThat(revoked.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    String revokedDetailId = retained == 1 ? created(create) : UUID.randomUUID().toString();
    Resp revokedDetail = member.get(transactionPath(householdId) + "/" + revokedDetailId);
    assertThat(revokedDetail.status).isEqualTo(404);
    Resp revokedReplay = member.createTransaction(householdId, key, payload);
    assertThat(revokedReplay.status).isEqualTo(404);
    assertThat(revokedReplay.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    addMember(householdId, memberId, "MEMBER");
    JsonNode restored = member.get(transactionPath(householdId)).json();
    assertThat(items(restored).size()).isEqualTo(retained);
    if (retained == 1) {
      assertThat(items(restored).get(0).path("description").asText()).isEqualTo("Race entry");
      Resp rejoinedReplay = member.createTransaction(householdId, key, payload);
      assertThat(rejoinedReplay.status).isEqualTo(200);
      assertThat(rejoinedReplay.json().path("id").asText()).isEqualTo(created(create));
    }
    assertThat(items(owner.get(transactionPath(householdId)).json()).size()).isZero();
  }

  @Test
  void heldHouseholdLockTimesOutCreateWith503AndNoPartialState() throws Exception {
    Agent actor = signedInAgent("busy-tx");
    String householdId = createHousehold(actor, "Busy ledger");
    String accountId =
        createAccount(actor, householdId, UUID.randomUUID(), "Blocked card", "CASH", "BRL");
    UUID key = UUID.randomUUID();
    String payload = entry(accountId, "EXPENSE", "-1.00", "BRL", "Blocked");

    try (Connection connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (PreparedStatement lock =
          connection.prepareStatement("SELECT id FROM households WHERE id = ?::uuid FOR UPDATE")) {
        lock.setString(1, householdId);
        try (ResultSet rows = lock.executeQuery()) {
          assertThat(rows.next()).isTrue();
        }
        Resp busy = actor.createTransaction(householdId, key, payload);
        assertThat(busy.status).isEqualTo(503);
        assertThat(busy.json().path("code").asText()).isEqualTo("FINANCE_BUSY");
        assertThat(busy.cacheControl()).contains("no-store");
        assertThat(busy.body).doesNotContain("Blocked");
      } finally {
        connection.rollback();
      }
    }

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transaction_idempotency_keys"
                    + " WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();

    Resp retry = actor.createTransaction(householdId, key, payload);
    assertThat(retry.status).isEqualTo(201);
    assertThat(retry.json().path("description").asText()).isEqualTo("Blocked");
  }

  @Test
  void strictValidationRejectsForgedFieldsQueriesDuplicateKeysAndMalformedInput() throws Exception {
    Agent actor = signedInAgent("validation-tx");
    String householdId = createHousehold(actor, "Validation ledger");
    String accountId = createAccount(actor, householdId, UUID.randomUUID(), "Card", "CASH", "BRL");
    String path = transactionPath(householdId);
    String validBody = entry(accountId, "EXPENSE", "-1.00", "BRL", "Ok");

    List<Resp> rejected =
        List.of(
            actor.createTransaction(householdId, UUID.randomUUID(), "{}"),
            actor.createTransaction(
                householdId, UUID.randomUUID(), entry(accountId, "CHARGE", "-1.00", "BRL", "Bad")),
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                "{\"accountId\":\""
                    + accountId
                    + "\",\"kind\":\"EXPENSE\","
                    + "\"money\":{\"amount\":\"-1.00\",\"currency\":\"BRL\",\"extra\":true},"
                    + "\"occurredOn\":\"2026-09-16\",\"description\":\"Bad\"}"),
            // Server-managed fields are never create-request fields.
            actor.createTransaction(
                householdId,
                UUID.randomUUID(),
                "{\"accountId\":\""
                    + accountId
                    + "\",\"kind\":\"EXPENSE\","
                    + "\"money\":{\"amount\":\"-1.00\",\"currency\":\"BRL\"},"
                    + "\"occurredOn\":\"2026-09-16\",\"description\":\"Bad\","
                    + "\"version\":3}"),
            actor.request("POST", path, validBody, actor.csrfToken, null),
            actor.raw("POST", path, validBody, actor.csrfToken, "not-a-uuid", "application/json"),
            actor.request("POST", path, "{not json", actor.csrfToken, UUID.randomUUID()),
            actor.request(
                "POST", path + "?unexpected=x", validBody, actor.csrfToken, UUID.randomUUID()),
            actor.get(path + "?limit=1&limit=2"),
            actor.get(path + "?limit=01"),
            actor.get(path + "?offset=10001"),
            actor.get(path + "?view=private"),
            actor.get(path + "?status=LIVE"),
            actor.get(path + "?currency=CHF"),
            actor.get(path + "?from=2026-09-01"),
            actor.get(path + "?from=2026-09-02&to=2026-09-01"),
            actor.get(path + "?from=not-a-date&to=2026-09-02"),
            actor.get(path + "/not-a-uuid"));
    for (Resp response : rejected) {
      assertThat(response.status).isEqualTo(400);
      assertThat(response.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(response.json().path("correlationId").asText()).isNotBlank();
      assertThat(response.cacheControl()).contains("no-store");
      assertThat(response.body).doesNotContain("SQL", "at com.housesync");
    }

    // Connected finance admits CAD as a supported currency across the transaction boundary.
    Resp cadFilter = actor.get(path + "?currency=CAD");
    assertThat(cadFilter.status).isEqualTo(200);
    assertThat(cadFilter.cacheControl()).contains("no-store");

    Resp duplicateKey =
        actor.createTransaction(
            householdId,
            UUID.randomUUID(),
            "{\"accountId\":\""
                + accountId
                + "\",\"accountId\":\""
                + accountId
                + "\","
                + "\"kind\":\"EXPENSE\",\"money\":{\"amount\":\"-1.00\",\"currency\":\"BRL\"},"
                + "\"occurredOn\":\"2026-09-16\",\"description\":\"Bad\"}");
    assertThat(duplicateKey.status).isEqualTo(400);

    Resp partialMoneyPatch =
        actor.patchTransaction(
            householdId,
            UUID.randomUUID().toString(),
            "{\"expectedVersion\":0,\"money\":{\"amount\":\"-1.00\"}}");
    assertThat(partialMoneyPatch.status).isEqualTo(400);
    assertThat(partialMoneyPatch.json().path("fieldErrors").propertyNames())
        .containsExactly("money.currency");

    Resp noChangePatch =
        actor.patchTransaction(
            householdId, UUID.randomUUID().toString(), "{\"expectedVersion\":0}");
    assertThat(noChangePatch.status).isEqualTo(400);
    assertThat(noChangePatch.json().has("fieldErrors")).isFalse();

    Resp unsupportedMedia =
        actor.raw(
            "PATCH", path + "/" + UUID.randomUUID(), "{}", actor.csrfToken, null, "text/plain");
    assertThat(unsupportedMedia.status).isEqualTo(415);
    assertThat(unsupportedMedia.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM financial_transactions WHERE household_id = ?::uuid",
                Integer.class,
                householdId))
        .isZero();
  }

  @Test
  void anonymousAndMissingCsrfRequestsUseExistingSecurityContract() throws Exception {
    Agent anonymous = new Agent();
    String householdId = UUID.randomUUID().toString();
    Resp get = anonymous.get(transactionPath(householdId));
    assertThat(get.status).isEqualTo(401);
    assertThat(get.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");

    Agent actor = signedInAgent("csrf-tx");
    householdId = createHousehold(actor, "CSRF ledger");
    Resp rejected =
        actor.request(
            "POST",
            transactionPath(householdId),
            entry(UUID.randomUUID().toString(), "EXPENSE", "-1.00", "BRL", "No csrf"),
            null,
            UUID.randomUUID());
    assertThat(rejected.status).isEqualTo(403);
    assertThat(rejected.json().path("code").asText()).isEqualTo("CSRF_INVALID");
  }

  /** Exact signed entry body; money is a string and defaults stay implicit. */
  private static String entry(
      String accountId, String kind, String amount, String currency, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\""
        + kind
        + "\",\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\"}";
  }

  /** Dated variant for out-of-range and refund date-ordering cases. */
  private static String entry(
      String accountId,
      String kind,
      String amount,
      String currency,
      String description,
      String date) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\""
        + kind
        + "\",\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},\"occurredOn\":\""
        + date
        + "\",\"description\":\""
        + description
        + "\"}";
  }

  /** Refund-shaped entry body referencing a source expense in the same account. */
  private static String refundEntry(
      String accountId, String sourceId, String amount, String date, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\"BRL\"},"
        + "\"occurredOn\":\""
        + date
        + "\",\"description\":\""
        + description
        + "\","
        + "\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  /** Dated entry body with an explicit disclosure scope for the own-view scope filter cases. */
  private static String visibilityEntry(
      String accountId,
      String kind,
      String amount,
      String currency,
      String description,
      String date,
      String visibility) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\""
        + kind
        + "\",\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},\"occurredOn\":\""
        + date
        + "\",\"description\":\""
        + description
        + "\",\"visibility\":\""
        + visibility
        + "\"}";
  }

  /**
   * Bulk-loads {@code count} older HOUSEHOLD entries (2026-01-02 upward) as the page-boundary
   * fixture and returns their ids in the contractual order. Direct fixture volume is deliberate:
   * the rows that anchor each boundary are still created through the real create contract.
   */
  private List<String> insertSharedHistory(
      String householdId, String ownerUserId, String accountId, int count) {
    jdbc.update(
        "INSERT INTO financial_transactions (id, household_id, owner_user_id, account_id, kind,"
            + " amount, currency, occurred_on, description, source, visibility, status, category,"
            + " category_origin, category_assigned_at, version, created_at, updated_at)"
            + " SELECT gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, 'EXPENSE', -1.00, 'BRL',"
            + " DATE '2026-01-01' + gs, 'Shared ' || gs, 'MANUAL', 'HOUSEHOLD', 'POSTED', NULL,"
            + " 'NONE', now(), 0, now(), now() FROM generate_series(1, ?) AS gs",
        householdId,
        ownerUserId,
        accountId,
        count);
    return jdbc.queryForList(
        "SELECT id::text FROM financial_transactions"
            + " WHERE household_id = ?::uuid AND owner_user_id = ?::uuid"
            + " AND visibility = 'HOUSEHOLD'"
            + " ORDER BY occurred_on DESC, created_at DESC, id DESC",
        String.class,
        householdId,
        ownerUserId);
  }

  private static List<String> ids(JsonNode list) {
    List<String> ids = new ArrayList<>();
    for (JsonNode item : items(list)) {
      ids.add(item.path("id").asText());
    }
    return ids;
  }

  private static String moneyAmount(JsonNode transaction) {
    return transaction.path("money").path("amount").asText();
  }

  private static JsonNode items(JsonNode list) {
    return list.path("items");
  }

  private static String created(Resp response) throws Exception {
    assertThat(response.status).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String transactionPath(String householdId) {
    return "/api/households/" + householdId + "/transactions";
  }

  private Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String email =
        tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    String enrollmentCode = grants.issue("ENROLLMENT", email).code();
    String registration = registrationJson(email, enrollmentCode);
    assertThat(agent.post("/api/auth/register", registration, agent.csrfToken()).status)
        .isEqualTo(201);
    assertThat(agent.post("/api/auth/login", identityJson(email), agent.csrfToken()).status)
        .isEqualTo(200);
    agent.csrfToken();
    return agent;
  }

  private String createHousehold(Agent agent, String name) throws Exception {
    return agent
        .post("/api/households", "{\"name\":\"" + name + "\"}", agent.csrfToken)
        .json()
        .path("id")
        .asText();
  }

  private void addMember(String householdId, String userId, String role) {
    assertThat(
            jdbc.update(
                "INSERT INTO household_members (household_id, user_id, role)"
                    + " VALUES (?::uuid, ?::uuid, ?)",
                householdId,
                userId,
                role))
        .isEqualTo(1);
  }

  private String createAccount(
      Agent agent, String householdId, UUID key, String name, String kind, String currency)
      throws Exception {
    Resp response =
        agent.request(
            "POST",
            "/api/households/" + householdId + "/financial-accounts",
            "{\"name\":\""
                + name
                + "\",\"kind\":\""
                + kind
                + "\",\"currency\":\""
                + currency
                + "\"}",
            agent.csrfToken,
            key);
    assertThat(response.status).isEqualTo(201);
    return response.json().path("id").asText();
  }

  /** Registration payload: the enrollment code is recipient-bound and single-use. */
  private static String registrationJson(String email, String enrollmentCode) {
    return "{\"email\":\""
        + email
        + "\",\"password\":\""
        + PASSWORD
        + "\",\"enrollmentCode\":\""
        + enrollmentCode
        + "\"}";
  }

  private static String identityJson(String email) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
  }

  record Resp(int status, String body, java.net.http.HttpHeaders headers) {
    JsonNode json() throws Exception {
      return new ObjectMapper().readTree(body);
    }

    String cacheControl() {
      return headers.firstValue("Cache-Control").orElse("");
    }
  }

  class Agent {
    String sessionCookie;
    String csrfToken;
    String cachedUserId;

    String csrfToken() throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/csrf"))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      addSession(builder);
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      assertThat(response.statusCode()).isEqualTo(200);
      csrfToken = mapper.readTree(response.body()).path("token").asText();
      return csrfToken;
    }

    String userId() throws Exception {
      if (cachedUserId == null) cachedUserId = get("/api/auth/me").json().path("id").asText();
      return cachedUserId;
    }

    Resp get(String path) throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(10))
              .header("Accept", "application/json")
              .GET();
      addSession(builder);
      return send(builder.build());
    }

    Resp post(String path, String json, String csrf) throws Exception {
      return request("POST", path, json, csrf, null);
    }

    Resp createTransaction(String householdId, UUID key, String json) throws Exception {
      return request("POST", transactionPath(householdId), json, csrfToken, key);
    }

    Resp patchTransaction(String householdId, String transactionId, String json) throws Exception {
      return request(
          "PATCH", transactionPath(householdId) + "/" + transactionId, json, csrfToken, null);
    }

    Resp patchAccount(String householdId, String accountId, String json) throws Exception {
      return request(
          "PATCH",
          "/api/households/" + householdId + "/financial-accounts/" + accountId,
          json,
          csrfToken,
          null);
    }

    Resp request(String method, String path, String json, String csrf, UUID idempotencyKey)
        throws Exception {
      return raw(
          method,
          path,
          json,
          csrf,
          idempotencyKey == null ? null : idempotencyKey.toString(),
          json == null ? null : "application/json");
    }

    /** Raw variant for malformed headers and unsupported media types the typed form cannot send. */
    Resp raw(
        String method,
        String path,
        String json,
        String csrf,
        String idempotencyKey,
        String contentType)
        throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(15))
              .header("Accept", "application/json")
              .method(
                  method,
                  json == null
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofString(json));
      if (contentType != null) builder.header("Content-Type", contentType);
      if (csrf != null) builder.header("X-CSRF-TOKEN", csrf);
      if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
      addSession(builder);
      return send(builder.build());
    }

    private Resp send(HttpRequest request) throws Exception {
      HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
      rememberCookies(response);
      return new Resp(response.statusCode(), response.body(), response.headers());
    }

    private void addSession(HttpRequest.Builder builder) {
      if (sessionCookie != null) builder.header("Cookie", "SESSION=" + sessionCookie);
    }

    private void rememberCookies(HttpResponse<String> response) {
      for (String setCookie : response.headers().allValues("Set-Cookie")) {
        String pair = setCookie.split(";", 2)[0];
        int separator = pair.indexOf('=');
        if (separator > 0 && pair.substring(0, separator).equals("SESSION")) {
          String value = pair.substring(separator + 1);
          sessionCookie = value.isEmpty() ? null : value;
        }
      }
    }
  }
}
