package com.housesync.finance.report.application;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.categorization.domain.RuleTextNormalizer;
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
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Pure anchored calendar and exact-money rules for shared recurrence. */
public final class RecurrencePolicy {
  public static final String POLICY = "RECURRENCE_V1/PUBLIC_DESCRIPTION_V1";
  public static final LocalDate MIN = LocalDate.of(1900, 1, 1);
  public static final LocalDate MAX = LocalDate.of(9999, 12, 30);
  public static final LocalDate END = MAX.plusDays(1);

  private RecurrencePolicy() {}

  public static ValidationFailedException invalid() {
    return new ValidationFailedException(Map.of());
  }

  public static String key(UUID household, SupportedCurrency currency, String description) {
    return RuleTextNormalizer.normalize(description)
        .map(text -> SpendingInsightsService.merchantKey(household, currency, text))
        .orElseThrow(RecurrencePolicy::invalid);
  }

  public static String text(String raw, int max) {
    if (raw == null) throw invalid();
    String value = raw.trim();
    if (value.isEmpty()
        || value.codePointCount(0, value.length()) > max
        || value.codePoints().anyMatch(c -> Character.isISOControl(c))) throw invalid();
    return value;
  }

  public static LocalDate date(String value) {
    try {
      if (value == null || !value.matches("[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])"))
        throw invalid();
      LocalDate date = LocalDate.parse(value);
      if (date.isBefore(MIN) || date.isAfter(MAX)) throw invalid();
      return date;
    } catch (java.time.DateTimeException rejected) {
      throw invalid();
    }
  }

  public static String amount(String raw, SupportedCurrency currency) {
    if (raw == null) return null;
    if (!raw.matches("(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,3})?")) throw invalid();
    BigDecimal value = new BigDecimal(raw);
    if (value.signum() <= 0
        || value.scale() > currency.scale()
        || value.compareTo(new BigDecimal("1000000000000")) >= 0) throw invalid();
    return value.setScale(currency.scale(), RoundingMode.UNNECESSARY).toPlainString();
  }

  public static String exact(BigDecimal amount, SupportedCurrency currency) {
    return amount.setScale(currency.scale(), RoundingMode.UNNECESSARY).toPlainString();
  }

  public static void schedule(String cadence, LocalDate anchor, String calendarAnchor) {
    if (!List.of("WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL").contains(cadence))
      throw invalid();
    boolean calendar = !cadence.equals("WEEKLY") && !cadence.equals("BIWEEKLY");
    if (calendar
        ? !("DAY_OF_MONTH".equals(calendarAnchor) || "END_OF_MONTH".equals(calendarAnchor))
            || ("END_OF_MONTH".equals(calendarAnchor)
                && anchor.getDayOfMonth() != anchor.lengthOfMonth())
        : calendarAnchor != null) throw invalid();
  }

  public static int tolerance(String cadence) {
    return cadence.equals("WEEKLY") || cadence.equals("BIWEEKLY") ? 1 : 3;
  }

  public static LocalDate slot(LocalDate anchor, String cadence, String calendarAnchor, long n) {
    if (n < 0) return null;
    try {
      if (cadence.equals("WEEKLY") || cadence.equals("BIWEEKLY")) {
        LocalDate date = anchor.plusDays(Math.multiplyExact(n, cadence.equals("WEEKLY") ? 7 : 14));
        return date.isAfter(MAX) ? null : date;
      }
      long months =
          Math.multiplyExact(
              n, cadence.equals("MONTHLY") ? 1 : cadence.equals("QUARTERLY") ? 3 : 12);
      YearMonth target = YearMonth.from(anchor).plusMonths(months);
      LocalDate date =
          target.atDay(
              "END_OF_MONTH".equals(calendarAnchor)
                  ? target.lengthOfMonth()
                  : Math.min(anchor.getDayOfMonth(), target.lengthOfMonth()));
      return date.isAfter(MAX) ? null : date;
    } catch (ArithmeticException | java.time.DateTimeException rejected) {
      return null;
    }
  }

  public static long approximateSlot(LocalDate anchor, LocalDate today, String cadence) {
    if (today.isBefore(anchor)) return -1;
    return switch (cadence) {
      case "WEEKLY" -> ChronoUnit.DAYS.between(anchor, today) / 7;
      case "BIWEEKLY" -> ChronoUnit.DAYS.between(anchor, today) / 14;
      case "MONTHLY" -> ChronoUnit.MONTHS.between(YearMonth.from(anchor), YearMonth.from(today));
      case "QUARTERLY" ->
          ChronoUnit.MONTHS.between(YearMonth.from(anchor), YearMonth.from(today)) / 3;
      default -> ChronoUnit.MONTHS.between(YearMonth.from(anchor), YearMonth.from(today)) / 12;
    };
  }

  public static Bounds bounds(LocalDate today) {
    if (today.isBefore(MIN)) return new Bounds(MIN, MIN);
    LocalDate effective = today.isAfter(MAX) ? MAX : today;
    LocalDate from = effective.minusMonths(36);
    return new Bounds(
        from.isBefore(MIN) ? MIN : from, effective.equals(MAX) ? END : effective.plusDays(1));
  }

  public record Bounds(LocalDate from, LocalDate to) {}

  /**
   * Same tagged nullable/four-byte UTF-8 framing as A, with independently domain-separated routes.
   */
  public static final class Hash implements AutoCloseable {
    private final MessageDigest digest;
    private final DataOutputStream stream;

    public Hash(String domain, String... context) {
      try {
        digest = MessageDigest.getInstance("SHA-256");
      } catch (NoSuchAlgorithmException impossible) {
        throw new IllegalStateException(impossible);
      }
      stream =
          new DataOutputStream(new DigestOutputStream(OutputStream.nullOutputStream(), digest));
      add("HouseSync:M6:" + domain, POLICY);
      add(context);
    }

    public void add(String... fields) {
      try {
        for (String field : fields) {
          stream.writeByte(field == null ? 0 : 1);
          if (field != null) {
            byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
            stream.writeInt(bytes.length);
            stream.write(bytes);
          }
        }
      } catch (IOException impossible) {
        throw new IllegalStateException(impossible);
      }
    }

    public void count(int value) {
      try {
        stream.writeInt(value);
      } catch (IOException impossible) {
        throw new IllegalStateException(impossible);
      }
    }

    public String finish() {
      return HexFormat.of().formatHex(digest.digest());
    }

    @Override
    public void close() {
      try {
        stream.close();
      } catch (IOException impossible) {
        throw new IllegalStateException(impossible);
      }
    }
  }

  public static String cursor(
      String route,
      UUID household,
      SupportedCurrency currency,
      String filters,
      String snapshot,
      int index) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(
            ("v1|" + route + "|" + household + "|" + currency + "|" + filters + "|" + snapshot + "|"
                    + index)
                .getBytes(StandardCharsets.UTF_8));
  }

  public static int index(
      String raw,
      String route,
      UUID household,
      SupportedCurrency currency,
      String filters,
      String snapshot,
      int size) {
    if (raw == null) return 0;
    String[] fields = parseCursor(raw);
    if (!fields[1].equals(route)
        || !fields[2].equals(household.toString())
        || !fields[3].equals(currency.name())
        || !fields[4].equals(filters)) throw invalid();
    if (!fields[5].equals(snapshot))
      throw new SpendingInsightsService.InsightSnapshotStaleException();
    long index = Long.parseLong(fields[6]);
    if (index == 0 || index >= size || index > Integer.MAX_VALUE) throw invalid();
    return (int) index;
  }

  public static void validateCursor(String raw) {
    if (raw != null) parseCursor(raw);
  }

  private static String[] parseCursor(String raw) {
    try {
      if (raw.length() > 2048 || !raw.matches("[A-Za-z0-9_-]+")) throw invalid();
      byte[] decoded = Base64.getUrlDecoder().decode(raw);
      if (!Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(raw))
        throw invalid();
      String[] fields = new String(decoded, StandardCharsets.UTF_8).split("\\|", -1);
      if (fields.length != 7
          || !fields[0].equals("v1")
          || !List.of(
                  "recurring-candidates",
                  "recurring-evidence",
                  "recurring-plans",
                  "recurring-observations")
              .contains(fields[1])
          || !fields[2].matches("[0-9a-f-]{36}")
          || !fields[3].matches("[A-Z]{3}")
          || !fields[5].matches("[0-9a-f]{64}")
          || !fields[6].matches("0|[1-9][0-9]{0,15}")
          || Long.parseLong(fields[6]) > Integer.MAX_VALUE) throw invalid();
      return fields;
    } catch (IllegalArgumentException rejected) {
      throw invalid();
    }
  }
}
