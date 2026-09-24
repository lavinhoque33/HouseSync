package com.housesync.finance.transaction.web;

import java.time.Instant;
import java.util.UUID;

/**
 * Exact owner-only categorization projection (categorization contract §5). Seven
 * fields, no more: the safe provenance state of one transaction for its financial owner plus the
 * {@code ruleEligible} capability the browser uses to offer the learn action. No rule ID, match
 * key, provider code, merchant evidence, confidence, reason, model, or evidence digest ever appears
 * here, and another member never receives this resource at all — the effective category alone is
 * already visible through the shared transaction DTO.
 */
public record CategorizationResponse(
    UUID transactionId,
    int transactionVersion,
    String category,
    String origin,
    Instant assignedAt,
    String reviewState,
    boolean ruleEligible) {}
