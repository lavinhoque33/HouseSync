package com.housesync.household.web;

import java.util.UUID;

/** Minimal household-visible account identity and current membership role. */
public record HouseholdMemberResponse(UUID userId, String email, String role) {}
