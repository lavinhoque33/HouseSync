package com.housesync.finance.settlement;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.repayment.RepaymentRepository;
import com.housesync.finance.transaction.application.FinancialAllocationService;
import com.housesync.finance.transaction.domain.AllocationSharesPolicy;
import com.housesync.finance.transaction.web.MemberBalancesResponse;
import com.housesync.finance.transaction.web.MemberBalancesResponse.CurrencyBalancesResponse;
import com.housesync.finance.transaction.web.MemberBalancesResponse.MemberBalanceResponse;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** The sole household-locked source of allocation plus accepted-payment net obligations. */
@Service
public class SettlementService {
  private static final Pattern CURSOR = Pattern.compile("[A-Za-z0-9_-]{1,1024}");
  private static final Pattern CURSOR_TEXT =
      Pattern.compile("1:[0-9a-f]{64}:(BRL|USD|EUR|GBP|CAD|JPY|KWD):(0|[1-9][0-9]*)");
  private final FinancialAllocationService allocations;
  private final RepaymentRepository repayments;
  private final HouseholdService households;

  public SettlementService(
      FinancialAllocationService allocations,
      RepaymentRepository repayments,
      HouseholdService households) {
    this.allocations = allocations;
    this.repayments = repayments;
    this.households = households;
  }

  @Transactional
  public MemberBalancesResponse memberBalances(UUID householdId, UUID actorId) {
    households.lockForFinance(householdId, actorId);
    return combinedLocked(householdId);
  }

  @Transactional
  public SettlementPlan.Response suggestions(
      UUID householdId, UUID actorId, SupportedCurrency currency, int limit, String cursor) {
    households.lockForFinance(householdId, actorId);
    MemberBalancesResponse combined = combinedLocked(householdId);
    List<MemberBalanceResponse> rows =
        combined.currencies().stream()
            .filter(bucket -> bucket.currency().equals(currency.name()))
            .findFirst()
            .map(CurrencyBalancesResponse::balances)
            .orElse(List.of());
    SettlementPlan plan = SettlementPlan.calculate(householdId, currency, rows);
    int index = 0;
    if (cursor != null) {
      String[] parts = decode(cursor, currency);
      if (!parts[1].equals(plan.snapshot())) throw new SnapshotStale();
      try {
        index = Integer.parseInt(parts[3]);
      } catch (NumberFormatException invalid) {
        throw invalidCursor();
      }
      if (index >= plan.edgeCount()) throw invalidCursor();
    }
    int end = Math.min(plan.edgeCount(), index + limit);
    String next = end == plan.edgeCount() ? null : encode(plan.snapshot(), currency, end);
    return plan.page(currency, index, limit, next);
  }

  private MemberBalancesResponse combinedLocked(UUID householdId) {
    Map<String, Map<UUID, BigDecimal>> ledger =
        allocations.allocationBalanceDeltasLocked(householdId);
    for (RepaymentRepository.Confirmed payment : repayments.confirmedForHousehold(householdId)) {
      String currency = payment.currency().name();
      add(ledger, currency, payment.senderUserId(), payment.amount());
      add(ledger, currency, payment.recipientUserId(), payment.amount().negate());
    }
    Set<UUID> current = households.currentMemberUserIds(householdId);
    List<CurrencyBalancesResponse> currencies = new ArrayList<>();
    // The allocation service returns a sorted TreeMap, including repayment-only buckets.
    for (var bucket : ledger.entrySet()) {
      SupportedCurrency currency = SupportedCurrency.valueOf(bucket.getKey());
      List<MemberBalanceResponse> balances = new ArrayList<>();
      bucket.getValue().entrySet().stream()
          .sorted(Map.Entry.comparingByKey(AllocationSharesPolicy.CANONICAL_USER_ORDER))
          .forEach(
              row -> {
                if (row.getValue().signum() != 0) {
                  balances.add(
                      new MemberBalanceResponse(
                          row.getKey().toString(),
                          current.contains(row.getKey()) ? "CURRENT" : "DEPARTED",
                          row.getValue().setScale(currency.scale()).toPlainString()));
                }
              });
      if (!balances.isEmpty())
        currencies.add(new CurrencyBalancesResponse(bucket.getKey(), balances));
    }
    return new MemberBalancesResponse(List.copyOf(currencies));
  }

  private static void add(
      Map<String, Map<UUID, BigDecimal>> ledger, String currency, UUID user, BigDecimal amount) {
    ledger
        .computeIfAbsent(currency, ignored -> new LinkedHashMap<>())
        .merge(user, amount, BigDecimal::add);
  }

  private static String encode(String snapshot, SupportedCurrency currency, int index) {
    String value = "1:" + snapshot + ":" + currency.name() + ":" + index;
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(value.getBytes(StandardCharsets.US_ASCII));
  }

  private static String[] decode(String encoded, SupportedCurrency currency) {
    if (!CURSOR.matcher(encoded).matches()) throw invalidCursor();
    try {
      byte[] bytes = Base64.getUrlDecoder().decode(encoded);
      String text = new String(bytes, StandardCharsets.US_ASCII);
      if (!Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(encoded)
          || !CURSOR_TEXT.matcher(text).matches()) throw invalidCursor();
      String[] parts = text.split(":", -1);
      if (!parts[2].equals(currency.name())) throw invalidCursor();
      return parts;
    } catch (IllegalArgumentException invalid) {
      throw invalidCursor();
    }
  }

  private static ValidationFailedException invalidCursor() {
    return new ValidationFailedException(Map.of("cursor", "Provide a valid settlement cursor."));
  }

  public static final class SnapshotStale extends RuntimeException {}
}
