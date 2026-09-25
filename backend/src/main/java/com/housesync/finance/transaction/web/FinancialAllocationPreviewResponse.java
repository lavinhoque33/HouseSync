package com.housesync.finance.transaction.web;

import com.housesync.finance.transaction.web.FinancialAllocationResponse.ImpactResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.MoneyResponse;
import com.housesync.finance.transaction.web.FinancialAllocationResponse.ParticipantResponse;
import java.util.List;
import java.util.UUID;

public record FinancialAllocationPreviewResponse(
    UUID transactionId,
    int transactionVersion,
    String method,
    String refundPolicy,
    MoneyResponse originalAmount,
    List<ParticipantResponse> participants,
    ImpactResponse impact) {}
