package com.housesync.household.domain;

/**
 * Stable membership roles. Household creation assigns {@code OWNER}; invitation acceptance assigns
 * {@code MEMBER}.
 */
public enum MemberRole {
  OWNER,
  MEMBER
}
