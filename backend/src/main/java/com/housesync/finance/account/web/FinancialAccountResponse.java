package com.housesync.finance.account.web;

import java.time.Instant;
import java.util.UUID;

public record FinancialAccountResponse(
    UUID id,
    UUID householdId,
    UUID ownerUserId,
    String name,
    String kind,
    String currency,
    String source,
    String visibility,
    String status,
    int version,
    Instant createdAt,
    Instant updatedAt) {}
