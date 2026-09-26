package com.housesync.finance.report.application;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.categorization.domain.RuleTextNormalizer;
import com.housesync.finance.report.web.SpendingInsightsResponse.*;
import com.housesync.finance.transaction.domain.TransactionCategory;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** A single household-locked, SQL-scoped read of current disclosed rows per insights request. */
@Service
public class SpendingInsightsService {
  public static final String POLICY = "SPENDING_V1/PUBLIC_DESCRIPTION_V1";
  private final HouseholdService households;
  private final JdbcTemplate jdbc;
  private final Clock clock;

  public SpendingInsightsService(HouseholdService households, JdbcTemplate jdbc, Clock clock) {
    this.households = households;
    this.jdbc = jdbc;
    this.clock = clock;
  }

  public static final class InsightSnapshotStaleException extends RuntimeException {}

  public static String merchantKey(UUID household, SupportedCurrency currency, String normalized) {
    try (Fingerprint hash = new Fingerprint()) {
      hash.add(
          "HouseSync:M6:merchant",
          "PUBLIC_DESCRIPTION_V1",
          household.toString(),
          currency.name(),
          normalized);
      return hash.finish();
    }
  }

  private static String categoryLabel(String key) {
    return "UNCATEGORIZED".equals(key) ? "Uncategorized" : TransactionCategory.valueOf(key).label();
  }

  public static void validateKey(String dimension, String key) {
    if (key == null) throw invalid();
    if ("CATEGORY".equals(dimension)) {
      if (!"UNCATEGORIZED".equals(key)) {
        try {
          TransactionCategory.valueOf(key);
        } catch (IllegalArgumentException rejected) {
          throw invalid();
        }
      }
    } else if (!"MERCHANT".equals(dimension)
        || !(key.equals("UNGROUPED") || key.matches("[0-9a-f]{64}"))) throw invalid();
  }

  public static YearMonth parseMonth(String raw, boolean exclusive) {
    if (raw == null || !raw.matches("[0-9]{4}-(0[1-9]|1[0-2])")) throw invalid();
    YearMonth value = YearMonth.parse(raw);
    if (value.isBefore(YearMonth.of(1900, 1))
        || value.isAfter(YearMonth.of(9999, exclusive ? 12 : 11))) throw invalid();
    return value;
  }

  private static ValidationFailedException invalid() {
    return new ValidationFailedException(Map.of());
  }

  private Context context(UUID household, UUID actor, SupportedCurrency currency) {
    households.lockForFinance(household, actor);
    String zone = households.financeSettings(household).reportingTimeZone();
    return new Context(
        household, currency, zone, LocalDate.now(clock.withZone(ZoneId.of(zone))), actor);
  }

  @Transactional
  public Series series(
      UUID household,
      UUID actor,
      YearMonth from,
      YearMonth to,
      SupportedCurrency currency,
      String dimension,
      String key) {
    Context ctx = context(household, actor, currency);
    List<SeriesItem> items = new ArrayList<>();
    Map<YearMonth, Amounts> months = new TreeMap<>();
    for (YearMonth month = from; month.isBefore(to); month = month.plusMonths(1))
      months.put(month, new Amounts());
    try (Fingerprint hash =
        fingerprint("spending-series", ctx, from.toString(), to.toString(), dimension, key)) {
      read(
          ctx,
          from.atDay(1),
          to.atDay(1),
          row -> {
            String group = group(ctx, dimension, row);
            if (dimension == null || key.equals(group))
              months.get(YearMonth.from(row.date)).add(row);
            if (dimension == null || key.equals(group)) hash.row(row, group);
          });
      for (var entry : months.entrySet()) {
        SeriesItem item =
            new SeriesItem(period(entry.getKey(), ctx.today), entry.getValue().totals(currency));
        items.add(item);
        hash.totals(item.totals());
      }
      hash.outWriteCount(items.size());
      return new Series(
          ctx.zone,
          ctx.today.toString(),
          currency.name(),
          POLICY,
          hash.finish(),
          from.toString(),
          to.toString(),
          dimension,
          key,
          List.copyOf(items));
    }
  }

  @Transactional
  public Comparison comparison(
      UUID household,
      UUID actor,
      YearMonth month,
      YearMonth baseline,
      SupportedCurrency currency,
      String dimension,
      int limit,
      String cursor) {
    Context ctx = context(household, actor, currency);
    YearMonth first = month.isBefore(baseline) ? month : baseline;
    YearMonth last = month.isAfter(baseline) ? month : baseline;
    Amounts current = new Amounts(), previous = new Amounts();
    Map<String, Pair> grouped = new HashMap<>();
    try (Fingerprint hash =
        fingerprint("spending-comparison", ctx, month.toString(), baseline.toString(), dimension)) {
      read(
          ctx,
          first.atDay(1),
          last.plusMonths(1).atDay(1),
          row -> {
            boolean isCurrent = YearMonth.from(row.date).equals(month);
            boolean isBaseline = YearMonth.from(row.date).equals(baseline);
            if (!isCurrent && !isBaseline) return;
            Amounts sum = isCurrent ? current : previous;
            sum.add(row);
            String group = group(ctx, dimension, row);
            if (group != null) {
              Pair pair = grouped.computeIfAbsent(group, ignored -> new Pair());
              if (pair.label == null && "MERCHANT".equals(dimension)) {
                pair.label =
                    RuleTextNormalizer.normalize(row.groupDescription)
                        .orElse("Ungrouped descriptions");
              }
              (isCurrent ? pair.current : pair.baseline).add(row);
            }
            hash.row(row, group);
          });
      Totals currentTotals = current.totals(currency), baselineTotals = previous.totals(currency);
      hash.totals(currentTotals);
      hash.totals(baselineTotals);
      List<GroupComparison> all = new ArrayList<>();
      for (var entry : grouped.entrySet()) {
        Pair pair = entry.getValue();
        all.add(
            new GroupComparison(
                entry.getKey(),
                "MERCHANT".equals(dimension) ? pair.label : categoryLabel(entry.getKey()),
                pair.current.spend(currency),
                pair.baseline.spend(currency),
                change(pair.current.net(), pair.baseline.net(), currency)));
      }
      all.sort(
          Comparator.comparing((GroupComparison g) -> new BigDecimal(g.change().delta()).abs())
              .reversed()
              .thenComparing(GroupComparison::key));
      hash.outWriteCount(all.size());
      for (GroupComparison group : all) {
        hash.add(group.key(), group.label());
        hash.spend(group.current());
        hash.spend(group.baseline());
        hash.change(group.change());
      }
      String snapshot = hash.finish();
      int start =
          cursorIndex(
              cursor,
              "spending-comparison",
              ctx,
              month + ":" + baseline + ":" + dimension,
              snapshot,
              all.size());
      int end = Math.min(all.size(), start + limit);
      return new Comparison(
          ctx.zone,
          ctx.today.toString(),
          currency.name(),
          POLICY,
          snapshot,
          period(month, ctx.today),
          period(baseline, ctx.today),
          dimension,
          currentTotals,
          baselineTotals,
          change(current.net(), previous.net(), currency),
          List.copyOf(all.subList(start, end)),
          end == all.size()
              ? null
              : cursor(
                  "spending-comparison",
                  ctx,
                  month + ":" + baseline + ":" + dimension,
                  snapshot,
                  end));
    }
  }

  @Transactional
  public Evidence evidence(
      UUID household,
      UUID actor,
      YearMonth month,
      SupportedCurrency currency,
      String dimension,
      String key,
      int limit,
      String cursor) {
    Context ctx = context(household, actor, currency);
    Amounts amounts = new Amounts();
    List<Row> matches = new ArrayList<>();
    try (Fingerprint hash =
        fingerprint("spending-evidence", ctx, month.toString(), dimension, key)) {
      read(
          ctx,
          month.atDay(1),
          month.plusMonths(1).atDay(1),
          row -> {
            if (key.equals(group(ctx, dimension, row))) {
              amounts.add(row);
              matches.add(row);
              hash.row(row, key);
            }
          });
      matches.sort(
          Comparator.comparing((Row r) -> r.date)
              .reversed()
              .thenComparing((Row r) -> r.created, Comparator.reverseOrder())
              .thenComparing((Row r) -> r.id, Comparator.reverseOrder()));
      Spend totals = amounts.spend(currency);
      hash.spend(totals);
      hash.outWriteCount(matches.size());
      for (Row row : matches) hash.add(row.id.toString(), Integer.toString(row.version));
      String snapshot = hash.finish();
      String filters = month + ":" + dimension + ":" + key;
      int start = cursorIndex(cursor, "spending-evidence", ctx, filters, snapshot, matches.size());
      int end = Math.min(matches.size(), start + limit);
      List<EvidenceItem> items = new ArrayList<>();
      for (Row row : matches.subList(start, end)) {
        items.add(
            new EvidenceItem(
                row.id,
                row.version,
                row.kind,
                row.date.toString(),
                new Money(exact(row.amount, currency), currency.name()),
                row.description,
                row.category,
                row.sourceId));
      }
      return new Evidence(
          ctx.zone,
          ctx.today.toString(),
          currency.name(),
          POLICY,
          snapshot,
          period(month, ctx.today),
          dimension,
          key,
          totals,
          List.copyOf(items),
          end == matches.size() ? null : cursor("spending-evidence", ctx, filters, snapshot, end));
    }
  }

  private static String group(Context ctx, String dimension, Row row) {
    if (dimension == null || "INCOME".equals(row.kind)) return null;
    if ("CATEGORY".equals(dimension)) return row.category == null ? "UNCATEGORIZED" : row.category;
    return RuleTextNormalizer.normalize(row.groupDescription)
        .map(normalized -> merchantKey(ctx.household, ctx.currency, normalized))
        .orElse("UNGROUPED");
  }

  private void read(
      Context ctx, LocalDate from, LocalDate to, java.util.function.Consumer<Row> consumer) {
    jdbc.query(
        "SELECT t.id,t.version,t.kind,t.occurred_on,t.amount,t.description,t.category,"
            + "t.refund_of_transaction_id,t.created_at,"
            + "CASE WHEN t.kind='REFUND' THEN s.description ELSE t.description END AS group_description,"
            + "CASE WHEN t.kind='REFUND' THEN s.category ELSE t.category END AS group_category,"
            + "s.version AS source_version FROM financial_transactions t "
            + "LEFT JOIN financial_transactions s ON s.id=t.refund_of_transaction_id"
            + " AND s.household_id=t.household_id AND s.currency=t.currency"
            + " AND s.kind='EXPENSE' AND s.visibility='HOUSEHOLD' AND s.status='POSTED'"
            + " WHERE t.household_id=? AND t.currency=? AND t.visibility='HOUSEHOLD'"
            + " AND t.status='POSTED' AND t.kind IN ('EXPENSE','REFUND','INCOME')"
            + " AND (t.kind<>'REFUND' OR s.id IS NOT NULL)"
            + " AND t.occurred_on>=? AND t.occurred_on<?"
            + " AND EXISTS (SELECT 1 FROM household_members m WHERE m.household_id=t.household_id AND m.user_id=?)"
            + " ORDER BY t.occurred_on,t.id",
        ps -> {
          ps.setObject(1, ctx.household);
          ps.setString(2, ctx.currency.name());
          ps.setObject(3, from);
          ps.setObject(4, to);
          ps.setObject(5, ctx.actor);
          ps.setFetchSize(256);
        },
        (org.springframework.jdbc.core.RowCallbackHandler) rs -> consumer.accept(map(rs)));
  }

  private static Row map(ResultSet rs) throws SQLException {
    return new Row(
        (UUID) rs.getObject(1),
        rs.getInt(2),
        rs.getString(3),
        rs.getObject(4, LocalDate.class),
        rs.getBigDecimal(5),
        rs.getString(6),
        rs.getString(3).equals("REFUND") ? rs.getString(11) : rs.getString(7),
        (UUID) rs.getObject(8),
        rs.getTimestamp(9).toInstant(),
        rs.getString(10),
        rs.getObject(12));
  }

  private record Context(
      UUID household, SupportedCurrency currency, String zone, LocalDate today, UUID actor) {}

  private record Row(
      UUID id,
      int version,
      String kind,
      LocalDate date,
      BigDecimal amount,
      String description,
      String category,
      UUID sourceId,
      java.time.Instant created,
      String groupDescription,
      Object sourceVersion) {}

  private static final class Pair {
    final Amounts current = new Amounts(), baseline = new Amounts();
    String label;
  }

  private static final class Amounts {
    BigDecimal expense = BigDecimal.ZERO, refund = BigDecimal.ZERO, income = BigDecimal.ZERO;
    long expenseCount, refundCount;

    void add(Row row) {
      switch (row.kind) {
        case "EXPENSE" -> {
          expense = expense.subtract(row.amount);
          expenseCount++;
        }
        case "REFUND" -> {
          refund = refund.add(row.amount);
          refundCount++;
        }
        case "INCOME" -> income = income.add(row.amount);
        default -> throw new IllegalStateException();
      }
    }

    BigDecimal net() {
      return expense.subtract(refund);
    }

    Spend spend(SupportedCurrency currency) {
      return new Spend(
          exact(expense, currency),
          exact(refund, currency),
          exact(net(), currency),
          Long.toString(expenseCount),
          Long.toString(refundCount));
    }

    Totals totals(SupportedCurrency currency) {
      Spend s = spend(currency);
      return new Totals(
          s.expenseTotal(),
          s.refundTotal(),
          s.netSpending(),
          s.expenseCount(),
          s.refundCount(),
          exact(income, currency));
    }
  }

  private static String exact(BigDecimal amount, SupportedCurrency currency) {
    return amount.signum() == 0
        ? BigDecimal.ZERO.setScale(currency.scale()).toPlainString()
        : amount.setScale(currency.scale(), RoundingMode.UNNECESSARY).toPlainString();
  }

  private static Change change(
      BigDecimal current, BigDecimal baseline, SupportedCurrency currency) {
    BigDecimal delta = current.subtract(baseline);
    String direction =
        delta.signum() > 0 ? "INCREASE" : delta.signum() < 0 ? "DECREASE" : "UNCHANGED";
    BigDecimal percentage =
        baseline.signum() > 0
            ? delta.multiply(BigDecimal.valueOf(100)).divide(baseline, 2, RoundingMode.HALF_UP)
            : null;
    return new Change(
        exact(delta, currency),
        direction,
        percentage == null ? null : percentage.signum() == 0 ? "0.00" : percentage.toPlainString(),
        baseline.signum() > 0
            ? null
            : baseline.signum() == 0 ? "BASELINE_ZERO" : "BASELINE_NEGATIVE");
  }

  private static Period period(YearMonth month, LocalDate today) {
    LocalDate from = month.atDay(1), to = month.plusMonths(1).atDay(1);
    return new Period(
        month.toString(),
        from.toString(),
        to.toString(),
        today.isBefore(from) ? "FUTURE" : today.isBefore(to) ? "IN_PROGRESS" : "COMPLETED");
  }

  private static Fingerprint fingerprint(String route, Context ctx, String... filters) {
    Fingerprint fp = new Fingerprint();
    fp.add(
        "HouseSync:M6:" + route,
        POLICY,
        ctx.household.toString(),
        ctx.currency.name(),
        ctx.zone,
        ctx.today.toString());
    fp.outWriteCount(filters.length);
    for (String filter : filters) fp.add(filter);
    return fp;
  }

  private static String cursor(
      String route, Context ctx, String filters, String snapshot, int index) {
    String value =
        "v1|"
            + route
            + "|"
            + ctx.household
            + "|"
            + ctx.currency
            + "|"
            + filters
            + "|"
            + snapshot
            + "|"
            + index;
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  /**
   * Decode only token syntax at the HTTP boundary; binding/freshness follows locked authorization.
   */
  public static void validateCursorSyntax(String raw) {
    if (raw == null) return;
    try {
      if (raw.length() > 2048 || !raw.matches("[A-Za-z0-9_-]+")) throw invalid();
      byte[] bytes = Base64.getUrlDecoder().decode(raw);
      if (!Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(raw))
        throw invalid();
      String[] fields = new String(bytes, StandardCharsets.UTF_8).split("\\|", -1);
      if (fields.length != 7
          || !fields[0].equals("v1")
          || !(fields[1].equals("spending-comparison") || fields[1].equals("spending-evidence"))
          || !fields[2].matches("[0-9a-f-]{36}")
          || !fields[3].matches("[A-Z]{3}")
          || !fields[5].matches("[0-9a-f]{64}")
          || !fields[6].matches("0|[1-9][0-9]{0,15}")
          || Long.parseLong(fields[6]) > Integer.MAX_VALUE) throw invalid();
    } catch (IllegalArgumentException rejected) {
      throw invalid();
    }
  }

  private static int cursorIndex(
      String raw, String route, Context ctx, String filters, String snapshot, int size) {
    if (raw == null) return 0;
    try {
      if (raw.length() > 2048 || !raw.matches("[A-Za-z0-9_-]+")) throw invalid();
      byte[] bytes = Base64.getUrlDecoder().decode(raw);
      if (!Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(raw))
        throw invalid();
      String[] fields = new String(bytes, StandardCharsets.UTF_8).split("\\|", -1);
      if (fields.length != 7
          || !fields[0].equals("v1")
          || !fields[1].equals(route)
          || !fields[2].equals(ctx.household.toString())
          || !fields[3].equals(ctx.currency.name())
          || !fields[4].equals(filters)
          || !fields[5].matches("[0-9a-f]{64}")
          || !fields[6].matches("0|[1-9][0-9]{0,15}")) throw invalid();
      long index = Long.parseLong(fields[6]);
      if (index < 0 || index > Integer.MAX_VALUE) throw invalid();
      if (!fields[5].equals(snapshot)) throw new InsightSnapshotStaleException();
      if (index >= size || index == 0) throw invalid();
      return (int) index;
    } catch (IllegalArgumentException rejected) {
      throw invalid();
    }
  }

  private static final class Fingerprint implements AutoCloseable {
    final MessageDigest digest;
    final DataOutputStream out;

    Fingerprint() {
      try {
        digest = MessageDigest.getInstance("SHA-256");
      } catch (NoSuchAlgorithmException impossible) {
        throw new IllegalStateException(impossible);
      }
      out = new DataOutputStream(new DigestOutputStream(OutputStream.nullOutputStream(), digest));
    }

    void outWriteCount(int n) {
      try {
        out.writeInt(n);
      } catch (IOException impossible) {
        throw new IllegalStateException(impossible);
      }
    }

    void add(String... fields) {
      try {
        for (String field : fields) {
          if (field == null) {
            out.writeByte(0);
            continue;
          }
          out.writeByte(1);
          byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
          out.writeInt(bytes.length);
          out.write(bytes);
        }
      } catch (IOException impossible) {
        throw new IllegalStateException(impossible);
      }
    }

    void spend(Spend s) {
      add(s.expenseTotal(), s.refundTotal(), s.netSpending(), s.expenseCount(), s.refundCount());
    }

    void totals(Totals t) {
      add(
          t.expenseTotal(),
          t.refundTotal(),
          t.netSpending(),
          t.expenseCount(),
          t.refundCount(),
          t.incomeTotal());
    }

    void change(Change c) {
      add(c.delta(), c.direction(), c.percentChange(), c.percentUnavailableReason());
    }

    void row(Row r, String group) {
      add(
          r.id.toString(),
          Integer.toString(r.version),
          r.kind,
          r.date.toString(),
          r.amount.toPlainString(),
          r.description,
          r.category,
          r.sourceId == null ? null : r.sourceId.toString(),
          r.created.toString(),
          r.groupDescription,
          r.sourceVersion == null ? null : r.sourceVersion.toString(),
          group);
    }

    String finish() {
      return HexFormat.of().formatHex(digest.digest());
    }

    @Override
    public void close() {
      try {
        out.close();
      } catch (IOException impossible) {
        throw new IllegalStateException(impossible);
      }
    }
  }
}
