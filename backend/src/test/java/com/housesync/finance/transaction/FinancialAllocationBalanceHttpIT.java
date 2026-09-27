package com.housesync.finance.transaction;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Derived member-balance contract on real PostgreSQL (ADR 0007): exact zero-sum
 * per-currency snapshots, the documented partial and full refund reversals, read-time
 * CURRENT/DEPARTED labels that survive departure, stable code and UUID ordering, and the exclusion
 * of private, unallocated, voided, and revoked-allocation entries.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class FinancialAllocationBalanceHttpIT {

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
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void memberBalancesTrackExactRefundLifeCyclesAndDepartedParticipants() throws Exception {
    Agent owner = signedInAgent("balance-owner");
    String householdId = createHousehold(owner, "Balance home");
    Agent second = signedInAgent("balance-second");
    Agent third = signedInAgent("balance-third");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        second.userId());
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        third.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-10.00", "USD", "Dinner", "2026-09-16", "HOUSEHOLD")));
    List<String> roster = sorted(List.of(owner.userId(), second.userId(), third.userId()));
    Resp createdResponse =
        owner.request(
            "POST",
            allocationPath(householdId, expenseId),
            createBody("0", participantArray(roster.toArray(new String[0]))),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(createdResponse.status).isEqualTo(201);

    // Allocated, no refund: obligations 3.34/3.33/3.33 in UUID order, payer credited 10.00.
    JsonNode usd = firstCurrency(owner, householdId, "USD");
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "10.00", List.of("3.34", "3.33", "3.33")));
    assertThat(userIds(usd)).containsExactly(roster.toArray(new String[0]));
    assertThat(balanceMembership(usd, owner.userId())).isEqualTo("CURRENT");
    assertThat(balanceMembership(usd, third.userId())).isEqualTo("CURRENT");

    // Refund 1.00 posted: obligations 3.00 each and payer credit 9.00.
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, expenseId, "1.00", "USD", "First back")));
    usd = balancesNode(owner, householdId).path("currencies").get(0);
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "9.00", List.of("3.00", "3.00", "3.00")));

    // Second refund 2.00 (R = 3.00): cumulative refund shares 1.00 each.
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, expenseId, "2.00", "USD", "Second back")));
    usd = balancesNode(owner, householdId).path("currencies").get(0);
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "7.00", List.of("2.34", "2.33", "2.33")));

    // Correcting a refund's amount moves R and the derived balances without touching shares:
    // R = 5.00 derives refund shares 1.67/1.67/1.66 against originals 3.34/3.33/3.33.
    String secondRefundId = latestRefundId(expenseId);
    Resp refundCorrection =
        owner.patchTransaction(
            householdId,
            secondRefundId,
            "{\"expectedVersion\":0,\"money\":{\"amount\":\"4.00\",\"currency\":\"USD\"}}");
    assertThat(refundCorrection.status).as(refundCorrection.body).isEqualTo(200);
    usd = balancesNode(owner, householdId).path("currencies").get(0);
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "5.00", List.of("1.67", "1.66", "1.67")));
    // Correcting back restores the R = 3.00 state exactly; the refund's own version moved twice.
    Resp refundCorrectionBack =
        owner.patchTransaction(
            householdId,
            secondRefundId,
            "{\"expectedVersion\":1,\"money\":{\"amount\":\"2.00\",\"currency\":\"USD\"}}");
    assertThat(refundCorrectionBack.status).as(refundCorrectionBack.body).isEqualTo(200);
    usd = balancesNode(owner, householdId).path("currencies").get(0);
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "7.00", List.of("2.34", "2.33", "2.33")));

    // Departure keeps the recorded obligation with a DEPARTED label.
    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
        householdId,
        third.userId());
    usd = balancesNode(owner, householdId).path("currencies").get(0);
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "7.00", List.of("2.34", "2.33", "2.33")));
    assertThat(balanceMembership(usd, owner.userId())).isEqualTo("CURRENT");
    assertThat(balanceMembership(usd, second.userId())).isEqualTo("CURRENT");
    assertThat(balanceMembership(usd, third.userId())).isEqualTo("DEPARTED");

    // Voiding a refund restores the obligation that refund had removed; the twice-corrected
    // refund voids under its own current version, and the earlier refund under version 0.
    owner.patchTransaction(
        householdId, secondRefundId, "{\"expectedVersion\":2,\"status\":\"VOIDED\"}");
    usd = balancesNode(owner, householdId).path("currencies").get(0);
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "9.00", List.of("3.00", "3.00", "3.00")));
    owner.patchTransaction(
        householdId, latestRefundId(expenseId), "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    usd = balancesNode(owner, householdId).path("currencies").get(0);
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            expectedBalances(roster, owner.userId(), "10.00", List.of("3.34", "3.33", "3.33")));

    // A full refund makes every balance zero, so the currency disappears entirely.
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, expenseId, "10.00", "USD", "Everything back")));
    JsonNode balances = balancesNode(owner, householdId);
    assertThat(balances.path("currencies").size()).isZero();
  }

  @Test
  void tinyAllocationsPersistOrderedZeroSharesAndKeepBalancesZeroSum() throws Exception {
    Agent owner = signedInAgent("tiny-balance-owner");
    String householdId = createHousehold(owner, "Tiny balance home");
    Agent second = signedInAgent("tiny-balance-second");
    Agent third = signedInAgent("tiny-balance-third");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        second.userId());
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        third.userId());
    String usdAccount = createAccount(owner, householdId, "Owner usd", "CASH", "USD");
    String jpyAccount = createAccount(owner, householdId, "Owner jpy", "CASH", "JPY");
    String kwdAccount = createAccount(owner, householdId, "Owner kwd", "CASH", "KWD");
    List<String> roster = sorted(List.of(second.userId(), third.userId()));

    // Contract-valid tiny magnitudes with the payer omitted: the canonical-first participant
    // receives the single minor unit, the other share is an exact zero, and the derived
    // balances credit the payer while omitting every exact zero row.
    String usdExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    usdAccount, "EXPENSE", "-0.01", "USD", "Cent", "2026-09-16", "HOUSEHOLD")));
    String jpyExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(jpyAccount, "EXPENSE", "-1", "JPY", "Yen", "2026-09-16", "HOUSEHOLD")));
    String kwdExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    kwdAccount, "EXPENSE", "-0.001", "KWD", "Fils", "2026-09-16", "HOUSEHOLD")));
    record TinyCase(String expenseId, String currency, String[] shares) {}
    List<TinyCase> cases =
        List.of(
            new TinyCase(usdExpenseId, "USD", new String[] {"0.01", "0.00"}),
            new TinyCase(jpyExpenseId, "JPY", new String[] {"1", "0"}),
            new TinyCase(kwdExpenseId, "KWD", new String[] {"0.001", "0.000"}));
    for (TinyCase tinyCase : cases) {
      Resp createdResponse =
          owner.request(
              "POST",
              allocationPath(householdId, tinyCase.expenseId()),
              createBody("0", participantArray(second.userId(), third.userId())),
              owner.csrfToken,
              UUID.randomUUID());
      assertThat(createdResponse.status).as(createdResponse.body).isEqualTo(201);
      JsonNode allocation = createdResponse.json();
      assertThat(allocation.path("originalAmount").path("currency").asText())
          .isEqualTo(tinyCase.currency());
      for (int index = 0; index < 2; index++) {
        JsonNode participant = allocation.path("participants").get(index);
        assertThat(participant.path("userId").asText()).isEqualTo(roster.get(index));
        assertThat(participant.path("share").path("amount").asText())
            .isEqualTo(tinyCase.shares()[index]);
        assertThat(participant.path("share").path("currency").asText())
            .isEqualTo(tinyCase.currency());
      }
      assertThat(participantCount(allocation.path("id").asText())).isEqualTo(2);
    }

    JsonNode balances = balancesNode(owner, householdId);
    List<String> currencyCodes = new ArrayList<>();
    balances
        .path("currencies")
        .forEach(bucket -> currencyCodes.add(bucket.path("currency").asText()));
    assertThat(currencyCodes).containsExactly("JPY", "KWD", "USD");
    String remainderRecipient = roster.getFirst();
    List<String> payerOrder = sorted(List.of(owner.userId(), remainderRecipient));
    for (TinyCase tinyCase : cases) {
      JsonNode bucket = currencyBucket(balances, tinyCase.currency());
      assertThat(userIds(bucket)).containsExactly(payerOrder.toArray(new String[0]));
      assertThat(balanceMembership(bucket, roster.get(1))).isNull();
      assertThat(zeroSum(bucket)).isTrue();
      assertThat(bucket.path("balances").get(0).path("membershipStatus").asText())
          .isEqualTo("CURRENT");
    }
    assertThat(balanceAmounts(balances.path("currencies").get(0)))
        .containsExactlyElementsOf(
            amountsInUuidOrder(Map.of(owner.userId(), "1", remainderRecipient, "-1")));
    assertThat(balanceAmounts(balances.path("currencies").get(1)))
        .containsExactlyElementsOf(
            amountsInUuidOrder(Map.of(owner.userId(), "0.001", remainderRecipient, "-0.001")));
    assertThat(balanceAmounts(balances.path("currencies").get(2)))
        .containsExactlyElementsOf(
            amountsInUuidOrder(Map.of(owner.userId(), "0.01", remainderRecipient, "-0.01")));
  }

  @Test
  void sameCurrencyAllocationsMergeZeroSumWithDepartedPayer() throws Exception {
    Agent owner = signedInAgent("merge-owner");
    String householdId = createHousehold(owner, "Merge home");
    Agent second = signedInAgent("merge-second");
    Agent third = signedInAgent("merge-third");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        second.userId());
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        third.userId());
    String account = createAccount(owner, householdId, "Owner card", "CASH", "USD");
    String payerOmittedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-10.00", "USD", "Groceries", "2026-09-16", "HOUSEHOLD")));
    String payerIncludedId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    account, "EXPENSE", "-4.00", "USD", "Tickets", "2026-09-16", "HOUSEHOLD")));
    Resp payerOmitted =
        owner.request(
            "POST",
            allocationPath(householdId, payerOmittedId),
            createBody("0", participantArray(second.userId(), third.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(payerOmitted.status).as(payerOmitted.body).isEqualTo(201);
    Resp payerIncluded =
        owner.request(
            "POST",
            allocationPath(householdId, payerIncludedId),
            createBody("0", participantArray(owner.userId(), second.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(payerIncluded.status).as(payerIncluded.body).isEqualTo(201);

    // Two active USD allocations merge into one zero-sum currency bucket: the payer carries
    // both credits, second nets both obligations, and third keeps the single one.
    JsonNode usd = firstCurrency(owner, householdId, "USD");
    assertThat(userIds(usd))
        .containsExactly(
            sorted(List.of(owner.userId(), second.userId(), third.userId()))
                .toArray(new String[0]));
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            amountsInUuidOrder(
                Map.of(
                    owner.userId(), "12.00", second.userId(), "-7.00", third.userId(), "-5.00")));
    assertThat(zeroSum(usd)).isTrue();

    // The departed payer keeps the merged credit under a DEPARTED label and the sums stay exact.
    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
        householdId,
        owner.userId());
    usd = balancesNode(second, householdId).path("currencies").get(0);
    assertThat(balanceMembership(usd, owner.userId())).isEqualTo("DEPARTED");
    assertThat(balanceMembership(usd, second.userId())).isEqualTo("CURRENT");
    assertThat(balanceMembership(usd, third.userId())).isEqualTo("CURRENT");
    assertThat(balanceAmounts(usd))
        .containsExactlyElementsOf(
            amountsInUuidOrder(
                Map.of(
                    owner.userId(), "12.00", second.userId(), "-7.00", third.userId(), "-5.00")));
    assertThat(zeroSum(usd)).isTrue();
  }

  @Test
  void memberBalancesExcludeNonContributorsAndGroupCurrenciesByCode() throws Exception {
    Agent owner = signedInAgent("group-balance-owner");
    String householdId = createHousehold(owner, "Group balance home");
    Agent second = signedInAgent("group-balance-member");
    Agent third = signedInAgent("group-balance-third");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        second.userId());
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        third.userId());
    String usdAccount = createAccount(owner, householdId, "Owner usd", "CASH", "USD");
    String brlAccount = createAccount(owner, householdId, "Owner brl", "CASH", "BRL");
    String jpyAccount = createAccount(owner, householdId, "Owner jpy", "CASH", "JPY");

    // An allocated BRL expense with the payer omitted from the participants: the payer is
    // owed the full magnitude and the single participant owes it all.
    String brlExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    brlAccount, "EXPENSE", "-20.00", "BRL", "Market", "2026-09-16", "HOUSEHOLD")));
    Resp brlCreated =
        owner.request(
            "POST",
            allocationPath(householdId, brlExpenseId),
            createBody("0", participantArray(second.userId())),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(brlCreated.status).isEqualTo(201);
    assertThat(brlCreated.json().path("participants").get(0).path("share").path("amount").asText())
        .isEqualTo("20.00");

    // A fully refunded allocated expense contributes nothing.
    String refundedExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    usdAccount,
                    "EXPENSE",
                    "-10.00",
                    "USD",
                    "Refunded fully",
                    "2026-09-16",
                    "HOUSEHOLD")));
    owner.request(
        "POST",
        allocationPath(householdId, refundedExpenseId),
        createBody("0", participantArray(owner.userId(), second.userId())),
        owner.csrfToken,
        UUID.randomUUID());
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(usdAccount, refundedExpenseId, "10.00", "USD", "Whole back")));

    // An allocated expense voided afterwards contributes nothing.
    String voidedExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    usdAccount,
                    "EXPENSE",
                    "-8.00",
                    "USD",
                    "Voided split",
                    "2026-09-16",
                    "HOUSEHOLD")));
    owner.request(
        "POST",
        allocationPath(householdId, voidedExpenseId),
        createBody("0", participantArray(owner.userId(), second.userId())),
        owner.csrfToken,
        UUID.randomUUID());
    owner.patchTransaction(
        householdId, voidedExpenseId, "{\"expectedVersion\":1,\"status\":\"VOIDED\"}");

    // A revoked allocation contributes nothing even though the expense stays posted.
    String revokedExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    usdAccount,
                    "EXPENSE",
                    "-5.00",
                    "USD",
                    "Revoked split",
                    "2026-09-16",
                    "HOUSEHOLD")));
    String revokedAllocationPath = allocationPath(householdId, revokedExpenseId);
    owner.request(
        "POST",
        revokedAllocationPath,
        createBody("0", participantArray(owner.userId(), second.userId())),
        owner.csrfToken,
        UUID.randomUUID());
    owner.request(
        "PATCH",
        revokedAllocationPath,
        "{\"expectedVersion\":1,\"status\":\"REVOKED\"}",
        owner.csrfToken,
        null);

    // An allocated JPY expense adds a second bucket ordered after BRL by code.
    String jpyExpenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(
                    jpyAccount, "EXPENSE", "-1000", "JPY", "Trip", "2026-09-16", "HOUSEHOLD")));
    List<String> jpyRoster = sorted(List.of(owner.userId(), second.userId(), third.userId()));
    Resp jpyCreated =
        owner.request(
            "POST",
            allocationPath(householdId, jpyExpenseId),
            createBody("0", participantArray(jpyRoster.toArray(new String[0]))),
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(jpyCreated.status).isEqualTo(201);

    // Unallocated and private entries never introduce a currency bucket.
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(
                usdAccount, "EXPENSE", "-7.00", "USD", "Unallocated", "2026-09-16", "HOUSEHOLD")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(usdAccount, "EXPENSE", "-3.00", "USD", "Private", "2026-09-16", null)));

    JsonNode balances = balancesNode(owner, householdId);
    List<String> currencyCodes = new ArrayList<>();
    balances
        .path("currencies")
        .forEach(bucket -> currencyCodes.add(bucket.path("currency").asText()));
    assertThat(currencyCodes).containsExactly("BRL", "JPY");

    JsonNode brl = balances.path("currencies").get(0);
    List<String> brlUsers = sorted(List.of(owner.userId(), second.userId()));
    assertThat(userIds(brl)).containsExactly(brlUsers.toArray(new String[0]));
    // Payer omitted from the participants: the payer is owed the full magnitude and the
    // single participant owes exactly the whole share.
    assertThat(balanceAmounts(brl))
        .containsExactlyElementsOf(
            amountsInUuidOrder(Map.of(owner.userId(), "20.00", second.userId(), "-20.00")));
    assertThat(zeroSum(brl)).isTrue();

    JsonNode jpy = balances.path("currencies").get(1);
    assertThat(balanceAmounts(jpy))
        .containsExactlyElementsOf(
            expectedBalances(jpyRoster, owner.userId(), "1000", List.of("334", "333", "333")));
    assertThat(zeroSum(jpy)).isTrue();
    assertThat(balances.toString()).doesNotContain("@example.test");
  }

  @Test
  void memberBalancesRejectQueriesAndAnswerEveryCurrentMember() throws Exception {
    Agent owner = signedInAgent("access-balance-owner");
    String householdId = createHousehold(owner, "Access balance home");
    Agent member = signedInAgent("access-balance-member");
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        member.userId());

    Resp memberRead = member.get("/api/households/" + householdId + "/member-balances");
    assertThat(memberRead.status).isEqualTo(200);
    assertThat(memberRead.json().path("currencies").size()).isZero();
    assertThat(memberRead.cacheControl()).contains("no-store");

    Resp queryRead = member.get("/api/households/" + householdId + "/member-balances?currency=USD");
    assertThat(queryRead.status).isEqualTo(400);

    Agent outsider = signedInAgent("access-balance-outsider");
    Resp outsiderRead = outsider.get("/api/households/" + householdId + "/member-balances");
    assertThat(outsiderRead.status).isEqualTo(404);
    assertThat(outsiderRead.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");

    jdbc.update(
        "DELETE FROM household_members WHERE household_id = ?::uuid AND user_id = ?::uuid",
        householdId,
        member.userId());
    Resp removedRead = member.get("/api/households/" + householdId + "/member-balances");
    assertThat(removedRead.status).isEqualTo(404);
    assertThat(removedRead.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
  }

  private String latestRefundId(String expenseId) {
    return jdbc.queryForObject(
        "SELECT id::text FROM financial_transactions WHERE refund_of_transaction_id = ?::uuid"
            + " AND status = 'POSTED' ORDER BY created_at DESC, id DESC LIMIT 1",
        String.class,
        UUID.fromString(expenseId));
  }

  private JsonNode balancesNode(Agent agent, String householdId) throws Exception {
    Resp response = agent.get("/api/households/" + householdId + "/member-balances");
    assertThat(response.status).as(response.body).isEqualTo(200);
    assertThat(response.cacheControl()).contains("no-store");
    return response.json();
  }

  private JsonNode currencyBucket(JsonNode balances, String code) {
    for (JsonNode bucket : balances.path("currencies")) {
      if (code.equals(bucket.path("currency").asText())) {
        return bucket;
      }
    }
    throw new AssertionError("No " + code + " currency bucket in " + balances);
  }

  private int participantCount(String allocationId) {
    return jdbc.queryForObject(
        "SELECT COUNT(*) FROM financial_transaction_allocation_participants"
            + " WHERE allocation_id = ?::uuid",
        Integer.class,
        UUID.fromString(allocationId));
  }

  private List<String> balanceAmounts(JsonNode currencyBucket) {
    List<String> amounts = new ArrayList<>();
    currencyBucket
        .path("balances")
        .forEach(balance -> amounts.add(balance.path("amount").asText()));
    return amounts;
  }

  private List<String> userIds(JsonNode currencyNode) {
    List<String> ids = new ArrayList<>();
    currencyNode.path("balances").forEach(balance -> ids.add(balance.path("userId").asText()));
    return ids;
  }

  private String balanceMembership(JsonNode currencyNode, String userId) {
    for (JsonNode balance : currencyNode.path("balances")) {
      if (balance.path("userId").asText().equals(userId)) {
        return balance.path("membershipStatus").asText();
      }
    }
    return null;
  }

  private boolean zeroSum(JsonNode currencyNode) {
    BigDecimal sum = BigDecimal.ZERO;
    for (JsonNode balance : currencyNode.path("balances")) {
      sum = sum.add(new BigDecimal(balance.path("amount").asText()));
    }
    return sum.signum() == 0;
  }

  /**
   * Expected balance strings in ascending user-UUID order: each listed obligation applies to the
   * roster entry at the same position (a "0.00" obligation encodes a payer who is not a
   * participant), and the payer nets their credit against their own obligation. Exact zeros are
   * omitted by the API, so they are filtered here too.
   */
  private static List<String> expectedBalances(
      List<String> rosterOrder,
      String payerId,
      String payerCredit,
      List<String> obligationsInRosterOrder) {
    List<String> expected = new ArrayList<>();
    for (int index = 0; index < rosterOrder.size(); index++) {
      BigDecimal obligation = new BigDecimal(obligationsInRosterOrder.get(index));
      BigDecimal amount =
          rosterOrder.get(index).equals(payerId)
              ? new BigDecimal(payerCredit).subtract(obligation)
              : obligation.negate();
      if (amount.signum() != 0) {
        expected.add(amount.toPlainString());
      }
    }
    return expected;
  }

  /** Balance amounts keyed by user, emitted in the API's ascending canonical UUID order. */
  private static List<String> amountsInUuidOrder(java.util.Map<String, String> amountsByUser) {
    return amountsByUser.entrySet().stream()
        .sorted(java.util.Map.Entry.comparingByKey())
        .map(java.util.Map.Entry::getValue)
        .toList();
  }

  private JsonNode firstCurrency(Agent agent, String householdId, String code) throws Exception {
    JsonNode balances = balancesNode(agent, householdId);
    assertThat(balances.path("currencies").size()).isEqualTo(1);
    JsonNode bucket = balances.path("currencies").get(0);
    assertThat(bucket.path("currency").asText()).isEqualTo(code);
    return bucket;
  }

  private String allocationPath(String householdId, String transactionId) {
    return "/api/households/" + householdId + "/transactions/" + transactionId + "/allocation";
  }

  private static String datedEntry(
      String accountId,
      String kind,
      String amount,
      String currency,
      String description,
      String date,
      String visibility) {
    StringBuilder builder =
        new StringBuilder(
            "{\"accountId\":\""
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
                + "\"");
    if (visibility != null) {
      builder.append(",\"visibility\":\"").append(visibility).append("\"");
    }
    return builder.append("}").toString();
  }

  private static String refundEntry(
      String accountId, String sourceId, String amount, String currency, String description) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},"
        + "\"occurredOn\":\"2026-09-16\",\"description\":\""
        + description
        + "\",\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  private static List<String> sorted(List<String> ids) {
    return ids.stream().sorted(Comparator.comparing(id -> id)).toList();
  }

  private static String participantArray(String... ids) {
    StringBuilder builder = new StringBuilder();
    for (int index = 0; index < ids.length; index++) {
      if (index > 0) builder.append(",");
      builder.append("\"").append(ids[index]).append("\"");
    }
    return builder.toString();
  }

  private static String createBody(String expectedVersion, String participantArrayContents) {
    return "{\"expectedVersion\":"
        + expectedVersion
        + ",\"participantUserIds\":["
        + participantArrayContents
        + "]}";
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

  private String createAccount(
      Agent agent, String householdId, String name, String kind, String currency) throws Exception {
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
            UUID.randomUUID());
    assertThat(response.status).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String created(Resp response) throws Exception {
    assertThat(response.status).as(response.body).isEqualTo(201);
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

    Resp request(String method, String path, String json, String csrf, UUID idempotencyKey)
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
      if (json != null) builder.header("Content-Type", "application/json");
      if (csrf != null) builder.header("X-CSRF-TOKEN", csrf);
      if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey.toString());
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

  private static String transactionPath(String householdId) {
    return "/api/households/" + householdId + "/transactions";
  }
}
