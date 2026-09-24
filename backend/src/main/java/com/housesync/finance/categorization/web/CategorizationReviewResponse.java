package com.housesync.finance.categorization.web;

import com.housesync.finance.transaction.web.FinancialTransactionResponse;
import java.time.Instant;
import java.util.UUID;

public record CategorizationReviewResponse(
    UUID id,
    FinancialTransactionResponse transaction,
    int evaluatedTransactionVersion,
    String suggestedCategory,
    String source,
    String confidence,
    String reasonLabel,
    String status,
    int version,
    Instant createdAt,
    Instant updatedAt) {}
