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
