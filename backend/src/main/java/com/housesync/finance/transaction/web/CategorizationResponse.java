package com.housesync.finance.transaction.web;

import java.time.Instant;
import java.util.UUID;

/**
 * Exact owner-only categorization projection (categorization contract §5). Six fields,
 * no more: the safe provenance state of one transaction for its financial owner. No rule ID,
 * provider code, merchant key, confidence, reason, model, or evidence digest ever appears here, and
 * another member never receives this resource at all — the effective category alone is already
 * visible through the shared transaction DTO.
 */
public record CategorizationResponse(
    UUID transactionId,
    int transactionVersion,
    String category,
    String origin,
    Instant assignedAt,
    String reviewState) {}
