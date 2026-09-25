package com.housesync.finance.report.application;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.report.web.ContributionSummaryResponse;
import com.housesync.finance.report.web.ContributionSummaryResponse.Item;
import com.housesync.finance.report.web.ContributionSummaryResponse.Totals;
import com.housesync.finance.transaction.domain.AllocationRefundPolicy;
import com.housesync.finance.transaction.domain.AllocationSharesPolicy;
import com.housesync.household.application.HouseholdService;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Current-state shared-ledger projection. Every query runs after current membership is locked. */
@Service
public class ContributionSummaryService {
  private final HouseholdService households;
  private final EntityManager em;

  public ContributionSummaryService(HouseholdService households, EntityManager em) {
    this.households = households;
    this.em = em;
  }

  @Transactional
  public ContributionSummaryResponse summary(
      UUID householdId,
      UUID actorId,
      LocalDate from,
      LocalDate to,
      SupportedCurrency currency,
      int limit,
      int offset,
      String suppliedSnapshot) {
    households.lockForFinance(householdId, actorId);
    String zone = households.financeSettings(householdId).reportingTimeZone();
    Map<UUID, Amounts> byUser = new TreeMap<>(AllocationSharesPolicy.CANONICAL_USER_ORDER);
    BigDecimal expenses = BigDecimal.ZERO;
    BigDecimal refunds = BigDecimal.ZERO;
    // SQL groups only disclosed, posted ledger rows; no account, private or repayment tables.
    Query payerQuery =
        em.createNativeQuery(
            "SELECT t.owner_user_id, t.kind, SUM(t.amount) FROM financial_transactions t"
                + " WHERE t.household_id = :household AND t.currency = :currency"
                + " AND t.visibility = 'HOUSEHOLD' AND t.status = 'POSTED'"
                + " AND t.kind IN ('EXPENSE','REFUND')"
                + " AND t.occurred_on >= :fromDate AND t.occurred_on < :toDate"
                + " GROUP BY t.owner_user_id, t.kind");
    scope(payerQuery, householdId, currency);
    payerQuery.setParameter("fromDate", from);
    payerQuery.setParameter("toDate", to);
    for (Object row : payerQuery.getResultList()) {
      Object[] fields = (Object[]) row;
      Amounts amount = byUser.computeIfAbsent((UUID) fields[0], ignored -> new Amounts());
      BigDecimal value = (BigDecimal) fields[2];
      if ("EXPENSE".equals(fields[1])) {
        value = value.negate();
        amount.expense = amount.expense.add(value);
        expenses = expenses.add(value);
      } else {
        amount.refund = amount.refund.add(value);
        refunds = refunds.add(value);
      }
    }

    // One row per frozen participant, across all active allocations (including expenses outside P).
    Query allocationQuery =
        em.createNativeQuery(
            "SELECT a.id, e.id, e.occurred_on, e.amount, a.refund_policy, p.user_id, p.share"
                + " FROM financial_transaction_allocations a"
                + " JOIN financial_transactions e ON e.id = a.transaction_id"
                + " JOIN financial_transaction_allocation_participants p ON p.allocation_id = a.id"
                + " WHERE a.household_id = :household AND a.currency = :currency AND a.status = 'ACTIVE'"
                + " AND e.household_id = :household AND e.currency = :currency"
                + " AND e.kind = 'EXPENSE' AND e.visibility = 'HOUSEHOLD' AND e.status = 'POSTED'"
                + " ORDER BY a.id, p.user_id");
    scope(allocationQuery, householdId, currency);
    Map<UUID, Allocation> allocations = new HashMap<>();
    for (Object row : allocationQuery.getResultList()) {
      Object[] fields = (Object[]) row;
      UUID allocationId = (UUID) fields[0];
      Allocation allocation =
          allocations.computeIfAbsent(
              allocationId,
              ignored ->
                  new Allocation(
                      (UUID) fields[1],
                      fields[2] instanceof LocalDate date
                          ? date
                          : ((java.sql.Date) fields[2]).toLocalDate(),
                      ((BigDecimal) fields[3]).negate(),
                      AllocationRefundPolicy.valueOf((String) fields[4])));
      allocation.users.add((UUID) fields[5]);
      allocation.shares.add((BigDecimal) fields[6]);
    }
    if (!allocations.isEmpty()) {
      // Aggregate cumulative endpoints per expense, not per refund or participant. A change
      // within one boundary bucket cannot change the apportioned period delta.
      Query cumulative =
          em.createNativeQuery(
              "SELECT r.refund_of_transaction_id,"
                  + " COALESCE(SUM(r.amount) FILTER (WHERE r.occurred_on < :fromDate), 0),"
                  + " COALESCE(SUM(r.amount) FILTER (WHERE r.occurred_on < :toDate), 0)"
                  + " FROM financial_transactions r JOIN financial_transaction_allocations a"
                  + " ON a.transaction_id = r.refund_of_transaction_id"
                  + " JOIN financial_transactions e ON e.id = a.transaction_id"
                  + " WHERE a.household_id = :household AND a.currency = :currency AND a.status = 'ACTIVE'"
                  + " AND e.household_id = :household AND e.currency = :currency"
                  + " AND e.kind = 'EXPENSE' AND e.visibility = 'HOUSEHOLD' AND e.status = 'POSTED'"
                  + " AND r.household_id = :household AND r.currency = :currency"
                  + " AND r.kind = 'REFUND' AND r.status = 'POSTED' AND r.visibility = 'HOUSEHOLD'"
                  + " AND r.occurred_on < :toDate GROUP BY r.refund_of_transaction_id");
      scope(cumulative, householdId, currency);
      cumulative.setParameter("fromDate", from);
      cumulative.setParameter("toDate", to);
      Map<UUID, BigDecimal[]> endpoints = new HashMap<>();
      for (Object row : cumulative.getResultList()) {
        Object[] fields = (Object[]) row;
        endpoints.put(
            (UUID) fields[0], new BigDecimal[] {(BigDecimal) fields[1], (BigDecimal) fields[2]});
      }
      for (Allocation allocation : allocations.values()) {
        BigDecimal[] sums = endpoints.get(allocation.expenseId);
        boolean expenseInside = !allocation.date.isBefore(from) && allocation.date.isBefore(to);
        boolean refundInside = sums != null && sums[0].compareTo(sums[1]) != 0;
        if (!expenseInside && !refundInside) continue;
        List<BigDecimal> before =
            refundInside
                ? AllocationSharesPolicy.refundShares(
                    allocation.policy,
                    allocation.original,
                    allocation.shares,
                    sums[0],
                    currency,
                    allocation.users)
                : List.of();
        List<BigDecimal> after =
            refundInside
                ? AllocationSharesPolicy.refundShares(
                    allocation.policy,
                    allocation.original,
                    allocation.shares,
                    sums[1],
                    currency,
                    allocation.users)
                : List.of();
        for (int index = 0; index < allocation.users.size(); index++) {
          BigDecimal cost =
              refundInside ? before.get(index).subtract(after.get(index)) : BigDecimal.ZERO;
          if (expenseInside) cost = cost.add(allocation.shares.get(index));
          if (cost.signum() != 0) {
            Amounts amount =
                byUser.computeIfAbsent(allocation.users.get(index), ignored -> new Amounts());
            amount.cost = amount.cost.add(cost);
          }
        }
      }
    }

    Set<UUID> current = new HashSet<>();
    Query roster =
        em.createNativeQuery(
            "SELECT user_id FROM household_members WHERE household_id = :household");
    roster.setParameter("household", householdId);
    for (Object userId : roster.getResultList()) current.add((UUID) userId);
    List<Item> items = new ArrayList<>();
    BigDecimal allocated = BigDecimal.ZERO;
    for (Map.Entry<UUID, Amounts> entry : byUser.entrySet()) {
      Amounts value = entry.getValue();
      allocated = allocated.add(value.cost);
      if (value.expense.signum() == 0 && value.refund.signum() == 0 && value.cost.signum() == 0)
        continue;
      items.add(
          new Item(
              entry.getKey(),
              current.contains(entry.getKey()) ? "CURRENT" : "DEPARTED",
              exact(value.expense, currency),
              exact(value.refund, currency),
              exact(value.expense.subtract(value.refund), currency),
              exact(value.cost, currency)));
    }
    BigDecimal net = expenses.subtract(refunds);
    Totals totals =
        new Totals(
            exact(expenses, currency),
            exact(refunds, currency),
            exact(net, currency),
            exact(allocated, currency),
            exact(net.subtract(allocated), currency));
    String snapshot = fingerprint(householdId, from, to, zone, currency.name(), totals, items);
    if (suppliedSnapshot != null && !snapshot.equals(suppliedSnapshot)) {
      throw new ContributionSnapshotStaleException();
    }
    int start = Math.min(offset, items.size());
    int end = (int) Math.min((long) items.size(), (long) offset + limit);
    return new ContributionSummaryResponse(
        from.toString(),
        to.toString(),
        zone,
        currency.name(),
        snapshot,
        totals,
        List.copyOf(items.subList(start, end)),
        limit,
        offset,
        end < items.size());
  }

  private static void scope(Query query, UUID household, SupportedCurrency currency) {
    query.setParameter("household", household);
    query.setParameter("currency", currency.name());
  }

  private static String exact(BigDecimal amount, SupportedCurrency currency) {
    if (amount.signum() == 0) return BigDecimal.ZERO.setScale(currency.scale()).toPlainString();
    return amount.setScale(currency.scale(), RoundingMode.UNNECESSARY).toPlainString();
  }

  /** Versioned binary framing: UTF-8 fields preceded by four-byte lengths, in fixed order. */
  private static String fingerprint(
      UUID household,
      LocalDate from,
      LocalDate to,
      String zone,
      String currency,
      Totals totals,
      List<Item> items) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      DataOutputStream output =
          new DataOutputStream(new DigestOutputStream(OutputStream.nullOutputStream(), digest));
      for (String field :
          List.of(
              "HouseSync:contribution-summary",
              "CONTRIBUTIONS_V1",
              household.toString(),
              from.toString(),
              to.toString(),
              zone,
              currency,
              totals.expenseTotal(),
              totals.refundTotal(),
              totals.netSpending(),
              totals.allocatedCostTotal(),
              totals.unallocatedNet())) append(output, field);
      output.writeInt(items.size());
      for (Item item : items) {
        for (String field :
            List.of(
                item.userId().toString(),
                item.membershipStatus(),
                item.expensePaid(),
                item.refundReceived(),
                item.netPaid(),
                item.allocatedCost())) append(output, field);
      }
      return java.util.HexFormat.of().formatHex(digest.digest());
    } catch (IOException | NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  private static void append(DataOutputStream output, String field) throws IOException {
    byte[] value = field.getBytes(StandardCharsets.UTF_8);
    output.writeInt(value.length);
    output.write(value);
  }

  private static final class Amounts {
    BigDecimal expense = BigDecimal.ZERO;
    BigDecimal refund = BigDecimal.ZERO;
    BigDecimal cost = BigDecimal.ZERO;
  }

  private static final class Allocation {
    final UUID expenseId;
    final LocalDate date;
    final BigDecimal original;
    final AllocationRefundPolicy policy;
    final List<UUID> users = new ArrayList<>();
    final List<BigDecimal> shares = new ArrayList<>();

    Allocation(UUID expenseId, LocalDate date, BigDecimal original, AllocationRefundPolicy policy) {
      this.expenseId = expenseId;
      this.date = date;
      this.original = original;
      this.policy = policy;
    }
  }

  public static final class ContributionSnapshotStaleException extends RuntimeException {}
}
