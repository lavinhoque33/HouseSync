package com.housesync.finance.transaction.web;

import java.util.List;

/**
 * Exact documented grouped balance DTO: currencies ordered by code, balances inside each currency
 * ordered by ascending canonical user UUID with exact currency-scale strings. Zero balances and
 * currencies with no nonzero balances are omitted, so each currency's balances sum to exactly zero.
 * Identity is the stable user UUID only — no email or profile data.
 */
public record MemberBalancesResponse(List<CurrencyBalancesResponse> currencies) {

  /** One currency bucket with its ordered nonzero balances. */
  public record CurrencyBalancesResponse(String currency, List<MemberBalanceResponse> balances) {}

  /** One user's derived obligation: positive means owed, negative means owing. */
  public record MemberBalanceResponse(String userId, String membershipStatus, String amount) {}
}
