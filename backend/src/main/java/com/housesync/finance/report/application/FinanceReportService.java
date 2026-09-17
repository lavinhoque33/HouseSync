package com.housesync.finance.report.application;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.domain.ReportingTimeZonePolicy;
import com.housesync.finance.report.web.FinanceSettingsExceptions.FinanceSettingsForbiddenException;
import com.housesync.finance.report.web.FinanceSettingsExceptions.FinanceSettingsVersionConflictException;
import com.housesync.finance.report.web.FinanceSettingsExceptions.FinanceSettingsVersionExhaustedException;
import com.housesync.finance.report.web.FinanceSettingsResponse;
import com.housesync.finance.report.web.SpendingSummaryResponse;
import com.housesync.finance.report.web.SpendingSummaryResponse.CurrencySummaryResponse;
import com.housesync.household.application.FinanceSettingsView;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Reporting use cases (manual-finance API): household reporting-zone settings and exact
 * per-currency spending summaries.
 *
 * <p>Every operation validates transport syntax before touching authorization state, then resolves
 * current membership through the household application's public use cases. Mutations and the
 * grouped summary hold the household lifecycle lock for the whole transaction, so membership
 * removal cannot race a commit and the summary's zone plus grouped sums come from one consistent
 * authorized snapshot. Reads project only authorized fields; sums are computed with
 * arbitrary-precision decimals and formatted at the currency scale, never converted across
 * currencies.
 */
@Service
public class FinanceReportService {

  private static final String HOUSEHOLD_VISIBILITY = "HOUSEHOLD";
  private static final String POSTED_STATUS = "POSTED";

  private final HouseholdService households;
  private final EntityManager entityManager;

  public FinanceReportService(HouseholdService households, EntityManager entityManager) {
    this.households = households;
    this.entityManager = entityManager;
  }

  /** Normalized settings-patch input; presence flags distinguish explicit null from omission. */
  public record PatchFields(
      String reportingTimeZone,
      boolean reportingTimeZonePresent,
      Integer expectedVersion,
      boolean expectedVersionPresent) {}

  /**
   * Returns the household reporting settings to every current member. The read holds the household
   * lifecycle lock, so a concurrent removal either serializes before this read (generic household
   * 404) or after it (the pre-removal snapshot); a removed actor can never observe post-removal
   * settings through a stale membership check. A miss is either a foreign or missing household for
   * a current member, or a non-member/removed actor; both share the generic household 404.
   */
  @Transactional
  public FinanceSettingsResponse getSettings(UUID householdId, UUID actorId) {
    households.lockForFinance(householdId, actorId);
    FinanceSettingsView stored = households.financeSettings(householdId);
    return new FinanceSettingsResponse(stored.reportingTimeZone(), stored.version());
  }

  /**
   * Owner-only reporting-zone change under the household lifecycle lock. Syntax is validated before
   * the lock resolves any resource state; an authorized current-version no-op returns the unchanged
   * representation without a version bump.
   */
  @Transactional
  public FinanceSettingsResponse patchSettings(UUID householdId, UUID actorId, PatchFields raw) {
    PatchValues values = validatePatch(raw);
    households.lockForFinance(householdId, actorId);
    if (!"OWNER".equals(households.get(householdId, actorId).role())) {
      // Sharing membership authorizes reading only; settings mutation stays household-owner-only.
      throw new FinanceSettingsForbiddenException();
    }
    FinanceSettingsView stored = households.financeSettings(householdId);
    if (stored.version() != values.expectedVersion()) {
      throw new FinanceSettingsVersionConflictException();
    }
    if (stored.reportingTimeZone().equals(values.reportingTimeZone())) {
      return new FinanceSettingsResponse(stored.reportingTimeZone(), stored.version());
    }
    if (stored.version() == Integer.MAX_VALUE) {
      throw new FinanceSettingsVersionExhaustedException();
    }
    FinanceSettingsView updated =
        households.updateFinanceSettings(householdId, values.reportingTimeZone());
    return new FinanceSettingsResponse(updated.reportingTimeZone(), updated.version());
  }

  /**
   * Exact per-currency spending summary over the explicit half-open date interval, from one
   * coherent authorized snapshot under the household lifecycle lock. Only household-visible posted
   * entries contribute, including entries of departed owners and archived accounts; private and
   * voided entries contribute nothing and introduce no currency bucket.
   */
  @Transactional
  public SpendingSummaryResponse spendingSummary(
      UUID householdId, UUID actorId, LocalDate from, LocalDate to) {
    households.lockForFinance(householdId, actorId);
    FinanceSettingsView settings = households.financeSettings(householdId);
    Map<String, EnumMap<TransactionContribution, BigDecimal>> grouped =
        summarizePostedHousehold(householdId, actorId, from, to);
    List<CurrencySummaryResponse> currencies = new ArrayList<>();
    for (Map.Entry<String, EnumMap<TransactionContribution, BigDecimal>> entry :
        grouped.entrySet()) {
      SupportedCurrency currency = SupportedCurrency.valueOf(entry.getKey());
      BigDecimal expense =
          entry.getValue().getOrDefault(TransactionContribution.EXPENSE, BigDecimal.ZERO).abs();
      BigDecimal refund =
          entry.getValue().getOrDefault(TransactionContribution.REFUND, BigDecimal.ZERO);
      BigDecimal income =
          entry.getValue().getOrDefault(TransactionContribution.INCOME, BigDecimal.ZERO);
      BigDecimal net = expense.subtract(refund);
      currencies.add(
          new CurrencySummaryResponse(
              currency.name(),
              exact(expense, currency),
              exact(refund, currency),
              exact(net, currency),
              exact(income, currency)));
    }
    return new SpendingSummaryResponse(
        from.toString(), to.toString(), settings.reportingTimeZone(), List.copyOf(currencies));
  }

  /** Contribution kinds for the grouped summary; transfers introduce a bucket but sum to zero. */
  private enum TransactionContribution {
    EXPENSE,
    REFUND,
    INCOME,
    TRANSFER
  }

  /**
   * Authorized grouped sums in SQL: the actor membership join is the authorization, every filter
   * applies in the database, and owner departure or account archival never hides shared history
   * because neither membership rows of other users nor account rows are joined. One row per
   * (currency, kind); transfers are retained so their currency introduces a zero bucket.
   */
  private Map<String, EnumMap<TransactionContribution, BigDecimal>> summarizePostedHousehold(
      UUID householdId, UUID actorId, LocalDate from, LocalDate to) {
    Query query =
        entityManager.createNativeQuery(
            "SELECT t.currency, t.kind, SUM(t.amount) FROM financial_transactions t"
                + " JOIN household_members m ON m.household_id = t.household_id"
                + " AND m.user_id = :actorId"
                + " WHERE t.household_id = :householdId AND t.visibility = :visibility"
                + " AND t.status = :status"
                + " AND t.occurred_on >= :fromDate AND t.occurred_on < :toDate"
                + " GROUP BY t.currency, t.kind");
    query.setParameter("householdId", householdId);
    query.setParameter("actorId", actorId);
    query.setParameter("visibility", HOUSEHOLD_VISIBILITY);
    query.setParameter("status", POSTED_STATUS);
    query.setParameter("fromDate", from);
    query.setParameter("toDate", to);
    Map<String, EnumMap<TransactionContribution, BigDecimal>> grouped = new TreeMap<>();
    for (Object row : query.getResultList()) {
      Object[] columns = (Object[]) row;
      String currency = (String) columns[0];
      TransactionContribution kind = TransactionContribution.valueOf((String) columns[1]);
      BigDecimal sum = (BigDecimal) columns[2];
      grouped
          .computeIfAbsent(currency, ignored -> new EnumMap<>(TransactionContribution.class))
          .merge(kind, sum, BigDecimal::add);
    }
    return grouped;
  }

  /** Exact response string at the currency scale; sums only carry trailing zeros by scale. */
  private static String exact(BigDecimal amount, SupportedCurrency currency) {
    BigDecimal normalized = amount.setScale(currency.scale(), RoundingMode.UNNECESSARY);
    if (normalized.signum() == 0) {
      // Exact zero aggregates are never negative zero.
      normalized = BigDecimal.ZERO.setScale(currency.scale());
    }
    return normalized.toPlainString();
  }

  private static PatchValues validatePatch(PatchFields raw) {
    Map<String, String> errors = new LinkedHashMap<>();
    if (!raw.expectedVersionPresent()
        || raw.expectedVersion() == null
        || raw.expectedVersion() < 0) {
      errors.put("expectedVersion", "Provide the current settings version.");
    }
    String zoneViolation = null;
    if (!raw.reportingTimeZonePresent()) {
      zoneViolation = "Choose a supported reporting time zone.";
    } else {
      zoneViolation = ReportingTimeZonePolicy.violation(raw.reportingTimeZone());
    }
    if (zoneViolation != null) {
      errors.put("reportingTimeZone", zoneViolation);
    }
    if (!errors.isEmpty()) {
      throw new ValidationFailedException(errors);
    }
    return new PatchValues(raw.reportingTimeZone(), raw.expectedVersion());
  }

  private record PatchValues(String reportingTimeZone, int expectedVersion) {}
}
