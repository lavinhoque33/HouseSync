package com.housesync.finance.activity.domain;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.activity.domain.ObservationNormalizer.Normalized;
import com.housesync.finance.activity.domain.ObservationNormalizer.Scope;
import com.housesync.finance.connection.plaid.PlaidAdapter.ProviderTransaction;
import java.math.BigDecimal;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class ObservationNormalizerTest {

  private static final Scope SCOPE = new Scope("PLAID", "SANDBOX");

  private static ProviderTransaction transaction(
      boolean pending, String officialCurrency, BigDecimal amount, LocalDate date, String name) {
    return new ProviderTransaction(
        "remote-account-1",
        "remote-transaction-1",
        null,
        pending,
        officialCurrency,
        null,
        amount,
        date,
        null,
        name,
        null,
        null,
        null,
        null,
        null);
  }

  @Test
  void plaidSignIsInvertedExactlyWithoutBinaryRounding() {
    Normalized debit =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(false, "USD", new BigDecimal("12.34"), LocalDate.of(2026, 9, 1), "Coffee"));
    assertThat(debit.valid()).isTrue();
    assertThat(debit.amount()).isEqualByComparingTo("-12.34");
    assertThat(debit.amount().toPlainString()).isEqualTo("-12.34");
    assertThat(debit.state()).isEqualTo("POSTED");

    Normalized credit =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(
                false, "USD", new BigDecimal("-250.00"), LocalDate.of(2026, 9, 1), "Payroll"));
    assertThat(credit.amount()).isEqualByComparingTo("250.00");
    assertThat(credit.amount().toPlainString()).isEqualTo("250.00");
  }

  @Test
  void harmlessTrailingPaddingIsStrippedOnlyInExcessOfCurrencyScale() {
    Normalized usd =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(false, "USD", new BigDecimal("1.2300"), LocalDate.of(2026, 9, 1), "A"));
    assertThat(usd.valid()).isTrue();
    assertThat(usd.amount().toPlainString()).isEqualTo("-1.23");

    Normalized jpy =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(false, "JPY", new BigDecimal("1000.000"), LocalDate.of(2026, 9, 1), "B"));
    assertThat(jpy.valid()).isTrue();
    assertThat(jpy.amount().toPlainString()).isEqualTo("-1000");

    Normalized kwd =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(false, "KWD", new BigDecimal("1.200"), LocalDate.of(2026, 9, 1), "C"));
    assertThat(kwd.valid()).isTrue();
    assertThat(kwd.amount().toPlainString()).isEqualTo("-1.200");
  }

  @Test
  void meaningfulDigitsBeyondCurrencyScaleAreQuarantinedNotRounded() {
    assertThat(
            ObservationNormalizer.normalize(
                    SCOPE,
                    transaction(
                        false, "USD", new BigDecimal("1.2301"), LocalDate.of(2026, 9, 1), "D"))
                .invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_OVERSCALE);
    assertThat(
            ObservationNormalizer.normalize(
                    SCOPE,
                    transaction(
                        false, "JPY", new BigDecimal("1.001"), LocalDate.of(2026, 9, 1), "E"))
                .invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_OVERSCALE);
    assertThat(
            ObservationNormalizer.normalize(
                    SCOPE,
                    transaction(
                        false, "CAD", new BigDecimal("0.005"), LocalDate.of(2026, 9, 1), "F"))
                .invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_OVERSCALE);
  }

  @Test
  void zeroAndNegativeZeroAreRejected() {
    assertThat(
            ObservationNormalizer.normalize(
                    SCOPE,
                    transaction(
                        false, "USD", new BigDecimal("0.00"), LocalDate.of(2026, 9, 1), "G"))
                .invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_ZERO_AMOUNT);
    assertThat(
            ObservationNormalizer.normalize(
                    SCOPE,
                    transaction(
                        false, "USD", new BigDecimal("-0.000"), LocalDate.of(2026, 9, 1), "H"))
                .invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_ZERO_AMOUNT);
  }

  @Test
  void unsupportedAndUnofficialCurrenciesAndMissingFactsAreQuarantinedByIdentity() {
    ProviderTransaction unofficial =
        new ProviderTransaction(
            "remote-account-1",
            "remote-transaction-2",
            null,
            false,
            null,
            "XYZ",
            new BigDecimal("1.00"),
            LocalDate.of(2026, 9, 1),
            null,
            "I",
            null,
            null,
            null,
            null,
            null);
    Normalized unofficialResult = ObservationNormalizer.normalize(SCOPE, unofficial);
    assertThat(unofficialResult.invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_UNOFFICIAL_CURRENCY);
    assertThat(unofficialResult.remoteTransactionDigest()).hasSize(64);
    assertThat(unofficialResult.remoteAccountDigest()).hasSize(64);

    Normalized unsupported =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(false, "CHF", new BigDecimal("1.00"), LocalDate.of(2026, 9, 1), "J"));
    assertThat(unsupported.invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_UNSUPPORTED_CURRENCY);

    Normalized missingAmount =
        ObservationNormalizer.normalize(
            SCOPE, transaction(false, "USD", null, LocalDate.of(2026, 9, 1), "K"));
    assertThat(missingAmount.invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_MISSING_AMOUNT);

    Normalized missingDate =
        ObservationNormalizer.normalize(
            SCOPE, transaction(false, "USD", new BigDecimal("1.00"), null, "L"));
    assertThat(missingDate.invalidReason()).isEqualTo(ObservationNormalizer.REASON_MISSING_DATE);

    Normalized outOfRange =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(false, "USD", new BigDecimal("1.00"), LocalDate.of(1899, 12, 31), "M"));
    assertThat(outOfRange.invalidReason())
        .isEqualTo(ObservationNormalizer.REASON_DATE_OUT_OF_RANGE);
  }

  @Test
  void excessiveMagnitudeIsQuarantined() {
    Normalized tooLarge =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(
                false, "USD", new BigDecimal("1234567890123.45"), LocalDate.of(2026, 9, 1), "N"));
    assertThat(tooLarge.invalidReason()).isEqualTo(ObservationNormalizer.REASON_MAGNITUDE);

    Normalized atBound =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(
                false, "USD", new BigDecimal("999999999999.99"), LocalDate.of(2026, 9, 1), "O"));
    assertThat(atBound.valid()).isTrue();
  }

  @Test
  void revisionIgnoresCosmeticMetadataAndCanonicalizesPadding() {
    String first =
        ObservationNormalizer.revision(
            transaction(
                false, "USD", new BigDecimal("1.2300"), LocalDate.of(2026, 9, 1), "Name A"));
    String sameMoneyDifferentMetadata =
        ObservationNormalizer.revision(
            transaction(false, "USD", new BigDecimal("1.23"), LocalDate.of(2026, 9, 1), "Name B"));
    assertThat(first).isEqualTo(sameMoneyDifferentMetadata);

    String changedMoney =
        ObservationNormalizer.revision(
            transaction(false, "USD", new BigDecimal("1.24"), LocalDate.of(2026, 9, 1), "Name A"));
    assertThat(changedMoney).isNotEqualTo(first);

    String pendingRevision =
        ObservationNormalizer.revision(
            transaction(true, "USD", new BigDecimal("1.23"), LocalDate.of(2026, 9, 1), "Name A"));
    assertThat(pendingRevision).isNotEqualTo(first);
  }

  @Test
  void invalidDescriptionsRemainPrivateEvidenceRequiringOwnerText() {
    String hugeDescription = "x".repeat(300);
    Normalized overlong =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(
                false, "USD", new BigDecimal("1.00"), LocalDate.of(2026, 9, 1), hugeDescription));
    assertThat(overlong.valid()).isTrue();
    assertThat(overlong.descriptionValid()).isFalse();
    assertThat(overlong.description()).hasSize(300);

    Normalized valid =
        ObservationNormalizer.normalize(
            SCOPE,
            transaction(
                false, "USD", new BigDecimal("1.00"), LocalDate.of(2026, 9, 1), "Valid name"));
    assertThat(valid.descriptionValid()).isTrue();
    assertThat(valid.description()).isEqualTo("Valid name");
  }

  @Test
  void postedCandidatesRequireThePostedProviderDate() {
    // A posted transaction with only an authorized date is not a ledger candidate: the authorized
    // date is private evidence, not a spending date.
    ProviderTransaction postedAuthorizationOnly =
        new ProviderTransaction(
            "remote-account-1",
            "remote-transaction-9",
            null,
            false,
            "USD",
            null,
            new BigDecimal("12.00"),
            null,
            LocalDate.of(2026, 9, 9),
            "Authorization only",
            null,
            null,
            null,
            null,
            null);
    Normalized posted = ObservationNormalizer.normalize(SCOPE, postedAuthorizationOnly);
    assertThat(posted.invalidReason()).isEqualTo(ObservationNormalizer.REASON_MISSING_DATE);
    assertThat(posted.state()).isEqualTo("POSTED");
    assertThat(posted.authorizedOn()).isEqualTo(LocalDate.of(2026, 9, 9));

    // Pending rows may stand in the authorized date for private display only.
    ProviderTransaction pending =
        new ProviderTransaction(
            "remote-account-1",
            "remote-transaction-10",
            null,
            true,
            "USD",
            null,
            new BigDecimal("12.00"),
            null,
            LocalDate.of(2026, 9, 9),
            "Pending authorization",
            null,
            null,
            null,
            null,
            null);
    Normalized pendingResult = ObservationNormalizer.normalize(SCOPE, pending);
    assertThat(pendingResult.valid()).isTrue();
    assertThat(pendingResult.state()).isEqualTo("PENDING");
    assertThat(pendingResult.occurredOn()).isEqualTo(LocalDate.of(2026, 9, 9));
  }

  @Test
  void explicitPendingPredecessorIsLinkedAndPendingDateUsesAuthorizedEvidence() {
    ProviderTransaction posted =
        new ProviderTransaction(
            "remote-account-1",
            "remote-transaction-5",
            "remote-transaction-4",
            false,
            "USD",
            null,
            new BigDecimal("9.99"),
            LocalDate.of(2026, 9, 2),
            LocalDate.of(2026, 9, 1),
            "Posted name",
            "Merchant",
            null,
            null,
            null,
            null);
    Normalized normalized = ObservationNormalizer.normalize(SCOPE, posted);
    assertThat(normalized.pendingPredecessorDigest())
        .isEqualTo(ObservationNormalizer.digest(SCOPE, "remote-transaction-4"));
    assertThat(normalized.occurredOn()).isEqualTo(LocalDate.of(2026, 9, 2));
    assertThat(normalized.authorizedOn()).isEqualTo(LocalDate.of(2026, 9, 1));

    ProviderTransaction pending =
        new ProviderTransaction(
            "remote-account-1",
            "remote-transaction-4",
            null,
            true,
            "USD",
            null,
            new BigDecimal("9.99"),
            LocalDate.of(2026, 9, 1),
            LocalDate.of(2026, 9, 1),
            "Pending name",
            null,
            null,
            null,
            null,
            null);
    Normalized pendingNormalized = ObservationNormalizer.normalize(SCOPE, pending);
    assertThat(pendingNormalized.state()).isEqualTo("PENDING");
    assertThat(pendingNormalized.occurredOn()).isEqualTo(LocalDate.of(2026, 9, 1));
  }

  @Test
  void categorizationEvidenceIsScopedBoundedAndSeparateFromProviderRevision() {
    ProviderTransaction first =
        new ProviderTransaction(
            "remote-account-1",
            "remote-transaction-6",
            null,
            false,
            "USD",
            null,
            new BigDecimal("12.34"),
            LocalDate.of(2026, 9, 3),
            null,
            "Statement",
            "Merchant",
            "merchant-entity-1",
            "M".repeat(250),
            "FOOD_AND_DRINK",
            "FOOD_AND_DRINK_GROCERIES");
    ProviderTransaction changedEvidence =
        new ProviderTransaction(
            "remote-account-1",
            "remote-transaction-6",
            null,
            false,
            "USD",
            null,
            new BigDecimal("12.34"),
            LocalDate.of(2026, 9, 3),
            null,
            "Statement",
            "Merchant",
            "merchant-entity-2",
            "Other merchant",
            "GENERAL_MERCHANDISE",
            null);

    Normalized normalized = ObservationNormalizer.normalize(SCOPE, first);
    Normalized changed = ObservationNormalizer.normalize(SCOPE, changedEvidence);

    assertThat(normalized.merchantIdentityDigest())
        .isEqualTo(ObservationNormalizer.digest(SCOPE, "merchant-entity-1"));
    assertThat(normalized.merchantDisplayName()).hasSize(200);
    assertThat(normalized.pfcPrimaryCode()).isEqualTo("FOOD_AND_DRINK");
    assertThat(normalized.pfcDetailCode()).isEqualTo("FOOD_AND_DRINK_GROCERIES");
    assertThat(normalized.categorizationEvidenceFingerprint()).hasSize(64);
    assertThat(changed.providerRevision()).isEqualTo(normalized.providerRevision());
    assertThat(changed.categorizationEvidenceFingerprint())
        .isNotEqualTo(normalized.categorizationEvidenceFingerprint());
  }
}
