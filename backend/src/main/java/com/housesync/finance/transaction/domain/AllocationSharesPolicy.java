package com.housesync.finance.transaction.domain;

import com.housesync.finance.account.domain.SupportedCurrency;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;
import java.util.UUID;

/**
 * Exact equal-division boundary for allocations (ADR 0007).
 *
 * <p>A magnitude is converted once to integer minor units at the explicit currency scale, divided
 * equally, and the remainder minor units are awarded to the earliest participants of the frozen
 * ascending canonical user-UUID order, so shares are exact and never rounded per-participant.
 * Applying the same algorithm to the cumulative refunded magnitude R over the same ordered
 * participants is monotonic in R and exactly reverses the original shares at a full refund;
 * obligations therefore never go negative without clamping.
 */
public final class AllocationSharesPolicy {

  /** Canonical user identity order: lowercase hyphenated UUID string comparison. */
  public static final Comparator<UUID> CANONICAL_USER_ORDER = Comparator.comparing(UUID::toString);

  private AllocationSharesPolicy() {}

  /**
   * Divides a positive magnitude equally across {@code participantCount} participants, in the order
   * the caller supplies (ascending canonical UUID): the first {@code remainder} participants
   * receive one extra minor unit. The returned shares are at the currency's scale and sum exactly
   * to the magnitude.
   */
  public static List<BigDecimal> equalShares(
      BigDecimal magnitude, SupportedCurrency currency, int participantCount) {
    if (participantCount < 1) {
      throw new IllegalArgumentException("At least one participant is required.");
    }
    long total = toMinorUnits(magnitude, currency);
    long base = total / participantCount;
    long remainder = total % participantCount;
    List<BigDecimal> shares = new ArrayList<>(participantCount);
    for (int index = 0; index < participantCount; index++) {
      long minor = base + (index < remainder ? 1 : 0);
      shares.add(fromMinorUnits(minor, currency));
    }
    return shares;
  }

  /**
   * Cumulative refund shares in canonical participant order. The exact policy starts from floor
   * proportional quotas, then awards the bounded remainder by exact Jefferson priorities.
   */
  public static List<BigDecimal> refundShares(
      AllocationRefundPolicy policy,
      BigDecimal original,
      List<BigDecimal> originalShares,
      BigDecimal refunded,
      SupportedCurrency currency,
      List<UUID> orderedUsers) {
    int count = originalShares.size();
    if (count == 0 || count != orderedUsers.size()) {
      throw new IllegalArgumentException("Participants must be aligned and nonempty.");
    }
    if (policy == AllocationRefundPolicy.EQUAL_V1) {
      return equalShares(refunded, currency, count);
    }
    if (policy != AllocationRefundPolicy.EXACT_JEFFERSON_V1) {
      throw new IllegalArgumentException("Unknown refund policy.");
    }
    BigInteger magnitude = original.setScale(currency.scale()).unscaledValue();
    BigInteger refund = refunded.setScale(currency.scale()).unscaledValue();
    if (magnitude.signum() <= 0 || refund.signum() < 0 || refund.compareTo(magnitude) > 0) {
      throw new IllegalArgumentException("Refund outside original magnitude.");
    }
    BigInteger[] shares = new BigInteger[count];
    BigInteger[] quotas = new BigInteger[count];
    BigInteger sum = BigInteger.ZERO;
    BigInteger assigned = BigInteger.ZERO;
    for (int i = 0; i < count; i++) {
      shares[i] = originalShares.get(i).setScale(currency.scale()).unscaledValue();
      if (shares[i].signum() < 0) throw new IllegalArgumentException("Negative original share.");
      sum = sum.add(shares[i]);
      quotas[i] = refund.multiply(shares[i]).divide(magnitude);
      assigned = assigned.add(quotas[i]);
    }
    if (!sum.equals(magnitude))
      throw new IllegalArgumentException("Original shares do not conserve.");
    PriorityQueue<Integer> heap =
        new PriorityQueue<>(
            (a, b) -> {
              int priority =
                  shares[b]
                      .multiply(quotas[a].add(BigInteger.ONE))
                      .compareTo(shares[a].multiply(quotas[b].add(BigInteger.ONE)));
              return priority != 0
                  ? priority
                  : CANONICAL_USER_ORDER.compare(orderedUsers.get(a), orderedUsers.get(b));
            });
    for (int i = 0; i < count; i++) {
      if (quotas[i].compareTo(shares[i]) < 0) heap.add(i);
    }
    int residual = refund.subtract(assigned).intValueExact();
    for (int i = 0; i < residual; i++) {
      int winner = heap.remove();
      quotas[winner] = quotas[winner].add(BigInteger.ONE);
      if (quotas[winner].compareTo(shares[winner]) < 0) heap.add(winner);
    }
    List<BigDecimal> result = new ArrayList<>(count);
    for (BigInteger quota : quotas) result.add(new BigDecimal(quota, currency.scale()));
    return result;
  }

  /** Exact integer minor units of a magnitude at the currency's scale. */
  public static long toMinorUnits(BigDecimal magnitude, SupportedCurrency currency) {
    return magnitude.setScale(currency.scale()).unscaledValue().longValueExact();
  }

  private static BigDecimal fromMinorUnits(long minorUnits, SupportedCurrency currency) {
    return BigDecimal.valueOf(minorUnits, currency.scale());
  }
}
