package com.housesync.finance.account.web;

import java.util.List;

public record FinancialAccountListResponse(
    List<FinancialAccountResponse> items, int limit, int offset, boolean hasMore) {}
