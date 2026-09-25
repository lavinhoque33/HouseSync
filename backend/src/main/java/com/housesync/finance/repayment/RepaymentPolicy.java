package com.housesync.finance.repayment;

import com.housesync.finance.repayment.RepaymentRepository.Fact;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Pure two-party consent rules. A proposed amendment never replaces the effective accepted fact.
 */
public final class RepaymentPolicy {
  private RepaymentPolicy() {}

  public static final class Conflict extends RuntimeException {}

  public record Transition(Fact fact, String eventType) {}

  public static List<String> actions(Fact f, UUID actor, Set<UUID> current) {
    List<String> actions = new ArrayList<>();
    if (!f.party(actor) || !current.contains(actor)) return actions;
    boolean counterpartCurrent =
        current.contains(f.senderUserId()) && current.contains(f.recipientUserId());
    if (f.status().equals("PENDING")) {
      if (actor.equals(f.recipientUserId())) {
        if (counterpartCurrent) actions.add("CONFIRM");
        actions.add("REJECT");
      } else actions.add("CANCEL");
    } else if (f.status().equals("CONFIRMED")) {
      if (f.amendmentAction() == null) {
        if (counterpartCurrent) {
          actions.add("PROPOSE_REPLACEMENT");
          actions.add("PROPOSE_VOID");
        }
      } else if (actor.equals(f.amendmentProposer())) actions.add("CANCEL_AMENDMENT");
      else {
        if (counterpartCurrent) actions.add("CONFIRM_AMENDMENT");
        actions.add("REJECT_AMENDMENT");
      }
    }
    return actions;
  }

  public static Transition change(
      Fact f,
      UUID actor,
      Set<UUID> current,
      int expectedVersion,
      String operation,
      String decision,
      BigDecimal replacementAmount,
      LocalDate replacementDate,
      Instant now) {
    if (!f.party(actor) || !current.contains(actor)) throw new Conflict();
    if (expectedVersion != f.version() || f.version() == Integer.MAX_VALUE) throw new Conflict();
    List<String> allowed = actions(f, actor, current);
    String required =
        switch (operation) {
          case "initial" -> decision;
          case "propose" -> decision.equals("VOID") ? "PROPOSE_VOID" : "PROPOSE_REPLACEMENT";
          case "amendment" -> decision + "_AMENDMENT";
          default -> throw new Conflict();
        };
    if (!allowed.contains(required)) throw new Conflict();
    String status = f.status();
    String event;
    BigDecimal amount = f.amount();
    LocalDate date = f.occurredOn();
    Instant confirmed = f.confirmedAt();
    Instant voided = f.voidedAt();
    String action = f.amendmentAction();
    UUID proposer = f.amendmentProposer();
    BigDecimal proposedAmount = f.amendmentAmount();
    LocalDate proposedDate = f.amendmentOccurredOn();
    Instant proposedAt = f.amendmentCreatedAt();
    switch (operation) {
      case "initial" -> {
        status =
            switch (decision) {
              case "CONFIRM" -> "CONFIRMED";
              case "REJECT" -> "REJECTED";
              case "CANCEL" -> "CANCELLED";
              default -> throw new Conflict();
            };
        event =
            switch (decision) {
              case "CONFIRM" -> "CONFIRMED";
              case "REJECT" -> "REJECTED";
              default -> "CANCELLED";
            };
        if (decision.equals("CONFIRM")) confirmed = now;
      }
      case "propose" -> {
        action = decision.equals("VOID") ? "VOID" : "REPLACE";
        proposer = actor;
        proposedAmount = replacementAmount;
        proposedDate = replacementDate;
        proposedAt = now;
        event = "AMENDMENT_PROPOSED";
      }
      case "amendment" -> {
        event =
            "AMENDMENT_"
                + switch (decision) {
                  case "CONFIRM" -> "CONFIRMED";
                  case "REJECT" -> "REJECTED";
                  case "CANCEL" -> "CANCELLED";
                  default -> throw new Conflict();
                };
        if (decision.equals("CONFIRM")) {
          if (action.equals("VOID")) {
            status = "VOIDED";
            voided = now;
          } else {
            amount = proposedAmount;
            date = proposedDate;
          }
        }
        action = null;
        proposer = null;
        proposedAmount = null;
        proposedDate = null;
        proposedAt = null;
      }
      default -> throw new Conflict();
    }
    return new Transition(
        new Fact(
            f.id(),
            f.householdId(),
            f.senderUserId(),
            f.recipientUserId(),
            f.currency(),
            amount,
            date,
            status,
            f.version() + 1,
            f.createdAt(),
            now,
            confirmed,
            voided,
            action,
            proposer,
            proposedAmount,
            proposedDate,
            proposedAt),
        event);
  }
}
