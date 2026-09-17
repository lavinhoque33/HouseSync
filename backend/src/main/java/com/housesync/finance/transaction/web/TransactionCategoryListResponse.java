package com.housesync.finance.transaction.web;

import java.util.List;

/**
 * Bounded fixed taxonomy response: exactly the sixteen server-owned categories in
 * documented order. Not a paginated collection, so the page envelope does not apply.
 */
public record TransactionCategoryListResponse(List<Item> items) {

  /** One taxonomy entry: the case-sensitive create/patch token plus its server label. */
  public record Item(String code, String label) {}
}
