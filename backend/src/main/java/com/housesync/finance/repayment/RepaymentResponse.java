package com.housesync.finance.repayment;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.repayment.RepaymentRepository.Fact;
import com.housesync.finance.repayment.RepaymentRepository.RepaymentEvent;
import com.housesync.finance.transaction.domain.TransactionMoneyPolicy;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;

public record RepaymentResponse(
    UUID id,
    UUID householdId,
    UUID senderUserId,
    UUID recipientUserId,
    Money money,
    LocalDate occurredOn,
    String status,
    int version,
    Instant createdAt,
    Instant updatedAt,
    Instant confirmedAt,
    Instant voidedAt,
    Amendment pendingAmendment,
    List<String> allowedActions) {
  public record Money(String amount, String currency) {
    public static Money of(BigDecimal amount, SupportedCurrency currency) {
      return new Money(TransactionMoneyPolicy.toResponseString(amount, currency), currency.name());
    }
  }

  public record Amendment(
      String action, UUID proposedByUserId, Money money, LocalDate occurredOn, Instant createdAt) {}

  public record Event(
      int version,
      String eventType,
      UUID actorUserId,
      Instant recordedAt,
      String status,
      Money money,
      LocalDate occurredOn,
      Amendment pendingAmendment) {
    public static Event of(RepaymentEvent e) {
      return new Event(
          e.version(),
          e.eventType(),
          e.actorUserId(),
          e.recordedAt(),
          e.status(),
          Money.of(e.amount(), e.currency()),
          e.occurredOn(),
          amendment(
              e.amendmentAction(),
              e.amendmentProposer(),
              e.amendmentAmount(),
              e.amendmentOccurredOn(),
              e.amendmentCreatedAt(),
              e.currency()));
    }
  }

  private static Amendment amendment(
      String action,
      UUID proposer,
      BigDecimal amount,
      LocalDate date,
      Instant created,
      SupportedCurrency currency) {
    return action == null
        ? null
        : new Amendment(
            action, proposer, amount == null ? null : Money.of(amount, currency), date, created);
  }

  public static RepaymentResponse of(Fact f, UUID actor, Set<UUID> current) {
    return new RepaymentResponse(
        f.id(),
        f.householdId(),
        f.senderUserId(),
        f.recipientUserId(),
        Money.of(f.amount(), f.currency()),
        f.occurredOn(),
        f.status(),
        f.version(),
        f.createdAt(),
        f.updatedAt(),
        f.confirmedAt(),
        f.voidedAt(),
        amendment(
            f.amendmentAction(),
            f.amendmentProposer(),
            f.amendmentAmount(),
            f.amendmentOccurredOn(),
            f.amendmentCreatedAt(),
            f.currency()),
        RepaymentPolicy.actions(f, actor, current));
  }
}
