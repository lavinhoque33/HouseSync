package com.housesync.finance.transaction.domain;

import com.housesync.finance.account.domain.SupportedCurrency;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
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

  /** Exact integer minor units of a magnitude at the currency's scale. */
  public static long toMinorUnits(BigDecimal magnitude, SupportedCurrency currency) {
    return magnitude.setScale(currency.scale()).unscaledValue().longValueExact();
  }

  private static BigDecimal fromMinorUnits(long minorUnits, SupportedCurrency currency) {
    return BigDecimal.valueOf(minorUnits, currency.scale());
  }
}
