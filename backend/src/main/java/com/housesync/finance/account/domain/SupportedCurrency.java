package com.housesync.finance.account.domain;

public enum SupportedCurrency {
  BRL(2),
  USD(2),
  EUR(2),
  GBP(2),
  JPY(0),
  KWD(3);

  private final int scale;

  SupportedCurrency(int scale) {
    this.scale = scale;
  }

  public int scale() {
    return scale;
  }
}
