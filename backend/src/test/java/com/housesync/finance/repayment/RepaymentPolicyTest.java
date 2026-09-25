package com.housesync.finance.repayment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.repayment.RepaymentRepository.Fact;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class RepaymentPolicyTest {
  private final UUID sender = UUID.randomUUID(),
      recipient = UUID.randomUUID(),
      owner = UUID.randomUUID();
  private final Instant now = Instant.parse("2026-09-23T10:00:00Z");
  private final Set<UUID> both = Set.of(sender, recipient, owner);

  private Fact pending() {
    return new Fact(
        UUID.randomUUID(),
        UUID.randomUUID(),
        sender,
        recipient,
        SupportedCurrency.USD,
        new BigDecimal("3.00"),
        LocalDate.of(2026, 9, 20),
        "PENDING",
        0,
        now,
        now,
        null,
        null,
        null,
        null,
        null,
        null,
        null);
  }

  @Test
  void initialConsentRequiresRecipientAndBothCurrent() {
    Fact p = pending();
    assertThat(RepaymentPolicy.actions(p, sender, both)).containsExactly("CANCEL");
    assertThat(RepaymentPolicy.actions(p, recipient, both)).containsExactly("CONFIRM", "REJECT");
    assertThat(RepaymentPolicy.actions(p, owner, both)).isEmpty();
    assertThatThrownBy(
            () -> RepaymentPolicy.change(p, sender, both, 0, "initial", "CONFIRM", null, null, now))
        .isInstanceOf(RepaymentPolicy.Conflict.class);
    assertThatThrownBy(
            () ->
                RepaymentPolicy.change(
                    p, recipient, Set.of(recipient), 0, "initial", "CONFIRM", null, null, now))
        .isInstanceOf(RepaymentPolicy.Conflict.class);
    Fact accepted =
        RepaymentPolicy.change(p, recipient, both, 0, "initial", "CONFIRM", null, null, now).fact();
    assertThat(accepted.version()).isEqualTo(1);
    assertThat(accepted.confirmedAt()).isEqualTo(now);
    assertThatThrownBy(
            () ->
                RepaymentPolicy.change(
                    p, recipient, both, 1, "initial", "CONFIRM", null, null, now))
        .isInstanceOf(RepaymentPolicy.Conflict.class);
  }

  @Test
  void amendmentKeepsAcceptedFactUntilOtherPartyConfirmsAndCannotBeSelfConfirmed() {
    Fact accepted =
        RepaymentPolicy.change(pending(), recipient, both, 0, "initial", "CONFIRM", null, null, now)
            .fact();
    Fact proposed =
        RepaymentPolicy.change(
                accepted,
                sender,
                both,
                1,
                "propose",
                "REPLACE",
                new BigDecimal("4.00"),
                LocalDate.of(2026, 9, 21),
                now.plusSeconds(1))
            .fact();
    assertThat(proposed.amount()).isEqualByComparingTo("3.00");
    assertThat(proposed.amendmentAmount()).isEqualByComparingTo("4.00");
    assertThatThrownBy(
            () ->
                RepaymentPolicy.change(
                    proposed, sender, both, 2, "amendment", "CONFIRM", null, null, now))
        .isInstanceOf(RepaymentPolicy.Conflict.class);
    Fact rejected =
        RepaymentPolicy.change(
                proposed, recipient, Set.of(recipient), 2, "amendment", "REJECT", null, null, now)
            .fact();
    assertThat(rejected.amount()).isEqualByComparingTo("3.00");
    assertThat(rejected.amendmentAction()).isNull();
    Fact confirmed =
        RepaymentPolicy.change(
                proposed,
                recipient,
                both,
                2,
                "amendment",
                "CONFIRM",
                null,
                null,
                now.plusSeconds(2))
            .fact();
    assertThat(confirmed.amount()).isEqualByComparingTo("4.00");
    assertThat(confirmed.occurredOn()).isEqualTo(LocalDate.of(2026, 9, 21));
    Fact voidProposal =
        RepaymentPolicy.change(
                confirmed, recipient, both, 3, "propose", "VOID", null, null, now.plusSeconds(3))
            .fact();
    Fact voided =
        RepaymentPolicy.change(
                voidProposal,
                sender,
                both,
                4,
                "amendment",
                "CONFIRM",
                null,
                null,
                now.plusSeconds(4))
            .fact();
    assertThat(voided.status()).isEqualTo("VOIDED");
    assertThat(voided.amount()).isEqualByComparingTo("4.00");
    assertThat(voided.voidedAt()).isEqualTo(now.plusSeconds(4));
    assertThat(RepaymentPolicy.actions(voided, sender, both)).isEmpty();
  }

  @Test
  void departedCounterpartCanBeRejectedOrCancelledButNeverConfirmed() {
    Fact pending = pending();
    assertThat(RepaymentPolicy.actions(pending, recipient, Set.of(recipient)))
        .containsExactly("REJECT");
    assertThat(RepaymentPolicy.actions(pending, sender, Set.of(sender))).containsExactly("CANCEL");
    Fact accepted =
        RepaymentPolicy.change(pending, recipient, both, 0, "initial", "CONFIRM", null, null, now)
            .fact();
    Fact proposed =
        RepaymentPolicy.change(accepted, sender, both, 1, "propose", "VOID", null, null, now)
            .fact();
    assertThat(RepaymentPolicy.actions(proposed, recipient, Set.of(recipient)))
        .containsExactly("REJECT_AMENDMENT");
    assertThat(RepaymentPolicy.actions(proposed, sender, Set.of(sender)))
        .containsExactly("CANCEL_AMENDMENT");
    assertThat(RepaymentPolicy.actions(proposed, recipient, both))
        .containsExactly("CONFIRM_AMENDMENT", "REJECT_AMENDMENT");
  }
}
