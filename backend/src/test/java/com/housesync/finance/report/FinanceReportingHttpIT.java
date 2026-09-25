package com.housesync.finance.report;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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
 * Reporting HTTP contract against real PostgreSQL: household reporting-zone settings with owner-only
 * optimistic updates and exact per-currency spending summaries over half-open date intervals,
 * including authorization, strict-transport validation, version lifecycle, privacy retention, and
 * multi-currency aggregation.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"app.auth.ip-max-attempts=1000"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@Testcontainers
class FinanceReportingHttpIT {

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

  @Autowired private JdbcTemplate jdbc;
  @LocalServerPort private int port;

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  private final ObjectMapper mapper = new ObjectMapper();

  @Test
  void financeSettingsDefaultReadAndOwnerPatchLifecycle() throws Exception {
    Agent owner = signedInAgent("settings-owner");
    String householdId = createHousehold(owner, "Reporting home");
    Agent member = signedInAgent("settings-member");
    addMember(householdId, member.userId());
    Agent outsider = signedInAgent("settings-outsider");

    // Both current members read the documented initial zone at version 0.
    Resp ownerGet = owner.get(settingsPath(householdId));
    assertThat(ownerGet.status).isEqualTo(200);
    assertThat(ownerGet.json().path("reportingTimeZone").asText()).isEqualTo("Etc/UTC");
    assertThat(ownerGet.json().path("version").asInt()).isZero();
    assertThat(ownerGet.cacheControl()).contains("no-store");
    Resp memberGet = member.get(settingsPath(householdId));
    assertThat(memberGet.status).isEqualTo(200);
    assertThat(memberGet.json().path("reportingTimeZone").asText()).isEqualTo("Etc/UTC");

    // A non-member and a missing household share the generic household 404.
    Resp outsiderGet = outsider.get(settingsPath(householdId));
    assertThat(outsiderGet.status).isEqualTo(404);
    assertThat(outsiderGet.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp missingGet = owner.get(settingsPath(UUID.randomUUID().toString()));
    assertThat(missingGet.status).isEqualTo(404);
    assertThat(missingGet.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp outsiderPatch =
        outsider.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":0}",
            outsider.csrfToken,
            null);
    assertThat(outsiderPatch.status).isEqualTo(404);

    // A current non-owner reads but cannot mutate.
    Resp memberPatch =
        member.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":0}",
            member.csrfToken,
            null);
    assertThat(memberPatch.status).isEqualTo(403);
    assertThat(memberPatch.json().path("code").asText()).isEqualTo("FORBIDDEN");

    // The owner moves the zone with the current version; the version bumps once.
    Resp patched =
        owner.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":0}",
            owner.csrfToken,
            null);
    assertThat(patched.status).as(patched.body).isEqualTo(200);
    assertThat(patched.json().path("reportingTimeZone").asText()).isEqualTo("America/New_York");
    assertThat(patched.json().path("version").asInt()).isEqualTo(1);
    assertThat(patched.cacheControl()).contains("no-store");

    // An authorized same-zone, current-version patch is a no-op without a version bump.
    Resp noOp =
        owner.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":1}",
            owner.csrfToken,
            null);
    assertThat(noOp.status).as(noOp.body).isEqualTo(200);
    assertThat(noOp.json().path("version").asInt()).isEqualTo(1);

    // A stale owner write conflicts instead of overwriting the moved zone.
    Resp stale =
        owner.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"Europe/Berlin\",\"expectedVersion\":0}",
            owner.csrfToken,
            null);
    assertThat(stale.status).isEqualTo(409);
    assertThat(stale.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");
    assertThat(owner.get(settingsPath(householdId)).json().path("reportingTimeZone").asText())
        .isEqualTo("America/New_York");

    // Unsafe writes without a CSRF token are rejected before any settings logic runs.
    Resp missingCsrf =
        owner.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"Europe/Berlin\",\"expectedVersion\":1}",
            null,
            null);
    assertThat(missingCsrf.status).isEqualTo(403);
    assertThat(missingCsrf.json().path("code").asText()).isEqualTo("CSRF_INVALID");

    // Query parameters are never accepted on these routes.
    assertThat(owner.get(settingsPath(householdId) + "?zone=Etc/UTC").status).isEqualTo(400);
    assertThat(
            owner.request(
                    "PATCH",
                    settingsPath(householdId) + "?zone=Etc/UTC",
                    "{\"reportingTimeZone\":\"Europe/Berlin\",\"expectedVersion\":1}",
                    owner.csrfToken,
                    null)
                .status)
        .isEqualTo(400);
  }

  @Test
  void financeSettingsValidationRejectsBadTransportAndZones() throws Exception {
    Agent owner = signedInAgent("settings-validation");
    String householdId = createHousehold(owner, "Zone validation home");

    // Every short alias, bare offset, unknown region, and malformed value fails on the zone
    // field without echoing the submitted value.
    for (String zone :
        new String[] {
          "EST", "UTC", "Z", "+02:00", "GMT+2", "America/Nope", "etc/utc", "", " ",
        }) {
      Resp rejected =
          owner.request(
              "PATCH",
              settingsPath(householdId),
              "{\"reportingTimeZone\":\"" + zone + "\",\"expectedVersion\":0}",
              owner.csrfToken,
              null);
      assertThat(rejected.status).as(zone).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
      assertThat(rejected.json().path("fieldErrors").has("reportingTimeZone")).isTrue();
    }
    for (String body :
        new String[] {
          "{\"reportingTimeZone\":null,\"expectedVersion\":0}",
          "{\"expectedVersion\":0}",
          "{\"reportingTimeZone\":\"America/New_York\"}",
          "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":null}",
          "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":-1}",
          "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":0,\"zone\":\"x\"}",
          "{\"reportingTimeZone\":123,\"expectedVersion\":0}",
          "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":\"0\"}",
          "{\"reportingTimeZone\":\"America/New_York\",\"reportingTimeZone\":\"Europe/Berlin\","
              + "\"expectedVersion\":0}",
        }) {
      Resp rejected =
          owner.request("PATCH", settingsPath(householdId), body, owner.csrfToken, null);
      assertThat(rejected.status).as(body).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    }
    Resp emptyBody = owner.request("PATCH", settingsPath(householdId), null, owner.csrfToken, null);
    assertThat(emptyBody.status).isEqualTo(400);

    // Rejected writes change nothing.
    assertThat(owner.get(settingsPath(householdId)).json().path("reportingTimeZone").asText())
        .isEqualTo("Etc/UTC");
    assertThat(owner.get(settingsPath(householdId)).json().path("version").asInt()).isZero();
  }

  @Test
  void financeSettingsVersionExhaustion() throws Exception {
    Agent owner = signedInAgent("settings-exhaustion");
    String householdId = createHousehold(owner, "Exhausted zone home");
    jdbc.update("UPDATE households SET version = 2147483647 WHERE id = ?::uuid", householdId);

    // A current-version no-op still succeeds at the version limit.
    Resp noOp =
        owner.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"Etc/UTC\",\"expectedVersion\":2147483647}",
            owner.csrfToken,
            null);
    assertThat(noOp.status).as(noOp.body).isEqualTo(200);
    assertThat(noOp.json().path("version").asInt()).isEqualTo(2147483647);

    // A real change at the limit fails safely without wrapping the version.
    Resp exhausted =
        owner.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":2147483647}",
            owner.csrfToken,
            null);
    assertThat(exhausted.status).isEqualTo(409);
    assertThat(exhausted.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_EXHAUSTED");
    assertThat(owner.get(settingsPath(householdId)).json().path("reportingTimeZone").asText())
        .isEqualTo("Etc/UTC");
  }

  @Test
  void spendingSummaryExactAggregationContract() throws Exception {
    Agent owner = signedInAgent("summary-owner");
    String householdId = createHousehold(owner, "Summary home");
    Agent second = signedInAgent("summary-second");
    addMember(householdId, second.userId());

    String brlAccount = createAccount(owner, householdId, "Owner BRL", "CHECKING", "BRL");
    String usdAccount = createAccount(owner, householdId, "Owner USD", "CASH", "USD");
    String jpyAccount = createAccount(owner, householdId, "Owner JPY", "CASH", "JPY");
    String eurAccount = createAccount(owner, householdId, "Owner EUR", "CASH", "EUR");
    String gbpAccount = createAccount(owner, householdId, "Owner GBP", "CASH", "GBP");

    // Contract example: expense -100, income +200, refund +20, transfer -50 in BRL.
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(brlAccount, "EXPENSE", "-100.00", "BRL", "Market", "2026-09-16")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(brlAccount, "INCOME", "200.00", "BRL", "Pay", "2026-09-16")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(brlAccount, expenseId, "20.00", "BRL", "Back", "2026-09-16")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(brlAccount, "TRANSFER", "-50.00", "BRL", "Move", "2026-09-16")));

    // Transfer-only currency introduces a zero bucket; JPY proves scale-0 exactness.
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(usdAccount, "TRANSFER", "-50.00", "USD", "Hop", "2026-09-16")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(jpyAccount, "EXPENSE", "-1000", "JPY", "Cash", "2026-09-16")));

    // Private and voided household entries contribute nothing and introduce no bucket.
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            privateEntry(eurAccount, "EXPENSE", "-10.00", "EUR", "Secret", "2026-09-16")));
    String voidId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(gbpAccount, "EXPENSE", "-10.00", "GBP", "Undo", "2026-09-16")));
    Resp voided =
        owner.patchTransaction(
            householdId, voidId, "{\"expectedVersion\":0,\"status\":\"VOIDED\"}");
    assertThat(voided.status).as(voided.body).isEqualTo(200);

    // Half-open boundaries: the `from` date is included, the `to` date is excluded.
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(brlAccount, "EXPENSE", "-1.00", "BRL", "First day", "2026-09-01")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(brlAccount, "EXPENSE", "-1.00", "BRL", "Next month", "2026-10-01")));

    Resp summary = owner.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(summary.status).as(summary.body).isEqualTo(200);
    assertThat(summary.cacheControl()).contains("no-store");
    JsonNode root = summary.json();
    assertThat(root.path("from").asText()).isEqualTo("2026-09-01");
    assertThat(root.path("to").asText()).isEqualTo("2026-10-01");
    assertThat(root.path("reportingTimeZone").asText()).isEqualTo("Etc/UTC");

    // Buckets are ordered by currency code; private EUR and voided GBP never appear.
    JsonNode currencies = root.path("currencies");
    assertThat(currencies.size()).isEqualTo(3);
    assertThat(currencies.get(0).path("currency").asText()).isEqualTo("BRL");
    assertThat(currencies.get(1).path("currency").asText()).isEqualTo("JPY");
    assertThat(currencies.get(2).path("currency").asText()).isEqualTo("USD");

    JsonNode brl = currencies.get(0);
    assertThat(brl.path("expenseTotal").asText()).isEqualTo("101.00");
    assertThat(brl.path("refundTotal").asText()).isEqualTo("20.00");
    assertThat(brl.path("netSpending").asText()).isEqualTo("81.00");
    assertThat(brl.path("incomeTotal").asText()).isEqualTo("200.00");
    JsonNode jpy = currencies.get(1);
    assertThat(jpy.path("expenseTotal").asText()).isEqualTo("1000");
    assertThat(jpy.path("refundTotal").asText()).isEqualTo("0");
    assertThat(jpy.path("netSpending").asText()).isEqualTo("1000");
    assertThat(jpy.path("incomeTotal").asText()).isEqualTo("0");
    JsonNode usd = currencies.get(2);
    assertThat(usd.path("expenseTotal").asText()).isEqualTo("0.00");
    assertThat(usd.path("refundTotal").asText()).isEqualTo("0.00");
    assertThat(usd.path("netSpending").asText()).isEqualTo("0.00");
    assertThat(usd.path("incomeTotal").asText()).isEqualTo("0.00");

    // The next month is an isolated half-open window: only the entry dated exactly on its
    // `from` bound contributes, and the September refund never rewrites September spending.
    Resp october = owner.get(summaryPath(householdId, "2026-10-01", "2026-11-01"));
    assertThat(october.status).as(october.body).isEqualTo(200);
    JsonNode octoberCurrencies = october.json().path("currencies");
    assertThat(octoberCurrencies.size()).isEqualTo(1);
    assertThat(octoberCurrencies.get(0).path("currency").asText()).isEqualTo("BRL");
    assertThat(octoberCurrencies.get(0).path("expenseTotal").asText()).isEqualTo("1.00");
    assertThat(octoberCurrencies.get(0).path("netSpending").asText()).isEqualTo("1.00");

    // A household member sees the same household totals; the zone follows later settings moves.
    Resp memberSummary = second.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(memberSummary.status).as(memberSummary.body).isEqualTo(200);
    assertThat(memberSummary.json().path("currencies").size()).isEqualTo(3);
    Resp zoneMoved =
        owner.request(
            "PATCH",
            settingsPath(householdId),
            "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":0}",
            owner.csrfToken,
            null);
    assertThat(zoneMoved.status).as(zoneMoved.body).isEqualTo(200);
    assertThat(
            owner
                .get(summaryPath(householdId, "2026-09-01", "2026-10-01"))
                .json()
                .path("reportingTimeZone")
                .asText())
        .isEqualTo("America/New_York");
  }

  @Test
  void spendingSummaryRetainsDepartedOwnerAndArchivedAccountHistory() throws Exception {
    Agent owner = signedInAgent("retention-owner");
    String householdId = createHousehold(owner, "Retention home");
    Agent second = signedInAgent("retention-second");
    addMember(householdId, second.userId());

    String ownerAccount = createAccount(owner, householdId, "Owner card", "CASH", "BRL");
    String secondAccount = createAccount(second, householdId, "Second card", "CASH", "BRL");
    created(
        second.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(secondAccount, "EXPENSE", "-30.00", "BRL", "Shared", "2026-09-16")));
    String archivedExpense =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(ownerAccount, "EXPENSE", "-12.00", "BRL", "Kept", "2026-09-16")));
    assertThat(archivedExpense).isNotBlank();
    Resp archived =
        owner.patchAccount(
            householdId, ownerAccount, "{\"expectedVersion\":0,\"status\":\"ARCHIVED\"}");
    assertThat(archived.status).as(archived.body).isEqualTo(200);

    // Departure revokes access but never deletes retained household history.
    Resp removed = owner.removeMember(householdId, second.userId());
    assertThat(removed.status).as(removed.body).isEqualTo(204);

    Resp summary = owner.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(summary.status).as(summary.body).isEqualTo(200);
    JsonNode currencies = summary.json().path("currencies");
    assertThat(currencies.size()).isEqualTo(1);
    assertThat(currencies.get(0).path("expenseTotal").asText()).isEqualTo("42.00");
    assertThat(currencies.get(0).path("netSpending").asText()).isEqualTo("42.00");

    // The departed member loses even their own household summary access.
    Resp departedRead = second.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(departedRead.status).isEqualTo(404);
    assertThat(departedRead.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
  }

  @Test
  void spendingSummaryValidationAndAuthorization() throws Exception {
    Agent owner = signedInAgent("summary-guards");
    String householdId = createHousehold(owner, "Guarded home");
    Agent outsider = signedInAgent("summary-outsider");

    // Both bounds are required and strictly ordered.
    assertThat(owner.get(summaryPath(householdId, null, "2026-10-01")).status).isEqualTo(400);
    assertThat(owner.get(summaryPath(householdId, "2026-09-01", null)).status).isEqualTo(400);
    assertThat(owner.get(summaryPath(householdId, "2026-10-01", "2026-09-01")).status)
        .isEqualTo(400);
    assertThat(owner.get(summaryPath(householdId, "2026-09-01", "2026-09-01")).status)
        .isEqualTo(400);
    Resp badDate = owner.get(summaryPath(householdId, "not-a-date", "2026-10-01"));
    assertThat(badDate.status).isEqualTo(400);
    assertThat(badDate.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(badDate.json().path("fieldErrors").has("from")).isTrue();
    Resp outOfRange = owner.get(summaryPath(householdId, "1899-12-31", "2026-10-01"));
    assertThat(outOfRange.status).isEqualTo(400);

    // Unknown and duplicated query parameters are rejected rather than ignored.
    assertThat(
            owner.get(summaryPath(householdId, "2026-09-01", "2026-10-01") + "&currency=BRL")
                .status)
        .isEqualTo(400);
    assertThat(
            owner.get(
                    "/api/households/"
                        + householdId
                        + "/spending-summary?from=2026-09-01&from=2026-09-02&to=2026-10-01")
                .status)
        .isEqualTo(400);

    // A household with no entries yields no buckets, never an invented default-currency zero.
    Resp empty = owner.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(empty.status).as(empty.body).isEqualTo(200);
    assertThat(empty.json().path("currencies").size()).isZero();
    assertThat(empty.json().path("reportingTimeZone").asText()).isEqualTo("Etc/UTC");

    // Outsiders share the generic household 404; anonymous callers are unauthenticated.
    Resp outsiderRead = outsider.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(outsiderRead.status).isEqualTo(404);
    assertThat(outsiderRead.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp anonymous = anonymousGet(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(anonymous.status).isEqualTo(401);
    assertThat(anonymous.json().path("code").asText()).isEqualTo("UNAUTHENTICATED");
  }

  @Test
  void spendingSummaryNegativeNetRefundOnlyPeriod() throws Exception {
    Agent owner = signedInAgent("negative-net");
    String householdId = createHousehold(owner, "Negative net home");
    String account = createAccount(owner, householdId, "Owner card", "CASH", "BRL");

    // The expense posts in September; its refund posts in October, so October holds a refund
    // without any expense and September keeps its reduced net.
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(account, "EXPENSE", "-100.00", "BRL", "Market", "2026-09-16")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, expenseId, "20.00", "BRL", "Back", "2026-10-05")));

    Resp october = owner.get(summaryPath(householdId, "2026-10-01", "2026-11-01"));
    assertThat(october.status).as(october.body).isEqualTo(200);
    JsonNode bucket = october.json().path("currencies").get(0);
    assertThat(bucket.path("currency").asText()).isEqualTo("BRL");
    assertThat(bucket.path("expenseTotal").asText()).isEqualTo("0.00");
    assertThat(bucket.path("refundTotal").asText()).isEqualTo("20.00");
    // A refund-heavy period carries an exact negative net, never a missing bucket.
    assertThat(bucket.path("netSpending").asText()).isEqualTo("-20.00");
    assertThat(bucket.path("incomeTotal").asText()).isEqualTo("0.00");

    // A fully refunded period nets to an exact zero, never negative zero.
    String fullExpense =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(account, "EXPENSE", "-20.00", "BRL", "Full", "2026-10-06")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, fullExpense, "20.00", "BRL", "All back", "2026-10-07")));
    Resp balanced = owner.get(summaryPath(householdId, "2026-10-01", "2026-11-01"));
    assertThat(balanced.status).as(balanced.body).isEqualTo(200);
    JsonNode balancedBucket = balanced.json().path("currencies").get(0);
    assertThat(balancedBucket.path("expenseTotal").asText()).isEqualTo("20.00");
    assertThat(balancedBucket.path("refundTotal").asText()).isEqualTo("40.00");
    assertThat(balancedBucket.path("netSpending").asText()).isEqualTo("-20.00");

    Resp zeroed = owner.get(summaryPath(householdId, "2026-10-06", "2026-10-08"));
    assertThat(zeroed.status).as(zeroed.body).isEqualTo(200);
    JsonNode zeroedBucket = zeroed.json().path("currencies").get(0);
    assertThat(zeroedBucket.path("expenseTotal").asText()).isEqualTo("20.00");
    assertThat(zeroedBucket.path("refundTotal").asText()).isEqualTo("20.00");
    assertThat(zeroedBucket.path("netSpending").asText()).isEqualTo("0.00");
  }

  @Test
  void spendingSummaryKwdScaleLargeTotalsAndFinalBoundary() throws Exception {
    Agent owner = signedInAgent("kwd-large");
    String householdId = createHousehold(owner, "KWD home");
    String account = createAccount(owner, householdId, "Owner KWD", "CASH", "KWD");

    // Per-record maxima aggregate beyond the per-record bound; the final supported transaction
    // date stays queryable through the 9999-12-31 exclusive reporting boundary.
    String expenseId =
        created(
            owner.createTransaction(
                householdId,
                UUID.randomUUID(),
                datedEntry(account, "EXPENSE", "-999999999999.999", "KWD", "Huge", "9999-12-30")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(account, "EXPENSE", "-100.001", "KWD", "More", "9999-12-30")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            refundEntry(account, expenseId, "0.001", "KWD", "Tiny back", "9999-12-30")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(account, "INCOME", "5.000", "KWD", "Pay", "9999-12-30")));
    created(
        owner.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(account, "TRANSFER", "2.5", "KWD", "Hop", "9999-12-30")));

    Resp summary = owner.get(summaryPath(householdId, "9999-12-30", "9999-12-31"));
    assertThat(summary.status).as(summary.body).isEqualTo(200);
    JsonNode currencies = summary.json().path("currencies");
    assertThat(currencies.size()).isEqualTo(1);
    JsonNode kwd = currencies.get(0);
    assertThat(kwd.path("currency").asText()).isEqualTo("KWD");
    assertThat(kwd.path("expenseTotal").asText()).isEqualTo("1000000000100.000");
    assertThat(kwd.path("refundTotal").asText()).isEqualTo("0.001");
    assertThat(kwd.path("netSpending").asText()).isEqualTo("1000000000099.999");
    // Transfers never leak into spending or income, at any scale.
    assertThat(kwd.path("incomeTotal").asText()).isEqualTo("5.000");
  }

  @Test
  void financeSettingsConcurrentPatchSameVersion() throws Exception {
    Agent owner = signedInAgent("settings-race");
    String householdId = createHousehold(owner, "Racing zone home");

    ExecutorService pool = Executors.newFixedThreadPool(2);
    CountDownLatch start = new CountDownLatch(1);
    try {
      Future<Resp> first =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "PATCH",
                    settingsPath(householdId),
                    "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":0}",
                    owner.csrfToken,
                    null);
              });
      Future<Resp> second =
          pool.submit(
              () -> {
                start.await(10, TimeUnit.SECONDS);
                return owner.request(
                    "PATCH",
                    settingsPath(householdId),
                    "{\"reportingTimeZone\":\"Europe/Berlin\",\"expectedVersion\":0}",
                    owner.csrfToken,
                    null);
              });
      start.countDown();
      Resp firstResponse = first.get(30, TimeUnit.SECONDS);
      Resp secondResponse = second.get(30, TimeUnit.SECONDS);

      // Exactly one state-changing write wins; the loser conflicts on the moved version, so no
      // update is ever silently overwritten and the version moves exactly once.
      List<Integer> statuses =
          new ArrayList<>(List.of(firstResponse.status, secondResponse.status));
      Collections.sort(statuses);
      assertThat(statuses).containsExactly(200, 409);
      Resp conflict = firstResponse.status == 409 ? firstResponse : secondResponse;
      assertThat(conflict.json().path("code").asText()).isEqualTo("RESOURCE_VERSION_CONFLICT");
      Resp winner = firstResponse.status == 200 ? firstResponse : secondResponse;
      assertThat(winner.json().path("version").asInt()).isEqualTo(1);

      JsonNode stored = owner.get(settingsPath(householdId)).json();
      assertThat(stored.path("version").asInt()).isEqualTo(1);
      assertThat(stored.path("reportingTimeZone").asText())
          .isEqualTo(winner.json().path("reportingTimeZone").asText());
    } finally {
      pool.shutdownNow();
    }
  }

  @Test
  void spendingSummaryRetainsDepartedOwnerHistory() throws Exception {
    Agent first = signedInAgent("departed-owner");
    String householdId = createHousehold(first, "Owner departure home");
    Agent second = signedInAgent("successor-owner");
    addMember(householdId, second.userId());

    String firstAccount = createAccount(first, householdId, "First card", "CASH", "BRL");
    created(
        first.createTransaction(
            householdId,
            UUID.randomUUID(),
            datedEntry(firstAccount, "EXPENSE", "-25.00", "BRL", "Shared", "2026-09-16")));

    // The second member becomes an owner first so the household keeps its required owner, then
    // the founding owner leaves; their household-visible history stays readable.
    Resp promoted =
        first.request(
            "PATCH",
            "/api/households/" + householdId + "/members/" + second.userId(),
            "{\"role\":\"OWNER\"}",
            first.csrfToken,
            null);
    assertThat(promoted.status).as(promoted.body).isEqualTo(200);
    Resp left =
        first.request(
            "POST", "/api/households/" + householdId + "/leave", null, first.csrfToken, null);
    assertThat(left.status).as(left.body).isEqualTo(204);

    Resp summary = second.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(summary.status).as(summary.body).isEqualTo(200);
    JsonNode currencies = summary.json().path("currencies");
    assertThat(currencies.size()).isEqualTo(1);
    assertThat(currencies.get(0).path("expenseTotal").asText()).isEqualTo("25.00");
    assertThat(currencies.get(0).path("netSpending").asText()).isEqualTo("25.00");

    // The departed founder loses settings and summary access through this household.
    Resp departedSettings = first.get(settingsPath(householdId));
    assertThat(departedSettings.status).isEqualTo(404);
    assertThat(departedSettings.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
    Resp departedSummary = first.get(summaryPath(householdId, "2026-09-01", "2026-10-01"));
    assertThat(departedSummary.status).isEqualTo(404);
  }

  @Test
  void settingsGetSerializesWithConcurrentRemoval() throws Exception {
    Agent owner = signedInAgent("removal-owner");
    String householdId = createHousehold(owner, "Removal race home");
    Agent member = signedInAgent("removal-member");
    addMember(householdId, member.userId());

    // While the owner removes the member, every settings read observes either the authorized
    // pre-removal snapshot or the post-removal denial — never a partial or error state.
    ExecutorService pool = Executors.newFixedThreadPool(1);
    try {
      Future<List<Resp>> reads =
          pool.submit(
              () -> {
                List<Resp> responses = new ArrayList<>();
                for (int index = 0; index < 30; index++) {
                  responses.add(member.get(settingsPath(householdId)));
                }
                return responses;
              });
      // Let several reads land before and during the removal commit.
      Thread.sleep(50);
      Resp removed = owner.removeMember(householdId, member.userId());
      assertThat(removed.status).as(removed.body).isEqualTo(204);

      for (Resp response : reads.get(30, TimeUnit.SECONDS)) {
        assertThat(response.status).isIn(200, 404);
        if (response.status == 200) {
          assertThat(response.json().path("reportingTimeZone").asText()).isEqualTo("Etc/UTC");
          assertThat(response.json().has("version")).isTrue();
        } else {
          assertThat(response.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
        }
        assertThat(response.cacheControl()).contains("no-store");
      }
    } finally {
      pool.shutdownNow();
    }

    // Once removal has committed, the former member is denied.
    Resp denied = member.get(settingsPath(householdId));
    assertThat(denied.status).isEqualTo(404);
    assertThat(denied.json().path("code").asText()).isEqualTo("HOUSEHOLD_NOT_FOUND");
  }

  @Test
  void settingsPatchTransportErrors() throws Exception {
    Agent owner = signedInAgent("patch-transport");
    String householdId = createHousehold(owner, "Patch transport home");

    // An empty PATCH carries both field errors with a 400 (observed, not assumed).
    Resp empty = owner.request("PATCH", settingsPath(householdId), null, owner.csrfToken, null);
    assertThat(empty.status).isEqualTo(400);
    assertThat(empty.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    assertThat(empty.json().path("fieldErrors").has("reportingTimeZone")).isTrue();
    assertThat(empty.json().path("fieldErrors").has("expectedVersion")).isTrue();

    // An unsupported body media type answers 415 with the shared validation code (observed).
    Resp unsupported =
        owner.requestRaw(
            "PATCH",
            settingsPath(householdId),
            "text/plain",
            "{\"reportingTimeZone\":\"America/New_York\",\"expectedVersion\":0}",
            owner.csrfToken);
    assertThat(unsupported.status).isEqualTo(415);
    assertThat(unsupported.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");

    // Rejected transports change nothing.
    JsonNode stored = owner.get(settingsPath(householdId)).json();
    assertThat(stored.path("reportingTimeZone").asText()).isEqualTo("Etc/UTC");
    assertThat(stored.path("version").asInt()).isZero();
  }

  @Test
  void contributionsExactTaggedRefundsAndCurrentStateRestatement() throws Exception {
    Agent owner = signedInAgent("contribution-owner");
    String home = createHousehold(owner, "Contribution home");
    Agent member = signedInAgent("contribution-member");
    addMember(home, member.userId());
    String account = createAccount(owner, home, "Shared USD", "CASH", "USD");
    String expense =
        created(
            owner.createTransaction(
                home,
                UUID.randomUUID(),
                datedEntry(account, "EXPENSE", "-10.00", "USD", "Shared", "2026-09-10")));
    String allocationPath = transactionPath(home) + "/" + expense + "/allocation";
    Resp allocation =
        owner.request(
            "POST",
            allocationPath,
            "{\"expectedVersion\":0,\"participantShares\":["
                + "{\"userId\":\""
                + owner.userId()
                + "\",\"share\":{\"amount\":\"7.00\",\"currency\":\"USD\"}},"
                + "{\"userId\":\""
                + member.userId()
                + "\",\"share\":{\"amount\":\"3.00\",\"currency\":\"USD\"}}]}",
            owner.csrfToken,
            UUID.randomUUID());
    assertThat(allocation.status).as(allocation.body).isEqualTo(201);
    assertThat(allocation.json().path("refundPolicy").asText()).isEqualTo("EXACT_JEFFERSON_V1");
    String september = contributionsPath(home, "2026-09-01", "2026-10-01", "USD");
    JsonNode first = member.get(september).json();
    assertThat(first.propertyNames())
        .containsExactlyInAnyOrder(
            "from",
            "to",
            "reportingTimeZone",
            "currency",
            "snapshot",
            "totals",
            "items",
            "limit",
            "offset",
            "hasMore");
    assertThat(first.path("totals").propertyNames())
        .containsExactly(
            "expenseTotal", "refundTotal", "netSpending", "allocatedCostTotal", "unallocatedNet");
    assertThat(first.path("items").get(0).propertyNames())
        .containsExactly(
            "userId",
            "membershipStatus",
            "expensePaid",
            "refundReceived",
            "netPaid",
            "allocatedCost");
    assertThat(first.path("totals").path("expenseTotal").asText()).isEqualTo("10.00");
    assertThat(first.path("totals").path("allocatedCostTotal").asText()).isEqualTo("10.00");
    assertThat(first.path("totals").path("unallocatedNet").asText()).isEqualTo("0.00");
    assertThat(contributionItem(first, owner.userId()).path("expensePaid").asText())
        .isEqualTo("10.00");
    assertThat(contributionItem(first, owner.userId()).path("allocatedCost").asText())
        .isEqualTo("7.00");
    assertThat(contributionItem(first, member.userId()).path("allocatedCost").asText())
        .isEqualTo("3.00");
    String repaymentPath = "/api/households/" + home + "/repayments";
    Resp pending =
        member.request(
            "POST",
            repaymentPath,
            "{\"recipientUserId\":\""
                + owner.userId()
                + "\",\"money\":{\"amount\":\"2.70\",\"currency\":\"USD\"},\"occurredOn\":\"2026-09-20\"}",
            member.csrfToken,
            UUID.randomUUID());
    assertThat(pending.status).as(pending.body).isEqualTo(201);
    Resp confirmed =
        owner.request(
            "POST",
            repaymentPath + "/" + pending.json().path("id").asText() + "/decision",
            "{\"expectedVersion\":0,\"decision\":\"CONFIRM\"}",
            owner.csrfToken,
            null);
    assertThat(confirmed.status).as(confirmed.body).isEqualTo(200);
    Resp afterRepayment = member.get(september);
    assertThat(afterRepayment.json()).isEqualTo(first);
    assertThat(afterRepayment.body)
        .doesNotContain("repaymentSent", "repaymentReceived", "accountId");
    assertThat(first.path("snapshot").asText()).matches("[0-9a-f]{64}");
    assertThat(member.get(september).json().path("snapshot")).isEqualTo(first.path("snapshot"));

    String refund =
        created(
            owner.createTransaction(
                home,
                UUID.randomUUID(),
                refundEntry(account, expense, "1.00", "USD", "Partial", "2026-10-05")));
    String october = contributionsPath(home, "2026-10-01", "2026-11-01", "USD");
    Resp octoberRead = member.get(october);
    assertThat(octoberRead.status).as(octoberRead.body).isEqualTo(200);
    assertThat(octoberRead.cacheControl()).contains("no-store");
    JsonNode period = octoberRead.json();
    assertThat(period.path("totals").path("expenseTotal").asText()).isEqualTo("0.00");
    assertThat(period.path("totals").path("refundTotal").asText()).isEqualTo("1.00");
    assertThat(period.path("totals").path("netSpending").asText()).isEqualTo("-1.00");
    assertThat(period.path("totals").path("allocatedCostTotal").asText()).isEqualTo("-1.00");
    assertThat(contributionItem(period, owner.userId()).path("netPaid").asText())
        .isEqualTo("-1.00");
    assertThat(contributionItem(period, owner.userId()).path("allocatedCost").asText())
        .isEqualTo("-0.70");
    assertThat(contributionItem(period, member.userId()).path("allocatedCost").asText())
        .isEqualTo("-0.30");
    assertThat(member.get(september).json().path("snapshot")).isEqualTo(first.path("snapshot"));

    // Corrected posted amount restates the same bucket; voiding removes it altogether.
    Resp corrected =
        owner.patchTransaction(
            home,
            refund,
            "{\"expectedVersion\":0,\"money\":{\"amount\":\"2.00\",\"currency\":\"USD\"}}");
    assertThat(corrected.status).as(corrected.body).isEqualTo(200);
    JsonNode doubled = member.get(october).json();
    assertThat(contributionItem(doubled, owner.userId()).path("allocatedCost").asText())
        .isEqualTo("-1.40");
    assertThat(contributionItem(doubled, member.userId()).path("allocatedCost").asText())
        .isEqualTo("-0.60");
    assertThat(
            member
                .get(october + "&snapshot=" + period.path("snapshot").asText())
                .json()
                .path("code")
                .asText())
        .isEqualTo("CONTRIBUTION_SNAPSHOT_STALE");
    Resp voided =
        owner.patchTransaction(home, refund, "{\"expectedVersion\":1,\"status\":\"VOIDED\"}");
    assertThat(voided.status).as(voided.body).isEqualTo(200);
    assertThat(member.get(october).json().path("items").size()).isZero();
    assertThat(member.get(september).json().path("snapshot")).isEqualTo(first.path("snapshot"));

    int expenseVersion =
        owner.get(transactionPath(home) + "/" + expense).json().path("version").asInt();
    Resp revoked =
        owner.request(
            "PATCH",
            allocationPath,
            "{\"expectedVersion\":" + expenseVersion + ",\"status\":\"REVOKED\"}",
            owner.csrfToken,
            null);
    assertThat(revoked.status).as(revoked.body).isEqualTo(200);
    JsonNode unallocated = member.get(september).json();
    assertThat(unallocated.path("totals").path("allocatedCostTotal").asText()).isEqualTo("0.00");
    assertThat(unallocated.path("totals").path("unallocatedNet").asText()).isEqualTo("10.00");
    assertThat(unallocated.path("snapshot")).isNotEqualTo(first.path("snapshot"));
  }

  @Test
  void contributionsPaginationPrivacyMembershipAndValidation() throws Exception {
    Agent owner = signedInAgent("contribution-guard");
    String home = createHousehold(owner, "Contribution guarded home");
    Agent member = signedInAgent("contribution-departed");
    addMember(home, member.userId());
    Agent outsider = signedInAgent("contribution-outsider");
    String ownerAccount = createAccount(owner, home, "Shared USD", "CASH", "USD");
    String memberAccount = createAccount(member, home, "Member USD", "CASH", "USD");
    String firstExpense =
        created(
            owner.createTransaction(
                home,
                UUID.randomUUID(),
                datedEntry(ownerAccount, "EXPENSE", "-5.00", "USD", "First", "2026-09-10")));
    String secondExpense =
        created(
            member.createTransaction(
                home,
                UUID.randomUUID(),
                datedEntry(memberAccount, "EXPENSE", "-5.00", "USD", "Second", "2026-09-10")));
    created(
        owner.createTransaction(
            home,
            UUID.randomUUID(),
            privateEntry(ownerAccount, "EXPENSE", "-99.00", "USD", "Private", "2026-09-10")));
    String path = contributionsPath(home, "2026-09-01", "2026-10-01", "USD");
    JsonNode page = owner.get(path + "&limit=1").json();
    assertThat(page.path("totals").path("netSpending").asText()).isEqualTo("10.00");
    assertThat(page.path("totals").path("unallocatedNet").asText()).isEqualTo("10.00");
    assertThat(page.path("items").size()).isEqualTo(1);
    assertThat(page.path("hasMore").asBoolean()).isTrue();
    String snapshot = page.path("snapshot").asText();
    JsonNode next = owner.get(path + "&limit=1&offset=1&snapshot=" + snapshot).json();
    assertThat(next.path("totals")).isEqualTo(page.path("totals"));
    assertThat(next.path("items").size()).isEqualTo(1);
    assertThat(next.path("hasMore").asBoolean()).isFalse();
    assertThat(next.path("items").get(0).path("userId").asText())
        .isNotEqualTo(page.path("items").get(0).path("userId").asText());
    assertThat(page.toString()).doesNotContain("Private", "repayment", "accountId", "description");
    assertThat(
            owner.patchTransaction(
                    home,
                    firstExpense,
                    "{\"expectedVersion\":0,\"money\":{\"amount\":\"-4.00\",\"currency\":\"USD\"}}")
                .status)
        .isEqualTo(200);
    assertThat(
            member.patchTransaction(
                    home,
                    secondExpense,
                    "{\"expectedVersion\":0,\"money\":{\"amount\":\"-6.00\",\"currency\":\"USD\"}}")
                .status)
        .isEqualTo(200);
    JsonNode moved = owner.get(path).json();
    assertThat(moved.path("totals")).isEqualTo(page.path("totals"));
    assertThat(moved.path("snapshot")).isNotEqualTo(page.path("snapshot"));
    assertThat(
            owner.get(path + "&limit=1&offset=1&snapshot=" + snapshot).json().path("code").asText())
        .isEqualTo("CONTRIBUTION_SNAPSHOT_STALE");
    assertThat(owner.removeMember(home, member.userId()).status).isEqualTo(204);
    JsonNode departed = owner.get(path).json();
    assertThat(contributionItem(departed, member.userId()).path("membershipStatus").asText())
        .isEqualTo("DEPARTED");
    assertThat(contributionItem(departed, owner.userId()).path("membershipStatus").asText())
        .isEqualTo("CURRENT");
    assertThat(departed.path("totals")).isEqualTo(page.path("totals"));
    assertThat(departed.path("snapshot")).isNotEqualTo(page.path("snapshot"));
    assertThat(
            owner.get(path + "&limit=1&offset=1&snapshot=" + snapshot).json().path("code").asText())
        .isEqualTo("CONTRIBUTION_SNAPSHOT_STALE");
    assertThat(member.get(path).status).isEqualTo(404);
    assertThat(outsider.get(path).status).isEqualTo(404);
    assertThat(anonymousGet(path).status).isEqualTo(401);
    assertThat(
            owner
                .get(contributionsPath(home, "2026-09-01", "2026-10-01", "JPY"))
                .json()
                .path("totals")
                .path("netSpending")
                .asText())
        .isEqualTo("0");
    assertThat(
            owner
                .get(contributionsPath(home, "2026-09-01", "2026-10-01", "JPY"))
                .json()
                .path("items")
                .size())
        .isZero();
    for (String bad :
        new String[] {
          path + "&offset=1",
          path + "&limit=0",
          path + "&limit=101",
          path + "&offset=10001",
          path + "&offset=-1",
          path + "&limit=01",
          path + "&limit=",
          path + "&snapshot=null",
          path + "&snapshot=ABC",
          path + "&currency=USD",
          path + "&extra=x",
          contributionsPath(home, "2026-10-01", "2026-09-01", "USD"),
          contributionsPath(home, "2026-09-01", "2026-10-01", "usd"),
          contributionsPath(home, "2026-09-01", "2026-10-01", "null"),
          contributionsPath(home, "2026-09-01", "2026-10-01", ""),
          contributionsPath(home, "2026-09-01", "2026-10-01", "USD").replace("&currency=USD", "")
        }) {
      Resp rejected = owner.get(bad);
      assertThat(rejected.status).as(bad + " " + rejected.body).isEqualTo(400);
      assertThat(rejected.json().path("code").asText()).isEqualTo("VALIDATION_FAILED");
    }
  }

  @Test
  void contributionsExactCurrencyScalesAndCumulativeBoundaryBuckets() throws Exception {
    Agent owner = signedInAgent("contribution-scales");
    String home = createHousehold(owner, "Contribution scales home");
    Agent member = signedInAgent("contribution-scales-member");
    addMember(home, member.userId());
    String jpy = createAccount(owner, home, "JPY shared", "CASH", "JPY");
    String kwd = createAccount(owner, home, "KWD shared", "CASH", "KWD");
    String yen =
        created(
            owner.createTransaction(
                home,
                UUID.randomUUID(),
                datedEntry(jpy, "EXPENSE", "-3", "JPY", "Yen", "2026-09-10")));
    String dinar =
        created(
            owner.createTransaction(
                home,
                UUID.randomUUID(),
                datedEntry(kwd, "EXPENSE", "-1.001", "KWD", "Dinar", "2026-09-10")));
    for (String expense : new String[] {yen, dinar}) {
      Resp split =
          owner.request(
              "POST",
              transactionPath(home) + "/" + expense + "/allocation",
              "{\"expectedVersion\":0,\"participantUserIds\":[\""
                  + owner.userId()
                  + "\",\""
                  + member.userId()
                  + "\"]}",
              owner.csrfToken,
              UUID.randomUUID());
      assertThat(split.status).as(split.body).isEqualTo(201);
      assertThat(split.json().path("refundPolicy").asText()).isEqualTo("EQUAL_V1");
    }
    JsonNode yenSeptember =
        owner.get(contributionsPath(home, "2026-09-01", "2026-10-01", "JPY")).json();
    assertThat(yenSeptember.path("totals").path("expenseTotal").asText()).isEqualTo("3");
    assertThat(yenSeptember.path("totals").path("allocatedCostTotal").asText()).isEqualTo("3");
    assertThat(
            owner
                .get(contributionsPath(home, "2026-09-01", "2026-10-01", "KWD"))
                .json()
                .path("totals")
                .path("expenseTotal")
                .asText())
        .isEqualTo("1.001");
    created(
        owner.createTransaction(
            home,
            UUID.randomUUID(),
            refundEntry(jpy, yen, "1", "JPY", "Before boundary", "2026-09-30")));
    String octoberRefund =
        created(
            owner.createTransaction(
                home,
                UUID.randomUUID(),
                refundEntry(jpy, yen, "1", "JPY", "Inside boundary", "2026-10-01")));
    String october = contributionsPath(home, "2026-10-01", "2026-11-01", "JPY");
    JsonNode partial = owner.get(october).json();
    assertThat(partial.path("totals").path("refundTotal").asText()).isEqualTo("1");
    assertThat(partial.path("totals").path("allocatedCostTotal").asText()).isEqualTo("-1");
    assertThat(partial.path("totals").path("unallocatedNet").asText()).isEqualTo("0");
    assertThat(
            owner.patchTransaction(
                    home,
                    octoberRefund,
                    "{\"expectedVersion\":0,\"money\":{\"amount\":\"2\",\"currency\":\"JPY\"}}")
                .status)
        .isEqualTo(200);
    JsonNode fullyRefunded = owner.get(october).json();
    assertThat(fullyRefunded.path("totals").path("allocatedCostTotal").asText()).isEqualTo("-2");
    assertThat(contributionItem(fullyRefunded, owner.userId()).path("allocatedCost").asText())
        .isEqualTo("-1");
    assertThat(contributionItem(fullyRefunded, member.userId()).path("allocatedCost").asText())
        .isEqualTo("-1");
    created(
        owner.createTransaction(
            home,
            UUID.randomUUID(),
            refundEntry(kwd, dinar, "0.001", "KWD", "Fractional", "2026-10-05")));
    JsonNode kwdOctober =
        owner.get(contributionsPath(home, "2026-10-01", "2026-11-01", "KWD")).json();
    assertThat(kwdOctober.path("totals").path("refundTotal").asText()).isEqualTo("0.001");
    assertThat(kwdOctober.path("totals").path("allocatedCostTotal").asText()).isEqualTo("-0.001");
    assertThat(kwdOctober.path("totals").path("unallocatedNet").asText()).isEqualTo("0.000");
    assertThat(
            owner
                .get(contributionsPath(home, "9999-12-30", "9999-12-31", "KWD"))
                .json()
                .path("totals")
                .path("netSpending")
                .asText())
        .isEqualTo("0.000");
  }

  private static String contributionsPath(String home, String from, String to, String currency) {
    return "/api/households/"
        + home
        + "/contribution-summary?from="
        + from
        + "&to="
        + to
        + "&currency="
        + currency;
  }

  private static JsonNode contributionItem(JsonNode report, String userId) {
    for (JsonNode item : report.path("items")) {
      if (userId.equals(item.path("userId").asText())) return item;
    }
    throw new AssertionError("No contribution row for user " + userId);
  }

  private void addMember(String householdId, String userId) {
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?::uuid, ?::uuid, 'MEMBER')",
        householdId,
        userId);
  }

  private static String settingsPath(String householdId) {
    return "/api/households/" + householdId + "/finance-settings";
  }

  private static String summaryPath(String householdId, String from, String to) {
    StringBuilder path =
        new StringBuilder("/api/households/").append(householdId).append("/spending-summary?");
    boolean first = true;
    if (from != null) {
      path.append("from=").append(from);
      first = false;
    }
    if (to != null) {
      if (!first) path.append("&");
      path.append("to=").append(to);
    }
    return path.toString();
  }

  private static String datedEntry(
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
        + "\",\"visibility\":\"HOUSEHOLD\"}";
  }

  private static String privateEntry(
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

  private static String refundEntry(
      String accountId,
      String sourceId,
      String amount,
      String currency,
      String description,
      String date) {
    return "{\"accountId\":\""
        + accountId
        + "\",\"kind\":\"REFUND\","
        + "\"money\":{\"amount\":\""
        + amount
        + "\",\"currency\":\""
        + currency
        + "\"},"
        + "\"occurredOn\":\""
        + date
        + "\",\"description\":\""
        + description
        + "\",\"refundOfTransactionId\":\""
        + sourceId
        + "\"}";
  }

  private Agent signedInAgent(String tag) throws Exception {
    Agent agent = new Agent();
    String email =
        tag + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + "@example.test";
    assertThat(agent.post("/api/auth/register", identityJson(email), agent.csrfToken()).status)
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
    assertThat(response.status).as(response.body).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String created(Resp response) throws Exception {
    assertThat(response.status).as(response.body).isEqualTo(201);
    return response.json().path("id").asText();
  }

  private static String identityJson(String email) {
    return "{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD + "\"}";
  }

  private Resp anonymousGet(String path) throws Exception {
    HttpRequest request =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
            .timeout(Duration.ofSeconds(10))
            .header("Accept", "application/json")
            .GET()
            .build();
    HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
    return new Resp(response.statusCode(), response.body(), response.headers());
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

    Resp removeMember(String householdId, String userId) throws Exception {
      return request(
          "DELETE", "/api/households/" + householdId + "/members/" + userId, null, csrfToken, null);
    }

    Resp request(String method, String path, String json, String csrf, UUID idempotencyKey)
        throws Exception {
      return requestRaw(
          method, path, json == null ? null : "application/json", json, csrf, idempotencyKey);
    }

    Resp requestRaw(String method, String path, String contentType, String body, String csrf)
        throws Exception {
      return requestRaw(method, path, contentType, body, csrf, null);
    }

    Resp requestRaw(
        String method,
        String path,
        String contentType,
        String body,
        String csrf,
        UUID idempotencyKey)
        throws Exception {
      HttpRequest.Builder builder =
          HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
              .timeout(Duration.ofSeconds(15))
              .header("Accept", "application/json")
              .method(
                  method,
                  body == null
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofString(body));
      if (contentType != null) builder.header("Content-Type", contentType);
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
