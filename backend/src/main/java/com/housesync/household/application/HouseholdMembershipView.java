package com.housesync.household.application;

import com.housesync.household.domain.MemberRole;
import java.time.Instant;
import java.util.UUID;

/**
 * Single membership-scoped read row: the household plus the actor's current role, resolved together
 * in PostgreSQL so access decisions never load an unrestricted household.
 */
public record HouseholdMembershipView(
    UUID householdId, String name, MemberRole role, Instant createdAt) {}
