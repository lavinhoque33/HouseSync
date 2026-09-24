package com.housesync.finance.categorization.web;

import java.util.List;

public record CategorizationReviewListResponse(
    List<CategorizationReviewResponse> items,
    int limit,
    int offset,
    boolean hasMore,
    long openCount) {}
