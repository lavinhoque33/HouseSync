package com.housesync.finance.account.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class FinancialAccountNamePolicyTest {

  @Test
  void normalizesUnicodeBoundarySpacesAndPreservesInteriorContent() {
    assertThat(FinancialAccountNamePolicy.normalize("\u00a0 Daily\u2007 spending \u202f"))
        .isEqualTo("Daily\u2007 spending");
    assertThat(FinancialAccountNamePolicy.violation("\u00a0\u202f"))
        .contains("Enter an account name.");
  }

  @Test
  void measuresCodePointsAndRejectsControls() {
    String hundred = "💳".repeat(100);
    assertThat(FinancialAccountNamePolicy.violation(hundred)).isEmpty();
    assertThat(FinancialAccountNamePolicy.violation(hundred + "x"))
        .contains("Account name must be at most 100 characters.");
    assertThat(FinancialAccountNamePolicy.violation("Daily\nspending"))
        .contains("Account name must not contain control characters.");
  }

  /**
   * Pins the JVM behavior that keeps accepted names inside the V6 database constraints:
   * U+2028/U+2029 are Java whitespace and trim at the outer boundary like the migration's
   * chr(8232)/chr(8233), while U+0085 (which the database trims) is a control character the
   * application rejects before it could ever reach a CHECK.
   */
  @Test
  void trimsUnicodeLineAndParagraphSeparatorsAndRejectsNextLineControl() {
    assertThat(FinancialAccountNamePolicy.normalize("\u2028 Wrapped \u2029")).isEqualTo("Wrapped");
    assertThat(FinancialAccountNamePolicy.violation("\u2028 Wrapped \u2029")).isEmpty();
    assertThat(FinancialAccountNamePolicy.violation("\u0085"))
        .contains("Account name must not contain control characters.");
    assertThat(FinancialAccountNamePolicy.violation("Ledger\u0085"))
        .contains("Account name must not contain control characters.");
  }
}
