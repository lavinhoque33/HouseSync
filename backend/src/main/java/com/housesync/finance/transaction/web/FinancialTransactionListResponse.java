package com.housesync.finance.transaction.web;

import java.util.List;

public record FinancialTransactionListResponse(
    List<FinancialTransactionResponse> items, int limit, int offset, boolean hasMore) {}
