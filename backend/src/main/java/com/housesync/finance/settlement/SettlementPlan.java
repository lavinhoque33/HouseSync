package com.housesync.finance.settlement;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.transaction.web.MemberBalancesResponse.MemberBalanceResponse;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

/** Immutable, exact-money advisory plan over the complete nonzero balance vector. */
public final class SettlementPlan {
  private static final String ALGORITHM = "CURRENT_UUID_GREEDY_V1";
  private static final String DOMAIN = "HOUSESYNC_SETTLEMENT_SNAPSHOT_V1";

  public record Money(String amount, String currency) {}

  public record Edge(String senderUserId, String recipientUserId, Money money) {}

  public record Residuals(
      String currentDebtAfterPlan,
      String currentCreditAfterPlan,
      String departedDebt,
      String departedCredit) {}

  public record Response(
      String currency, String snapshot, List<Edge> items, String nextCursor, Residuals residuals) {}

  private record Balance(String userId, BigDecimal amount) {}

  private final String snapshot;
  private final List<Edge> edges;
  private final Residuals residuals;

  private SettlementPlan(String snapshot, List<Edge> edges, Residuals residuals) {
    this.snapshot = snapshot;
    this.edges = List.copyOf(edges);
    this.residuals = residuals;
  }

  public String snapshot() {
    return snapshot;
  }

  public int edgeCount() {
    return edges.size();
  }

  public Response page(SupportedCurrency currency, int index, int limit, String nextCursor) {
    return new Response(
        currency.name(),
        snapshot,
        edges.subList(index, Math.min(edges.size(), index + limit)),
        nextCursor,
        residuals);
  }

  /** Rows must be canonical UUID ascending, as supplied by the authoritative balance renderer. */
  public static SettlementPlan calculate(
      UUID household, SupportedCurrency currency, List<MemberBalanceResponse> rows) {
    MessageDigest hash;
    try {
      hash = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
    field(hash, DOMAIN);
    field(hash, household.toString());
    field(hash, currency.name());
    field(hash, ALGORITHM);
    List<Balance> debtors = new ArrayList<>();
    List<Balance> creditors = new ArrayList<>();
    BigDecimal departedDebt = BigDecimal.ZERO;
    BigDecimal departedCredit = BigDecimal.ZERO;
    for (MemberBalanceResponse row : rows) {
      BigDecimal amount = new BigDecimal(row.amount());
      if (amount.signum() == 0) continue;
      field(hash, row.userId());
      field(hash, row.membershipStatus());
      field(hash, row.amount());
      if ("CURRENT".equals(row.membershipStatus())) {
        (amount.signum() < 0 ? debtors : creditors).add(new Balance(row.userId(), amount.abs()));
      } else if ("DEPARTED".equals(row.membershipStatus())) {
        if (amount.signum() < 0) departedDebt = departedDebt.subtract(amount);
        else departedCredit = departedCredit.add(amount);
      } else {
        throw new IllegalArgumentException("Unknown membership status");
      }
    }
    int debtor = 0;
    int creditor = 0;
    BigDecimal debtRemaining = debtors.isEmpty() ? BigDecimal.ZERO : debtors.get(0).amount();
    BigDecimal creditRemaining = creditors.isEmpty() ? BigDecimal.ZERO : creditors.get(0).amount();
    List<Edge> edges = new ArrayList<>();
    while (debtor < debtors.size() && creditor < creditors.size()) {
      BigDecimal paid = debtRemaining.min(creditRemaining);
      edges.add(
          new Edge(
              debtors.get(debtor).userId(),
              creditors.get(creditor).userId(),
              new Money(paid.setScale(currency.scale()).toPlainString(), currency.name())));
      debtRemaining = debtRemaining.subtract(paid);
      creditRemaining = creditRemaining.subtract(paid);
      if (debtRemaining.signum() == 0) {
        debtor++;
        if (debtor < debtors.size()) debtRemaining = debtors.get(debtor).amount();
      }
      if (creditRemaining.signum() == 0) {
        creditor++;
        if (creditor < creditors.size()) creditRemaining = creditors.get(creditor).amount();
      }
    }
    BigDecimal currentDebt = debtor < debtors.size() ? debtRemaining : BigDecimal.ZERO;
    for (int i = debtor + 1; i < debtors.size(); i++)
      currentDebt = currentDebt.add(debtors.get(i).amount());
    BigDecimal currentCredit = creditor < creditors.size() ? creditRemaining : BigDecimal.ZERO;
    for (int i = creditor + 1; i < creditors.size(); i++)
      currentCredit = currentCredit.add(creditors.get(i).amount());
    return new SettlementPlan(
        HexFormat.of().formatHex(hash.digest()),
        edges,
        new Residuals(
            exact(currentDebt, currency),
            exact(currentCredit, currency),
            exact(departedDebt, currency),
            exact(departedCredit, currency)));
  }

  private static String exact(BigDecimal amount, SupportedCurrency currency) {
    return amount.setScale(currency.scale()).toPlainString();
  }

  private static void field(MessageDigest hash, String text) {
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    hash.update((byte) (bytes.length >>> 24));
    hash.update((byte) (bytes.length >>> 16));
    hash.update((byte) (bytes.length >>> 8));
    hash.update((byte) bytes.length);
    hash.update(bytes);
  }
}
