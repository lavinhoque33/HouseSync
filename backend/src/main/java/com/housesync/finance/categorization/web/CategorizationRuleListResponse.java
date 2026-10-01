package com.housesync.finance.categorization.web;

import java.util.List;

/**
 * Exact owner-private rule page (categorization contract §4): bounded items, the echoed window, and
 * hasMore. There is deliberately no total count. Items are ordered by {@code updatedAt DESC, id
 * DESC}.
 */
public record CategorizationRuleListResponse(
    List<CategorizationRuleResponse> items, int limit, int offset, boolean hasMore) {}
