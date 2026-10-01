package com.housesync.finance.categorization.web;

import java.time.Instant;
import java.util.UUID;

/**
 * Exact owner-private rule item (categorization contract §4). Nine fields, no more: the bounded
 * display label and match type are safe; the server-derived match key, internal ruleset version,
 * and provider digests never appear here. Rules are visible only to the financial owner who created
 * them.
 */
public record CategorizationRuleResponse(
    UUID id,
    UUID sourceTransactionId,
    String matchType,
    String matchLabel,
    String category,
    String status,
    int version,
    Instant createdAt,
    Instant updatedAt) {}
