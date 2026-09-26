package com.housesync.finance.report;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.categorization.domain.RuleTextNormalizer;
import com.housesync.finance.report.application.SpendingInsightsService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.time.YearMonth;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class SpendingInsightsPolicyTest {
  @Test
  void publicDescriptionsUseConservativeSharedNormalizerAndScopedDigest() {
    UUID household = UUID.randomUUID();
    String first = RuleTextNormalizer.normalize("  ＡＬＰＨＡ\u00a0\t Shop #12 ").orElseThrow();
    assertThat(first).isEqualTo("alpha shop #12");
    assertThat(RuleTextNormalizer.normalize("ALPHA SHOP #13").orElseThrow()).isNotEqualTo(first);
    assertThat(SpendingInsightsService.merchantKey(household, SupportedCurrency.USD, first))
        .matches("[0-9a-f]{64}")
        .isNotEqualTo(SpendingInsightsService.merchantKey(household, SupportedCurrency.EUR, first))
        .isNotEqualTo(
            SpendingInsightsService.merchantKey(UUID.randomUUID(), SupportedCurrency.USD, first));
    assertThat(RuleTextNormalizer.normalize("\u0000Unsafe")).isEmpty();
    assertThat(RuleTextNormalizer.normalize("a".repeat(201))).isEmpty();
  }

  @Test
  void monthRangeRejectsUnsupportedCompleteDecemberAndMalformedDates() {
    assertThat(SpendingInsightsService.parseMonth("9999-12", true))
        .isEqualTo(YearMonth.of(9999, 12));
    for (String month : new String[] {"9999-12", "1899-12", "2026-9", "2026-13", "2026-09 "})
      assertThatThrownBy(() -> SpendingInsightsService.parseMonth(month, false))
          .isInstanceOf(ValidationFailedException.class);
    assertThatThrownBy(() -> SpendingInsightsService.validateKey("MERCHANT", "ABC"))
        .isInstanceOf(ValidationFailedException.class);
    assertThatThrownBy(() -> SpendingInsightsService.validateKey("CATEGORY", "BAD"))
        .isInstanceOf(ValidationFailedException.class);
  }
}
