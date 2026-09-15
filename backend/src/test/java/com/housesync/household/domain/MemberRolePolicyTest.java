package com.housesync.household.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Strict lifecycle role contract: only the exact canonical role names bind. Lowercase spellings,
 * whitespace padding, and unknown values are violations because a lenient parse would let a forged
 * or mistyped role drift into the persistence layer.
 */
class MemberRolePolicyTest {

  @Test
  void canonicalRoleNamesAreAccepted() {
    assertThat(MemberRolePolicy.violation("OWNER")).isEmpty();
    assertThat(MemberRolePolicy.violation("MEMBER")).isEmpty();
  }

  @Test
  void missingAndMalformedRolesAreViolations() {
    assertThat(MemberRolePolicy.violation(null)).contains(MemberRolePolicy.ROLE_ERROR);
    assertThat(MemberRolePolicy.violation("")).contains(MemberRolePolicy.ROLE_ERROR);
    assertThat(MemberRolePolicy.violation("owner")).contains(MemberRolePolicy.ROLE_ERROR);
    assertThat(MemberRolePolicy.violation("member")).contains(MemberRolePolicy.ROLE_ERROR);
    assertThat(MemberRolePolicy.violation("ADMIN")).contains(MemberRolePolicy.ROLE_ERROR);
    assertThat(MemberRolePolicy.violation(" OWNER")).contains(MemberRolePolicy.ROLE_ERROR);
    assertThat(MemberRolePolicy.violation("OWNER ")).contains(MemberRolePolicy.ROLE_ERROR);
  }
}
