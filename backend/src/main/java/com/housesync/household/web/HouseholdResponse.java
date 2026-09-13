package com.housesync.household.web;

import java.time.Instant;
import java.util.UUID;

/**
 * Authorized household DTO. Carries exactly the contracted fields: the opaque ID, the display name,
 * the current actor's membership role, and the server-generated creation instant. No roster, owner
 * ID, member count, finance data, or persistence object is exposed.
 */
public record HouseholdResponse(UUID id, String name, String role, Instant createdAt) {}
