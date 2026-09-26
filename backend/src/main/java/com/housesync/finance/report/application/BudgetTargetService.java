package com.housesync.finance.report.application;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.web.BudgetResponses.*;
import com.housesync.finance.report.web.SpendingInsightsResponse.Spend;
import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BudgetTargetService {
  public static final String POLICY = "BUDGETS_V1";
  private static final Pattern AMOUNT_INPUT =
      Pattern.compile("(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,3})?");
  private static final BigDecimal MAX_AMOUNT = new BigDecimal("1000000000000");
  private static final BigDecimal HUNDRED = BigDecimal.valueOf(100);
  private final HouseholdService households;
  private final JdbcTemplate jdbc;
  private final Clock clock;
  private final SpendingInsightsService spending;

  public BudgetTargetService(
      HouseholdService households,
      JdbcTemplate jdbc,
      Clock clock,
      SpendingInsightsService spending) {
    this.households = households;
    this.jdbc = jdbc;
    this.clock = clock;
    this.spending = spending;
  }

  public static class NotFound extends RuntimeException {}

  public static class Forbidden extends RuntimeException {}

  public static class Conflict extends RuntimeException {}

  public static class VersionConflict extends RuntimeException {}

  public static class VersionExhausted extends RuntimeException {}

  public static class IdempotencyConflict extends RuntimeException {}

  private static ValidationFailedException invalid() {
    return new ValidationFailedException(Map.of());
  }

  public static String bucket(String value) {
    if ("OVERALL".equals(value) || "UNCATEGORIZED".equals(value)) return value;
    try {
      return TransactionCategory.valueOf(value).name();
    } catch (IllegalArgumentException | NullPointerException failure) {
      throw invalid();
    }
  }

  public static boolean amountSyntax(String raw) {
    return raw != null && AMOUNT_INPUT.matcher(raw).matches();
  }

  public static String amount(String raw, SupportedCurrency currency) {
    if (!amountSyntax(raw)) throw invalid();
    BigDecimal value = new BigDecimal(raw);
    if (value.scale() > currency.scale() || value.compareTo(MAX_AMOUNT) >= 0) throw invalid();
    return value.setScale(currency.scale(), RoundingMode.UNNECESSARY).toPlainString();
  }

  private static BudgetTarget target(ResultSet rs, int ignored) throws SQLException {
    SupportedCurrency currency = SupportedCurrency.valueOf(rs.getString("currency"));
    return new BudgetTarget(
        (UUID) rs.getObject("id"),
        (UUID) rs.getObject("household_id"),
        rs.getString("month"),
        rs.getString("bucket"),
        new Money(RecurrencePolicy.exact(rs.getBigDecimal("amount"), currency), currency.name()),
        rs.getString("status"),
        rs.getInt("version"),
        rs.getTimestamp("created_at").toInstant(),
        rs.getTimestamp("updated_at").toInstant());
  }

  private BudgetTarget require(UUID household, UUID id) {
    List<BudgetTarget> found =
        jdbc.query(
            "SELECT * FROM budget_targets WHERE household_id=? AND id=?",
            BudgetTargetService::target,
            household,
            id);
    if (found.isEmpty()) throw new NotFound();
    return found.get(0);
  }

  private void owner(UUID household, UUID actor) {
    if (!"OWNER".equals(households.get(household, actor).role())) throw new Forbidden();
  }

  @Transactional
  public BudgetTarget detail(UUID household, UUID actor, UUID id) {
    households.lockForFinance(household, actor);
    return require(household, id);
  }

  @Transactional
  public Page list(
      UUID household,
      UUID actor,
      YearMonth month,
      SupportedCurrency currency,
      String status,
      int limit,
      int offset) {
    households.lockForFinance(household, actor);
    List<BudgetTarget> items =
        jdbc.query(
            "SELECT * FROM budget_targets WHERE household_id=? AND month=? AND currency=? "
                + (status.equals("ALL") ? "" : "AND status=? ")
                + "ORDER BY bucket COLLATE \"C\",created_at DESC,id DESC LIMIT ? OFFSET ?",
            BudgetTargetService::target,
            status.equals("ALL")
                ? new Object[] {household, month.toString(), currency.name(), limit + 1, offset}
                : new Object[] {
                  household, month.toString(), currency.name(), status, limit + 1, offset
                });
    return new Page(
        List.copyOf(items.subList(0, Math.min(items.size(), limit))),
        limit,
        offset,
        items.size() > limit);
  }

  public record Creation(BudgetTarget target, boolean replayed) {}

  @Transactional
  public Creation create(
      UUID household,
      UUID actor,
      YearMonth month,
      String rawBucket,
      SupportedCurrency currency,
      String rawAmount,
      UUID key) {
    String bucket = bucket(rawBucket), amount = amount(rawAmount, currency);
    households.lockForFinance(household, actor);
    owner(household, actor);
    String fingerprint;
    try (var hash = new SpendingInsightsService.Fingerprint()) {
      hash.add(
          "HouseSync:M6:budget-target-create",
          POLICY,
          month.toString(),
          bucket,
          currency.name(),
          amount);
      fingerprint = hash.finish();
    }
    List<Map<String, Object>> existing =
        jdbc.queryForList(
            "SELECT request_fingerprint,target_id FROM budget_target_idempotency_keys "
                + "WHERE actor_user_id=? AND household_id=? AND operation='BUDGET_TARGET_CREATE' AND idempotency_key=?",
            actor,
            household,
            key);
    if (!existing.isEmpty()) {
      if (!fingerprint.equals(existing.get(0).get("request_fingerprint")))
        throw new IdempotencyConflict();
      return new Creation(require(household, (UUID) existing.get(0).get("target_id")), true);
    }
    if (!jdbc.queryForList(
            "SELECT id FROM budget_targets WHERE household_id=? AND month=? "
                + "AND currency=? AND bucket=? AND status='ACTIVE'",
            household,
            month.toString(),
            currency.name(),
            bucket)
        .isEmpty()) throw new Conflict();
    UUID id = UUID.randomUUID();
    Timestamp now = Timestamp.from(Instant.now(clock));
    jdbc.update(
        "INSERT INTO budget_targets(id,household_id,month,bucket,currency,amount,status,version,created_at,updated_at) "
            + "VALUES (?,?,?,?,?,?,'ACTIVE',0,?,?)",
        id,
        household,
        month.toString(),
        bucket,
        currency.name(),
        new BigDecimal(amount),
        now,
        now);
    jdbc.update(
        "INSERT INTO budget_target_idempotency_keys(actor_user_id,household_id,operation,idempotency_key,request_fingerprint,target_id,created_at) "
            + "VALUES (?,?,'BUDGET_TARGET_CREATE',?,?,?,?)",
        actor,
        household,
        key,
        fingerprint,
        id,
        now);
    return new Creation(require(household, id), false);
  }

  @Transactional
  public BudgetTarget patch(
      UUID household, UUID actor, UUID id, int expectedVersion, String rawAmount, boolean archive) {
    households.lockForFinance(household, actor);
    owner(household, actor);
    BudgetTarget current = require(household, id);
    if (current.version() != expectedVersion) throw new VersionConflict();
    if (archive && current.status().equals("ARCHIVED")) return current;
    if (!archive && current.status().equals("ARCHIVED")) throw new Conflict();
    String amount =
        archive ? null : amount(rawAmount, SupportedCurrency.valueOf(current.money().currency()));
    if (!archive && amount.equals(current.money().amount())) return current;
    if (current.version() == Integer.MAX_VALUE) throw new VersionExhausted();
    jdbc.update(
        archive
            ? "UPDATE budget_targets SET status='ARCHIVED',version=version+1,updated_at=? WHERE household_id=? AND id=?"
            : "UPDATE budget_targets SET amount=?,version=version+1,updated_at=? WHERE household_id=? AND id=?",
        archive
            ? new Object[] {Timestamp.from(Instant.now(clock)), household, id}
            : new Object[] {
              new BigDecimal(amount), Timestamp.from(Instant.now(clock)), household, id
            });
    return require(household, id);
  }

  private static Spend zero(SupportedCurrency currency) {
    String n = RecurrencePolicy.exact(BigDecimal.ZERO, currency);
    return new Spend(n, n, n, "0", "0");
  }

  private static Spend subtract(Spend a, Spend b, SupportedCurrency currency) {
    return new Spend(
        RecurrencePolicy.exact(
            new BigDecimal(a.expenseTotal()).subtract(new BigDecimal(b.expenseTotal())), currency),
        RecurrencePolicy.exact(
            new BigDecimal(a.refundTotal()).subtract(new BigDecimal(b.refundTotal())), currency),
        RecurrencePolicy.exact(
            new BigDecimal(a.netSpending()).subtract(new BigDecimal(b.netSpending())), currency),
        Long.toString(Long.parseLong(a.expenseCount()) - Long.parseLong(b.expenseCount())),
        Long.toString(Long.parseLong(a.refundCount()) - Long.parseLong(b.refundCount())));
  }

  private static BudgetProgress progress(
      BudgetTarget target, Spend actual, SupportedCurrency currency) {
    BigDecimal t = new BigDecimal(target.money().amount()),
        s = new BigDecimal(actual.netSpending());
    BigDecimal remaining = t.subtract(s);
    BigDecimal ratio =
        t.signum() == 0 ? null : s.multiply(HUNDRED).divide(t, 2, RoundingMode.HALF_UP);
    String percent = ratio == null ? null : ratio.signum() == 0 ? "0.00" : ratio.toPlainString();
    return new BudgetProgress(
        target,
        actual,
        RecurrencePolicy.exact(remaining, currency),
        RecurrencePolicy.exact(
            remaining.signum() < 0 ? remaining.negate() : BigDecimal.ZERO, currency),
        percent,
        remaining.signum() > 0 ? "UNDER" : remaining.signum() < 0 ? "OVER" : "AT");
  }

  @Transactional
  public Progress progress(
      UUID household, UUID actor, YearMonth month, SupportedCurrency currency) {
    households.lockForFinance(household, actor);
    // One lifecycle-locked transaction includes every target and the authoritative A ledger
    // projection.
    List<BudgetTarget> targets =
        jdbc.query(
            "SELECT * FROM budget_targets WHERE household_id=? AND month=? "
                + "AND currency=? AND status='ACTIVE' ORDER BY bucket COLLATE \"C\"",
            BudgetTargetService::target,
            household,
            month.toString(),
            currency.name());
    var ledger = spending.monthlySpending(household, actor, month, currency);
    List<BudgetProgress> categories = new ArrayList<>();
    Spend untargeted = ledger.totals();
    BudgetProgress overall = null;
    for (BudgetTarget target : targets) {
      if (target.bucket().equals("OVERALL")) {
        overall = progress(target, ledger.totals(), currency);
      } else {
        Spend actual = ledger.categories().get(target.bucket());
        if (actual == null) actual = zero(currency);
        categories.add(progress(target, actual, currency));
        untargeted = subtract(untargeted, actual, currency);
      }
    }
    String snapshot;
    try (var hash = new SpendingInsightsService.Fingerprint()) {
      hash.add(
          "HouseSync:M6:budget-progress",
          POLICY,
          household.toString(),
          month.toString(),
          currency.name(),
          ledger.reportingTimeZone(),
          ledger.asOfDate().toString());
      hash.spend(ledger.totals());
      hash.outWriteCount(ledger.categories().size());
      ledger
          .categories()
          .forEach(
              (bucket, spend) -> {
                hash.add(bucket);
                hash.spend(spend);
              });
      hash.outWriteCount(targets.size());
      for (BudgetTarget target : targets)
        hash.add(
            target.id().toString(),
            target.bucket(),
            target.money().amount(),
            Integer.toString(target.version()));
      snapshot = hash.finish();
    }
    return new Progress(
        ledger.reportingTimeZone(),
        ledger.asOfDate().toString(),
        currency.name(),
        POLICY,
        snapshot,
        ledger.period(),
        ledger.totals(),
        overall,
        List.copyOf(categories),
        untargeted);
  }
}
