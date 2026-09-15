package com.housesync.household.application;

import com.housesync.household.domain.MemberRole;
import java.util.UUID;

/** Minimal member projection used by the household roster and lifecycle responses. */
public record HouseholdMemberView(UUID userId, String email, MemberRole role) {}
