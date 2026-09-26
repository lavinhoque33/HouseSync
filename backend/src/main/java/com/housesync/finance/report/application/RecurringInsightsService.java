package com.housesync.finance.report.application;

import static com.housesync.finance.report.application.RecurrencePolicy.*;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.categorization.domain.RuleTextNormalizer;
import com.housesync.finance.report.web.RecurringResponses.*;
import com.housesync.household.application.HouseholdService;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Recomputes current disclosed recurrence facts; never retains inferred descriptions or evidence.
 */
@Service
public class RecurringInsightsService {
  private final HouseholdService households;
  private final JdbcTemplate jdbc;
  private final Clock clock;

  public RecurringInsightsService(HouseholdService households, JdbcTemplate jdbc, Clock clock) {
    this.households = households;
    this.jdbc = jdbc;
    this.clock = clock;
  }

  private record Context(
      UUID household,
      UUID actor,
      SupportedCurrency currency,
      String zone,
      LocalDate today,
      Bounds bounds) {}

  private Context context(UUID household, UUID actor, SupportedCurrency currency) {
    households.lockForFinance(household, actor);
    String zone = households.financeSettings(household).reportingTimeZone();
    LocalDate today = LocalDate.now(clock.withZone(ZoneId.of(zone)));
    return new Context(household, actor, currency, zone, today, bounds(today));
  }

  private Context context(UUID household, UUID actor, SupportedCurrency currency, LocalDate today) {
    households.lockForFinance(household, actor);
    String zone = households.financeSettings(household).reportingTimeZone();
    return new Context(household, actor, currency, zone, today, bounds(today));
  }

  private record Row(
      UUID id,
      int version,
      LocalDate date,
      BigDecimal amount,
      String description,
      String category,
      Instant created) {}

  private static Row row(ResultSet rs, int index) throws SQLException {
    return new Row(
        (UUID) rs.getObject(index),
        rs.getInt(index + 1),
        rs.getObject(index + 2, LocalDate.class),
        rs.getBigDecimal(index + 3),
        rs.getString(index + 4),
        rs.getString(index + 5),
        rs.getTimestamp(index + 6).toInstant());
  }

  private Map<String, List<Row>> evidence(Context c) {
    Map<String, List<Row>> grouped = new HashMap<>();
    jdbc.query(
        "SELECT t.id,t.version,t.occurred_on,t.amount,t.description,t.category,t.created_at "
            + "FROM financial_transactions t WHERE t.household_id=? AND t.currency=? "
            + "AND t.kind='EXPENSE' AND t.status='POSTED' AND t.visibility='HOUSEHOLD' "
            + "AND t.occurred_on>=? AND t.occurred_on<? AND EXISTS "
            + "(SELECT 1 FROM household_members m WHERE m.household_id=t.household_id AND m.user_id=?) "
            + "ORDER BY t.occurred_on ASC,t.id ASC",
        ps -> {
          ps.setObject(1, c.household);
          ps.setString(2, c.currency.name());
          ps.setObject(3, c.bounds.from());
          ps.setObject(4, c.bounds.to());
          ps.setObject(5, c.actor);
          ps.setFetchSize(256);
        },
        (org.springframework.jdbc.core.RowCallbackHandler)
            rs -> {
              Row r = row(rs, 1);
              RuleTextNormalizer.normalize(r.description)
                  .ifPresent(
                      label ->
                          grouped
                              .computeIfAbsent(
                                  SpendingInsightsService.merchantKey(
                                      c.household, c.currency, label),
                                  ignored -> new ArrayList<>())
                              .add(r));
            });
    return grouped;
  }

  private record Preference(String status, int version) {}

  private Map<String, Preference> preferences(Context c) {
    Map<String, Preference> result = new HashMap<>();
    jdbc.query(
        "SELECT merchant_key,status,version FROM recurring_review_preferences "
            + "WHERE household_id=? AND actor_user_id=? AND currency=?",
        ps -> {
          ps.setObject(1, c.household);
          ps.setObject(2, c.actor);
          ps.setString(3, c.currency.name());
        },
        (org.springframework.jdbc.core.RowCallbackHandler)
            rs -> result.put(rs.getString(1), new Preference(rs.getString(2), rs.getInt(3))));
    return result;
  }

  private Map<String, Plan> active(Context c) {
    Map<String, Plan> result = new HashMap<>();
    jdbc.query(
        "SELECT * FROM recurring_plans WHERE household_id=? AND currency=? AND status='ACTIVE'",
        ps -> {
          ps.setObject(1, c.household);
          ps.setString(2, c.currency.name());
        },
        (org.springframework.jdbc.core.RowCallbackHandler)
            rs -> {
              Plan p = plan(rs);
              result.put(p.merchantKey(), p);
            });
    return result;
  }

  private static String magnitude(Row r, SupportedCurrency currency) {
    return exact(r.amount.abs(), currency);
  }

  private static String candidateFingerprint(
      Context c,
      String merchantKey,
      List<Row> rows,
      String cadence,
      String min,
      String median,
      String max,
      String pattern,
      String kind,
      String next,
      String state) {
    try (Hash hash =
        new Hash(
            "candidate",
            c.household.toString(),
            c.currency.name(),
            c.bounds.from().toString(),
            c.bounds.to().toString(),
            merchantKey)) {
      hash.count(rows.size());
      for (Row r : rows)
        hash.add(
            r.id.toString(),
            Integer.toString(r.version),
            r.date.toString(),
            magnitude(r, c.currency),
            r.category);
      hash.add(cadence, min, median, max, pattern, kind, next, state);
      return hash.finish();
    }
  }

  private static Candidate candidate(
      Context c, String merchantKey, List<Row> rows, Preference preference, Plan plan) {
    if (rows == null || rows.size() < 3) return null;
    LocalDate first = rows.get(0).date;
    List<String> fitting = new ArrayList<>();
    for (String cadence : List.of("WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL")) {
      String anchor = calendarAnchor(first, cadence);
      boolean valid = true;
      for (int i = 0; i < rows.size(); i++) {
        LocalDate expected = slot(first, cadence, anchor, i);
        if (expected == null
            || Math.abs(ChronoUnit.DAYS.between(expected, rows.get(i).date)) > tolerance(cadence)) {
          valid = false;
          break;
        }
      }
      if (valid) fitting.add(cadence);
    }
    if (fitting.size() != 1) return null;
    String cadence = fitting.get(0), anchor = calendarAnchor(first, cadence);
    List<BigInteger> amounts =
        rows.stream()
            .map(r -> r.amount.abs().movePointRight(c.currency.scale()).toBigIntegerExact())
            .sorted()
            .toList();
    BigInteger low = amounts.get(0),
        med = amounts.get((amounts.size() - 1) / 2),
        high = amounts.get(amounts.size() - 1);
    String min = minor(low, c.currency),
        median = minor(med, c.currency),
        max = minor(high, c.currency);
    String pattern =
        high.subtract(low).multiply(BigInteger.TEN).compareTo(med) <= 0 ? "STABLE" : "VARIABLE";
    String kind =
        rows.stream().allMatch(r -> "SUBSCRIPTIONS".equals(r.category))
            ? "SUBSCRIPTION"
            : (rows.stream().allMatch(r -> "UTILITIES".equals(r.category))
                    || rows.stream().allMatch(r -> "HOUSING".equals(r.category)))
                ? "BILL"
                : "RECURRING_EXPENSE";
    LocalDate next = slot(first, cadence, anchor, rows.size());
    String state =
        next == null
            ? "DATE_LIMIT"
            : c.today.isBefore(next.minusDays(tolerance(cadence)))
                ? "UPCOMING"
                : !c.today.isAfter(next.plusDays(tolerance(cadence)))
                    ? "DUE_WINDOW"
                    : "NOT_OBSERVED";
    String fingerprint =
        candidateFingerprint(
            c,
            merchantKey,
            rows,
            cadence,
            min,
            median,
            max,
            pattern,
            kind,
            next == null ? null : next.toString(),
            state);
    String label = RuleTextNormalizer.normalize(rows.get(0).description).orElseThrow();
    return new Candidate(
        merchantKey,
        label,
        cadence,
        first.toString(),
        anchor,
        Integer.toString(rows.size()),
        first.toString(),
        rows.get(rows.size() - 1).date.toString(),
        min,
        median,
        max,
        pattern,
        kind,
        next == null ? null : next.toString(),
        state,
        fingerprint,
        preference == null ? "OPEN" : preference.status,
        preference == null ? 0 : preference.version,
        plan == null ? null : plan.id());
  }

  private static String minor(BigInteger value, SupportedCurrency currency) {
    return new BigDecimal(value, currency.scale()).toPlainString();
  }

  private static String calendarAnchor(LocalDate first, String cadence) {
    if (cadence.equals("WEEKLY") || cadence.equals("BIWEEKLY")) return null;
    return first.getDayOfMonth() == first.lengthOfMonth() ? "END_OF_MONTH" : "DAY_OF_MONTH";
  }

  static void hashRow(Hash h, Row r, SupportedCurrency c) {
    h.add(
        r.id.toString(),
        Integer.toString(r.version),
        r.date.toString(),
        magnitude(r, c),
        r.description,
        r.category,
        r.created.toString());
  }

  private static void hashCandidate(Hash h, Candidate candidate, Plan active) {
    h.add(
        candidate.merchantKey(),
        candidate.label(),
        candidate.cadence(),
        candidate.anchorOn(),
        candidate.calendarAnchor(),
        candidate.occurrenceCount(),
        candidate.firstOccurredOn(),
        candidate.lastOccurredOn(),
        candidate.minAmount(),
        candidate.medianAmount(),
        candidate.maxAmount(),
        candidate.amountPattern(),
        candidate.suggestedKind(),
        candidate.nextExpectedOn(),
        candidate.expectationState(),
        candidate.candidateFingerprint(),
        candidate.reviewStatus(),
        Integer.toString(candidate.reviewVersion()),
        candidate.activePlanId() == null ? null : candidate.activePlanId().toString(),
        active == null ? null : Integer.toString(active.version()));
  }

  private static Hash hash(String route, Context c, String filters) {
    return new Hash(
        route,
        c.household.toString(),
        c.currency.name(),
        filters,
        c.zone,
        c.today.toString(),
        c.bounds.from().toString(),
        c.bounds.to().toString());
  }

  @Transactional
  public CandidatePage candidates(
      UUID household,
      UUID actor,
      SupportedCurrency currency,
      String review,
      int limit,
      String cursor) {
    Context c = context(household, actor, currency);
    Map<String, List<Row>> grouped = evidence(c);
    Map<String, Preference> preferences = preferences(c);
    Map<String, Plan> plans = active(c);
    List<Candidate> candidates = new ArrayList<>();
    grouped.keySet().stream()
        .sorted()
        .forEach(
            key -> {
              Candidate candidate =
                  candidate(c, key, grouped.get(key), preferences.get(key), plans.get(key));
              if (candidate != null
                  && (review.equals("ALL") || candidate.reviewStatus().equals(review)))
                candidates.add(candidate);
            });
    try (Hash h = hash("recurring-candidates", c, review)) {
      h.count(candidates.size());
      for (Candidate candidate : candidates)
        hashCandidate(h, candidate, plans.get(candidate.merchantKey()));
      String snapshot = h.finish();
      int from =
          index(
              cursor,
              "recurring-candidates",
              household,
              currency,
              review,
              snapshot,
              candidates.size());
      int to = Math.min(candidates.size(), from + limit);
      return new CandidatePage(
          c.zone,
          c.today.toString(),
          currency.name(),
          POLICY,
          snapshot,
          c.bounds.from().toString(),
          c.bounds.to().toString(),
          List.copyOf(candidates.subList(from, to)),
          to == candidates.size()
              ? null
              : RecurrencePolicy.cursor(
                  "recurring-candidates", household, currency, review, snapshot, to));
    }
  }

  @Transactional
  public EvidencePage candidateEvidence(
      UUID household,
      UUID actor,
      SupportedCurrency currency,
      String key,
      int limit,
      String cursor) {
    Context c = context(household, actor, currency);
    List<Row> rows = evidence(c).getOrDefault(key, List.of());
    Plan linked = active(c).get(key);
    Candidate candidate = candidate(c, key, rows, preferences(c).get(key), linked);
    List<Row> ordered = descending(rows);
    try (Hash h = hash("recurring-evidence", c, key)) {
      h.count(ordered.size());
      for (Row row : ordered) hashRow(h, row, currency);
      if (candidate != null) hashCandidate(h, candidate, linked);
      else h.add((String) null);
      String snapshot = h.finish();
      int from =
          index(cursor, "recurring-evidence", household, currency, key, snapshot, ordered.size());
      int to = Math.min(ordered.size(), from + limit);
      return new EvidencePage(
          c.zone,
          c.today.toString(),
          currency.name(),
          POLICY,
          snapshot,
          c.bounds.from().toString(),
          c.bounds.to().toString(),
          key,
          candidate,
          ordered.subList(from, to).stream().map(r -> item(r, currency)).toList(),
          to == ordered.size()
              ? null
              : RecurrencePolicy.cursor(
                  "recurring-evidence", household, currency, key, snapshot, to));
    }
  }

  private static List<Row> descending(List<Row> rows) {
    List<Row> ordered = new ArrayList<>(rows);
    ordered.sort(
        Comparator.comparing(Row::date)
            .thenComparing(Row::created)
            .thenComparing(Row::id)
            .reversed());
    return ordered;
  }

  private static EvidenceItem item(Row r, SupportedCurrency currency) {
    return new EvidenceItem(
        r.id,
        r.version,
        "EXPENSE",
        r.date.toString(),
        new Money(exact(r.amount, currency), currency.name()),
        r.description,
        r.category,
        null);
  }

  @Transactional
  public Review review(
      UUID household,
      UUID actor,
      SupportedCurrency currency,
      String key,
      String fingerprint,
      int version,
      String status) {
    Context c = context(household, actor, currency);
    Candidate current =
        candidate(c, key, evidence(c).get(key), preferences(c).get(key), active(c).get(key));
    if (current == null || !current.candidateFingerprint().equals(fingerprint))
      throw new SpendingInsightsService.InsightSnapshotStaleException();
    if (current.reviewVersion() != version) throw new RecurringExceptions.VersionConflict();
    if (current.reviewStatus().equals(status))
      return new Review(key, currency.name(), status, version);
    if (version == Integer.MAX_VALUE) throw new RecurringExceptions.VersionExhausted();
    Integer count =
        jdbc.queryForObject(
            "SELECT count(*) FROM recurring_review_preferences WHERE household_id=? AND actor_user_id=?",
            Integer.class,
            household,
            actor);
    if (version == 0 && count != null && count >= 1000)
      jdbc.update(
          "DELETE FROM recurring_review_preferences WHERE household_id=? AND actor_user_id=? AND (currency,merchant_key) IN "
              + "(SELECT currency,merchant_key FROM recurring_review_preferences WHERE household_id=? AND actor_user_id=? "
              + "ORDER BY updated_at,merchant_key,currency LIMIT 1)",
          household,
          actor,
          household,
          actor);
    jdbc.update(
        "INSERT INTO recurring_review_preferences (household_id,actor_user_id,currency,merchant_key,status,version,updated_at) "
            + "VALUES (?,?,?,?,?,?,?) ON CONFLICT (household_id,actor_user_id,currency,merchant_key) DO UPDATE SET "
            + "status=EXCLUDED.status,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at",
        household,
        actor,
        currency.name(),
        key,
        status,
        version + 1,
        java.sql.Timestamp.from(Instant.now(clock)));
    return new Review(key, currency.name(), status, version + 1);
  }

  private static Plan plan(ResultSet r) throws SQLException {
    return new Plan(
        (UUID) r.getObject("id"),
        (UUID) r.getObject("household_id"),
        r.getString("label"),
        r.getString("kind"),
        r.getString("currency"),
        r.getString("match_description"),
        r.getString("merchant_key"),
        r.getString("cadence"),
        r.getObject("anchor_on", LocalDate.class).toString(),
        r.getString("calendar_anchor"),
        r.getBigDecimal("expected_amount") == null
            ? null
            : exact(
                r.getBigDecimal("expected_amount"),
                SupportedCurrency.valueOf(r.getString("currency"))),
        r.getString("status"),
        r.getInt("version"),
        r.getTimestamp("created_at").toInstant(),
        r.getTimestamp("updated_at").toInstant());
  }

  private List<Plan> plans(UUID household, String sql, Object... args) {
    return jdbc.query(sql, (rs, n) -> plan(rs), args);
  }

  private Plan requirePlan(UUID household, UUID id) {
    List<Plan> found =
        plans(
            household,
            "SELECT * FROM recurring_plans WHERE household_id=? AND id=?",
            household,
            id);
    if (found.isEmpty()) throw new RecurringExceptions.NotFound();
    return found.get(0);
  }

  @Transactional
  public Plan detail(UUID household, UUID actor, UUID id) {
    households.lockForFinance(household, actor);
    return requirePlan(household, id);
  }

  @Transactional
  public PlanPage list(
      UUID household,
      UUID actor,
      SupportedCurrency currency,
      String status,
      int limit,
      int offset) {
    households.lockForFinance(household, actor);
    List<Plan> items =
        plans(
            household,
            "SELECT * FROM recurring_plans WHERE household_id=? AND currency=? "
                + (status.equals("ALL") ? "" : "AND status=? ")
                + "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
            status.equals("ALL")
                ? new Object[] {household, currency.name(), limit + 1, offset}
                : new Object[] {household, currency.name(), status, limit + 1, offset});
    return new PlanPage(
        List.copyOf(items.subList(0, Math.min(limit, items.size()))),
        limit,
        offset,
        items.size() > limit);
  }

  public record Input(
      String label,
      String kind,
      SupportedCurrency currency,
      String matchDescription,
      String cadence,
      String anchorOn,
      String calendarAnchor,
      String expectedAmount,
      boolean acknowledged,
      String candidateKey,
      String candidateFingerprint) {}

  public static Input validate(Input value, UUID household) {
    if (value == null
        || !value.acknowledged
        || value.currency == null
        || !List.of("BILL", "SUBSCRIPTION", "RECURRING_EXPENSE").contains(value.kind))
      throw invalid();
    String label = text(value.label, 100), match = text(value.matchDescription, 200);
    LocalDate anchor = date(value.anchorOn);
    schedule(value.cadence, anchor, value.calendarAnchor);
    String money = amount(value.expectedAmount, value.currency);
    String key = key(household, value.currency, match);
    if ((value.candidateKey == null) != (value.candidateFingerprint == null)
        || (value.candidateKey != null
            && (!value.candidateKey.equals(key)
                || !value.candidateFingerprint.matches("[0-9a-f]{64}")))) throw invalid();
    return new Input(
        label,
        value.kind,
        value.currency,
        match,
        value.cadence,
        anchor.toString(),
        value.calendarAnchor,
        money,
        true,
        value.candidateKey,
        value.candidateFingerprint);
  }

  private void owner(UUID household, UUID actor) {
    if (!"OWNER".equals(households.get(household, actor).role()))
      throw new RecurringExceptions.Forbidden();
  }

  private static String intentFingerprint(Input input) {
    try (Hash h =
        new Hash(
            "recurring-plan-create",
            input.label,
            input.kind,
            input.currency.name(),
            input.matchDescription,
            input.cadence,
            input.anchorOn,
            input.calendarAnchor,
            input.expectedAmount,
            Boolean.toString(input.acknowledged),
            input.candidateKey,
            input.candidateFingerprint)) {
      return h.finish();
    }
  }

  public record Creation(Plan plan, boolean replayed) {}

  @Transactional
  public Creation create(UUID household, UUID actor, Input raw, UUID retryKey) {
    Input input = validate(raw, household);
    Context c = context(household, actor, input.currency);
    owner(household, actor);
    String fingerprint = intentFingerprint(input);
    List<Map<String, Object>> existing =
        jdbc.queryForList(
            "SELECT request_fingerprint,plan_id FROM recurring_plan_idempotency_keys "
                + "WHERE household_id=? AND actor_user_id=? AND operation='RECURRING_PLAN_CREATE' AND idempotency_key=?",
            household,
            actor,
            retryKey);
    if (!existing.isEmpty()) {
      if (!fingerprint.equals(existing.get(0).get("request_fingerprint")))
        throw new RecurringExceptions.IdempotencyConflict();
      return new Creation(requirePlan(household, (UUID) existing.get(0).get("plan_id")), true);
    }
    if (input.candidateKey != null) {
      Candidate candidate =
          candidate(
              c,
              input.candidateKey,
              evidence(c).get(input.candidateKey),
              preferences(c).get(input.candidateKey),
              active(c).get(input.candidateKey));
      if (candidate == null || !candidate.candidateFingerprint().equals(input.candidateFingerprint))
        throw new SpendingInsightsService.InsightSnapshotStaleException();
    }
    String merchantKey = key(household, input.currency, input.matchDescription);
    if (!plans(
            household,
            "SELECT * FROM recurring_plans WHERE household_id=? AND currency=? AND merchant_key=? AND status='ACTIVE'",
            household,
            input.currency.name(),
            merchantKey)
        .isEmpty()) throw new RecurringExceptions.Conflict();
    UUID id = UUID.randomUUID();
    java.sql.Timestamp now = java.sql.Timestamp.from(Instant.now(clock));
    jdbc.update(
        "INSERT INTO recurring_plans(id,household_id,label,kind,currency,match_description,merchant_key,cadence,"
            + "anchor_on,calendar_anchor,expected_amount,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',0,?,?)",
        id,
        household,
        input.label,
        input.kind,
        input.currency.name(),
        input.matchDescription,
        merchantKey,
        input.cadence,
        LocalDate.parse(input.anchorOn),
        input.calendarAnchor,
        input.expectedAmount == null ? null : new BigDecimal(input.expectedAmount),
        now,
        now);
    jdbc.update(
        "INSERT INTO recurring_plan_idempotency_keys(actor_user_id,household_id,operation,idempotency_key,"
            + "request_fingerprint,plan_id,created_at) VALUES (?,?,'RECURRING_PLAN_CREATE',?,?,?,?)",
        actor,
        household,
        retryKey,
        fingerprint,
        id,
        now);
    return new Creation(requirePlan(household, id), false);
  }

  @Transactional
  public Plan patch(
      UUID household,
      UUID actor,
      UUID id,
      int expectedVersion,
      Map<String, String> edits,
      boolean acknowledged) {
    households.lockForFinance(household, actor);
    owner(household, actor);
    Plan current = requirePlan(household, id);
    if (current.version() != expectedVersion) throw new RecurringExceptions.VersionConflict();
    if (edits.containsKey("status")) {
      if (edits.size() != 1 || !"ARCHIVED".equals(edits.get("status"))) throw invalid();
      if (current.status().equals("ARCHIVED")) return current;
      if (current.version() == Integer.MAX_VALUE) throw new RecurringExceptions.VersionExhausted();
      jdbc.update(
          "UPDATE recurring_plans SET status='ARCHIVED',version=version+1,updated_at=? WHERE id=?",
          java.sql.Timestamp.from(Instant.now(clock)),
          id);
      return requirePlan(household, id);
    }
    if (edits.isEmpty()) throw invalid();
    if (current.status().equals("ARCHIVED")) throw new RecurringExceptions.Conflict();
    if (!acknowledged) throw invalid();
    boolean trio =
        edits.keySet().stream()
            .anyMatch(k -> List.of("cadence", "anchorOn", "calendarAnchor").contains(k));
    if (trio && !edits.keySet().containsAll(List.of("cadence", "anchorOn", "calendarAnchor")))
      throw invalid();
    Input input =
        validate(
            new Input(
                edits.getOrDefault("label", current.label()),
                edits.getOrDefault("kind", current.kind()),
                SupportedCurrency.valueOf(current.currency()),
                edits.getOrDefault("matchDescription", current.matchDescription()),
                edits.getOrDefault("cadence", current.cadence()),
                edits.getOrDefault("anchorOn", current.anchorOn()),
                edits.containsKey("calendarAnchor")
                    ? edits.get("calendarAnchor")
                    : current.calendarAnchor(),
                edits.containsKey("expectedAmount")
                    ? edits.get("expectedAmount")
                    : current.expectedAmount(),
                true,
                null,
                null),
            household);
    String merchant = key(household, input.currency, input.matchDescription);
    if (input.label.equals(current.label())
        && input.kind.equals(current.kind())
        && input.matchDescription.equals(current.matchDescription())
        && input.cadence.equals(current.cadence())
        && input.anchorOn.equals(current.anchorOn())
        && java.util.Objects.equals(input.calendarAnchor, current.calendarAnchor())
        && java.util.Objects.equals(input.expectedAmount, current.expectedAmount())) return current;
    if (current.version() == Integer.MAX_VALUE) throw new RecurringExceptions.VersionExhausted();
    if (!merchant.equals(current.merchantKey())
        && !plans(
                household,
                "SELECT * FROM recurring_plans WHERE household_id=? AND currency=? AND merchant_key=? AND status='ACTIVE'",
                household,
                current.currency(),
                merchant)
            .isEmpty()) throw new RecurringExceptions.Conflict();
    jdbc.update(
        "UPDATE recurring_plans SET label=?,kind=?,match_description=?,merchant_key=?,cadence=?,anchor_on=?,"
            + "calendar_anchor=?,expected_amount=?,version=version+1,updated_at=? WHERE id=?",
        input.label,
        input.kind,
        input.matchDescription,
        merchant,
        input.cadence,
        LocalDate.parse(input.anchorOn),
        input.calendarAnchor,
        input.expectedAmount == null ? null : new BigDecimal(input.expectedAmount),
        java.sql.Timestamp.from(Instant.now(clock)),
        id);
    return requirePlan(household, id);
  }

  private record Derived(Expectation expectation, List<Row> matches) {}

  private static Derived derive(Context c, Plan plan, List<Row> rows) {
    LocalDate anchor = LocalDate.parse(plan.anchorOn());
    String cadence = plan.cadence();
    int tolerance = tolerance(cadence);
    long guess = approximateSlot(anchor, c.today, cadence);
    while (guess >= 0
        && (slot(anchor, cadence, plan.calendarAnchor(), guess) == null
            || slot(anchor, cadence, plan.calendarAnchor(), guess).isAfter(c.today))) guess--;
    while (guess >= 0
        && slot(anchor, cadence, plan.calendarAnchor(), guess + 1) != null
        && !slot(anchor, cadence, plan.calendarAnchor(), guess + 1).isAfter(c.today)) guess++;
    LocalDate latest = guess < 0 ? null : slot(anchor, cadence, plan.calendarAnchor(), guess);
    LocalDate next = slot(anchor, cadence, plan.calendarAnchor(), guess + 1);
    if (latest == null)
      return new Derived(
          new Expectation(
              null, "NOT_STARTED", next == null ? null : next.toString(), null, null, null, null),
          List.of());
    LocalDate from = latest.minusDays(tolerance);
    LocalDate to = latest.plusDays(tolerance + 1L);
    if (from.isBefore(MIN)) from = MIN;
    if (to.isAfter(END)) to = END;
    final LocalDate start = from, end = to;
    List<Row> matched =
        rows.stream().filter(r -> !r.date.isBefore(start) && r.date.isBefore(end)).toList();
    String state =
        matched.size() == 1
            ? "OBSERVED"
            : matched.size() > 1
                ? "AMBIGUOUS"
                : !c.today.isAfter(latest.plusDays(tolerance)) ? "AWAITING" : "NOT_OBSERVED";
    return new Derived(
        new Expectation(
            latest.toString(),
            state,
            next == null ? null : next.toString(),
            from.toString(),
            to.toString(),
            Integer.toString(matched.size()),
            matched.size() == 1 ? magnitude(matched.get(0), c.currency) : null),
        matched);
  }

  private static void hashProjection(Hash h, Plan p, Derived d) {
    h.add(
        p.id().toString(),
        p.householdId().toString(),
        p.label(),
        p.kind(),
        p.currency(),
        p.matchDescription(),
        p.merchantKey(),
        p.cadence(),
        p.anchorOn(),
        p.calendarAnchor(),
        p.expectedAmount(),
        p.status(),
        Integer.toString(p.version()),
        p.createdAt().toString(),
        p.updatedAt().toString(),
        d.expectation.latestExpectedOn(),
        d.expectation.latestState(),
        d.expectation.nextExpectedOn(),
        d.expectation.windowFrom(),
        d.expectation.windowTo(),
        d.expectation.matchedCount(),
        d.expectation.observedAmount());
    h.count(d.matches.size());
    for (Row row : descending(d.matches)) hashRow(h, row, SupportedCurrency.valueOf(p.currency()));
  }

  /**
   * Complete current evidence and plan projection for the household summary, without paging or N+1
   * reads.
   */
  @Transactional
  public SummaryProjection summary(
      UUID household, UUID actor, SupportedCurrency currency, LocalDate today) {
    Context c = context(household, actor, currency, today);
    Map<String, List<Row>> evidence = evidence(c);
    Map<String, Preference> reviews = preferences(c);
    Map<String, Plan> active = active(c);
    List<Plan> plans = new ArrayList<>(active.values());
    Map<UUID, Derived> derived = new HashMap<>();
    for (Plan plan : plans)
      derived.put(plan.id(), derive(c, plan, evidence.getOrDefault(plan.merchantKey(), List.of())));
    plans.sort(
        Comparator.comparing(
                (Plan p) -> derived.get(p.id()).expectation.nextExpectedOn(),
                Comparator.nullsLast(String::compareTo))
            .thenComparing(Plan::id));
    long open = 0;
    try (Hash h = hash("summary-recurring", c, "")) {
      List<String> keys = new ArrayList<>(evidence.keySet());
      keys.sort(String::compareTo);
      h.count(keys.size());
      for (String key : keys) {
        List<Row> rows = evidence.get(key);
        h.add(key);
        h.count(rows.size());
        for (Row row : rows) hashRow(h, row, currency);
        Candidate candidate = candidate(c, key, rows, reviews.get(key), active.get(key));
        if (candidate != null) {
          hashCandidate(h, candidate, active.get(key));
          if (candidate.reviewStatus().equals("OPEN") && candidate.activePlanId() == null) open++;
        } else h.add((String) null);
      }
      h.count(plans.size());
      for (Plan plan : plans) hashProjection(h, plan, derived.get(plan.id()));
      return new SummaryProjection(
          c.zone,
          c.today.toString(),
          c.bounds.from().toString(),
          c.bounds.to().toString(),
          Long.toString(open),
          Integer.toString(plans.size()),
          plans.stream()
              .limit(5)
              .map(p -> new PlanProjection(p, derived.get(p.id()).expectation))
              .toList(),
          plans.size() > 5,
          h.finish());
    }
  }

  public record SummaryProjection(
      String reportingTimeZone,
      String asOfDate,
      String evidenceFrom,
      String evidenceTo,
      String openCandidateCount,
      String activePlanCount,
      List<PlanProjection> items,
      boolean hasMore,
      String fingerprint) {}

  @Transactional
  public ActivePlanPage activePlans(
      UUID household, UUID actor, SupportedCurrency currency, int limit, String cursor) {
    Context c = context(household, actor, currency);
    Map<String, List<Row>> evidence = evidence(c);
    List<Plan> plans = new ArrayList<>(active(c).values());
    Map<UUID, Derived> derived = new HashMap<>();
    for (Plan plan : plans)
      derived.put(plan.id(), derive(c, plan, evidence.getOrDefault(plan.merchantKey(), List.of())));
    plans.sort(
        Comparator.comparing(
                (Plan p) -> derived.get(p.id()).expectation.nextExpectedOn(),
                Comparator.nullsLast(String::compareTo))
            .thenComparing(Plan::id));
    try (Hash h = hash("recurring-plans", c, "")) {
      h.count(plans.size());
      for (Plan plan : plans) {
        hashProjection(h, plan, derived.get(plan.id()));
        List<Row> rows = evidence.getOrDefault(plan.merchantKey(), List.of());
        h.count(rows.size());
        for (Row row : rows) hashRow(h, row, currency);
      }
      String snapshot = h.finish();
      int from = index(cursor, "recurring-plans", household, currency, "", snapshot, plans.size());
      int to = Math.min(plans.size(), from + limit);
      return new ActivePlanPage(
          c.zone,
          c.today.toString(),
          currency.name(),
          POLICY,
          snapshot,
          c.bounds.from().toString(),
          c.bounds.to().toString(),
          plans.subList(from, to).stream()
              .map(p -> new PlanProjection(p, derived.get(p.id()).expectation))
              .toList(),
          to == plans.size()
              ? null
              : RecurrencePolicy.cursor("recurring-plans", household, currency, "", snapshot, to));
    }
  }

  @Transactional
  public ObservationPage observations(
      UUID household, UUID actor, UUID id, int limit, String cursor) {
    households.lockForFinance(household, actor);
    Plan plan = requirePlan(household, id);
    SupportedCurrency currency = SupportedCurrency.valueOf(plan.currency());
    Context c = context(household, actor, currency);
    Map<String, List<Row>> evidence = evidence(c);
    List<Row> rows = descending(evidence.getOrDefault(plan.merchantKey(), List.of()));
    Derived derived = derive(c, plan, rows);
    try (Hash h = hash("recurring-observations", c, id.toString())) {
      hashProjection(h, plan, derived);
      h.count(rows.size());
      for (Row row : rows) hashRow(h, row, currency);
      String snapshot = h.finish();
      int from =
          index(
              cursor,
              "recurring-observations",
              household,
              currency,
              id.toString(),
              snapshot,
              rows.size());
      int to = Math.min(rows.size(), from + limit);
      return new ObservationPage(
          c.zone,
          c.today.toString(),
          currency.name(),
          POLICY,
          snapshot,
          c.bounds.from().toString(),
          c.bounds.to().toString(),
          plan,
          derived.expectation,
          rows.subList(from, to).stream().map(r -> item(r, currency)).toList(),
          to == rows.size()
              ? null
              : RecurrencePolicy.cursor(
                  "recurring-observations", household, currency, id.toString(), snapshot, to));
    }
  }
}
