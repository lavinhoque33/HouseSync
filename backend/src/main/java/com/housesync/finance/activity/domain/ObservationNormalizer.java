package com.housesync.finance.activity.domain;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.categorization.domain.CategorizationEvidence;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.plaid.PlaidAdapter.ProviderTransaction;
import com.housesync.finance.transaction.domain.TransactionDescriptionPolicy;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Objects;

/**
 * Exact provider-fact normalization (connected-finance contract §3). Pure and deterministic so the
 * money/sign/date/quarantine rules are unit-testable without a provider or database.
 *
 * <p>Money never touches a binary float: the adapter hands over a {@link BigDecimal} parsed from
 * the provider's decimal token, harmless provider padding is stripped only when the excess digits
 * are trailing zeros, and the exact currency scale is then applied by padding. Plaid's positive
 * debit / negative credit convention is inverted into HouseSync's signed account-holder direction.
 * Zero (including negative zero), unsupported or unofficial-only currencies, over-scale values,
 * excessive magnitude, and out-of-range or missing dates are quarantined with a safe reason rather
 * than rounded, defaulted, or admitted.
 *
 * <p>Provider descriptions are private evidence. A description that cannot survive ledger
 * validation keeps {@code descriptionValid=false} and requires owner replacement text at
 * confirmation instead of blocking the observation.
 */
public final class ObservationNormalizer {

  public static final LocalDate MIN_OCCURRED_ON = LocalDate.of(1900, 1, 1);
  public static final LocalDate MAX_OCCURRED_ON = LocalDate.of(9999, 12, 30);

  public static final String REASON_MISSING_CURRENCY = "MISSING_CURRENCY";
  public static final String REASON_UNOFFICIAL_CURRENCY = "UNOFFICIAL_CURRENCY";
  public static final String REASON_UNSUPPORTED_CURRENCY = "UNSUPPORTED_CURRENCY";
  public static final String REASON_MISSING_AMOUNT = "MISSING_AMOUNT";
  public static final String REASON_ZERO_AMOUNT = "ZERO_AMOUNT";
  public static final String REASON_OVERSCALE = "OVERSCALE";
  public static final String REASON_MAGNITUDE = "MAGNITUDE";
  public static final String REASON_MISSING_DATE = "MISSING_DATE";
  public static final String REASON_DATE_OUT_OF_RANGE = "DATE_OUT_OF_RANGE";

  private static final int MAX_INTEGRAL_DIGITS = 12;
  private static final int MAX_EVIDENCE_CODE_POINTS = 500;
  private static final int MAX_MERCHANT_DISPLAY_CODE_POINTS = 200;
  private static final int MAX_PFC_PRIMARY_CODE_POINTS = 100;
  private static final int MAX_PFC_DETAIL_CODE_POINTS = 200;

  /** Provider/environment binding for identity digests; raw provider IDs are never persisted. */
  public record Scope(String provider, String environment) {}

  public record Normalized(
      String remoteTransactionDigest,
      String remoteAccountDigest,
      String state,
      String providerRevision,
      BigDecimal amount,
      String currency,
      LocalDate occurredOn,
      LocalDate authorizedOn,
      String description,
      boolean descriptionValid,
      String pendingPredecessorDigest,
      String invalidReason,
      String merchantIdentityDigest,
      String merchantDisplayName,
      String pfcPrimaryCode,
      String pfcDetailCode,
      String categorizationEvidenceFingerprint) {

    public boolean valid() {
      return invalidReason == null;
    }
  }

  private ObservationNormalizer() {}

  public static Normalized normalize(Scope scope, ProviderTransaction transaction) {
    String transactionDigest = digest(scope, transaction.remoteTransactionId());
    String accountDigest =
        transaction.remoteAccountId() == null ? null : digest(scope, transaction.remoteAccountId());
    String revision = revision(transaction);
    String state = transaction.pending() ? "PENDING" : "POSTED";

    SupportedCurrency currency = resolveCurrency(transaction);
    String invalidReason = null;
    if (currency == null) {
      invalidReason =
          transaction.officialCurrency() != null
              ? REASON_UNSUPPORTED_CURRENCY
              : (transaction.unofficialCurrency() != null
                  ? REASON_UNOFFICIAL_CURRENCY
                  : REASON_MISSING_CURRENCY);
    }
    // A posted ledger candidate requires the provider's posted calendar date. The authorized date
    // is private evidence only and may stand in for pending display, never for posting.
    LocalDate occurredOn;
    if (transaction.pending()) {
      occurredOn =
          transaction.postedOn() != null ? transaction.postedOn() : transaction.authorizedOn();
    } else {
      occurredOn = transaction.postedOn();
    }
    if (invalidReason == null && occurredOn == null) {
      invalidReason = REASON_MISSING_DATE;
    }
    if (invalidReason == null
        && (occurredOn.isBefore(MIN_OCCURRED_ON) || occurredOn.isAfter(MAX_OCCURRED_ON))) {
      invalidReason = REASON_DATE_OUT_OF_RANGE;
    }
    BigDecimal normalizedAmount = null;
    if (invalidReason == null && transaction.amount() == null) {
      invalidReason = REASON_MISSING_AMOUNT;
    }
    if (invalidReason == null) {
      if (transaction.amount().signum() == 0) {
        // Covers zero and negative zero: a zero revision is never a ledger candidate.
        invalidReason = REASON_ZERO_AMOUNT;
      } else {
        BigDecimal stripped = transaction.amount().stripTrailingZeros();
        if (stripped.scale() > currency.scale()) {
          invalidReason = REASON_OVERSCALE;
        } else {
          BigDecimal scaled = stripped.setScale(currency.scale());
          if (scaled.precision() - scaled.scale() > MAX_INTEGRAL_DIGITS) {
            invalidReason = REASON_MAGNITUDE;
          } else {
            normalizedAmount = scaled.negate();
          }
        }
      }
    }

    String evidence = safeEvidence(transaction.description(), transaction.merchantName());
    boolean descriptionValid = false;
    String description = null;
    if (evidence != null && TransactionDescriptionPolicy.violation(evidence).isEmpty()) {
      descriptionValid = true;
      description = TransactionDescriptionPolicy.normalize(evidence);
    }
    String predecessorDigest =
        transaction.pendingPredecessorId() == null
            ? null
            : digest(scope, transaction.pendingPredecessorId());

    // Categorization evidence is normalized independently of money/date validity: an invalid
    // observation keeps its bounded private evidence so later work can still explain it, while an
    // unsafe (over-limit or malformed) value yields no evidence rather than a corrupt one.
    String merchantIdentityDigest =
        transaction.merchantIdentity() == null || transaction.merchantIdentity().isBlank()
            ? null
            : digest(scope, transaction.merchantIdentity());
    String merchantDisplayName =
        boundedEvidence(transaction.merchantDisplayName(), MAX_MERCHANT_DISPLAY_CODE_POINTS);
    String pfcPrimary = boundedCode(transaction.pfcPrimaryCode(), MAX_PFC_PRIMARY_CODE_POINTS);
    String pfcDetail = boundedCode(transaction.pfcDetailCode(), MAX_PFC_DETAIL_CODE_POINTS);
    if (pfcDetail != null && pfcPrimary == null) {
      // A detail code without its primary is unsafe evidence and never stored.
      pfcDetail = null;
    }
    String evidenceFingerprint =
        CategorizationEvidence.fingerprint(
            merchantIdentityDigest, merchantDisplayName, pfcPrimary, pfcDetail);

    return new Normalized(
        transactionDigest,
        accountDigest,
        state,
        revision,
        normalizedAmount,
        currency == null ? null : currency.name(),
        occurredOn,
        transaction.authorizedOn(),
        evidence,
        descriptionValid,
        predecessorDigest,
        invalidReason,
        merchantIdentityDigest,
        merchantDisplayName,
        pfcPrimary,
        pfcDetail,
        evidenceFingerprint);
  }

  /** Display-name evidence: control characters removed, bounded in code points, or null. */
  private static String boundedEvidence(String raw, int maxCodePoints) {
    if (raw == null || raw.isBlank()) {
      return null;
    }
    StringBuilder cleaned = new StringBuilder();
    raw.codePoints()
        .limit(maxCodePoints)
        .filter(codePoint -> !Character.isISOControl(codePoint))
        .forEach(cleaned::appendCodePoint);
    String value = cleaned.toString();
    return value.isBlank() ? null : value;
  }

  /**
   * Provider category codes are uppercase identifier-shaped tokens; anything else (lowercase,
   * punctuation, whitespace, over-limit) is unsafe evidence and yields null rather than a coerced
   * value.
   */
  private static String boundedCode(String raw, int limit) {
    if (raw == null || raw.isBlank() || raw.codePointCount(0, raw.length()) > limit) {
      return null;
    }
    for (int index = 0; index < raw.length(); ) {
      int codePoint = raw.codePointAt(index);
      boolean allowed =
          (codePoint >= 'A' && codePoint <= 'Z')
              || (codePoint >= '0' && codePoint <= '9')
              || codePoint == '_';
      if (!allowed) {
        return null;
      }
      index += Character.charCount(codePoint);
    }
    return raw;
  }

  /**
   * Material revision hash over state and exact money/date facts. Cosmetic provider metadata
   * (names, categories, locations) never changes this value, so it cannot reopen a dismissed item
   * or mark an admitted entry as modified. Harmless decimal padding canonicalizes away.
   */
  public static String revision(ProviderTransaction transaction) {
    BigDecimal amount = transaction.amount();
    String amountToken =
        amount == null
            ? "null"
            : amount.signum() == 0 ? "0" : amount.stripTrailingZeros().toPlainString();
    String canonical =
        "v1\0"
            + (transaction.pending() ? "PENDING" : "POSTED")
            + "\0"
            + amountToken
            + "\0"
            + Objects.toString(transaction.officialCurrency(), "")
            + "\0"
            + Objects.toString(transaction.unofficialCurrency(), "")
            + "\0"
            + Objects.toString(transaction.postedOn(), "")
            + "\0"
            + Objects.toString(transaction.authorizedOn(), "");
    return ConnectionCrypto.sha256Hex(canonical);
  }

  /** Opaque provider identity digest bound to the owning provider/environment scope. */
  public static String digest(Scope scope, String remoteId) {
    return ConnectionCrypto.sha256Hex(
        scope.provider() + "\0" + scope.environment() + "\0" + remoteId);
  }

  /**
   * Safe private evidence: control characters removed and the value bounded to the observation
   * column width in code points so a hostile or overlong provider string cannot corrupt storage.
   */
  public static String safeEvidence(String description, String merchantName) {
    String raw = description != null && !description.isBlank() ? description : merchantName;
    if (raw == null) {
      return null;
    }
    StringBuilder cleaned = new StringBuilder();
    int[] codePoints = raw.codePoints().toArray();
    int limit = Math.min(codePoints.length, MAX_EVIDENCE_CODE_POINTS);
    for (int index = 0; index < limit; index++) {
      int codePoint = codePoints[index];
      if (!Character.isISOControl(codePoint)) {
        cleaned.appendCodePoint(codePoint);
      }
    }
    String result = cleaned.toString().strip();
    return result.isEmpty() ? null : result;
  }

  private static SupportedCurrency resolveCurrency(ProviderTransaction transaction) {
    String official = transaction.officialCurrency();
    if (official == null) {
      return null;
    }
    try {
      return SupportedCurrency.valueOf(official.strip().toUpperCase(java.util.Locale.ROOT));
    } catch (IllegalArgumentException rejected) {
      return null;
    }
  }
}
