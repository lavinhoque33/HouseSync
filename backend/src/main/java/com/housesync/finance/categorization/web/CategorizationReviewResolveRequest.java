package com.housesync.finance.categorization.web;

import com.fasterxml.jackson.annotation.JsonSetter;

public final class CategorizationReviewResolveRequest {
  private Integer expectedVersion;
  private Integer expectedTransactionVersion;
  private String action;
  private String category;
  private boolean categoryPresent;

  @JsonSetter("expectedVersion")
  public void setExpectedVersion(Integer value) {
    expectedVersion = value;
  }

  @JsonSetter("expectedTransactionVersion")
  public void setExpectedTransactionVersion(Integer value) {
    expectedTransactionVersion = value;
  }

  @JsonSetter("action")
  public void setAction(String value) {
    action = value;
  }

  @JsonSetter("category")
  public void setCategory(String value) {
    categoryPresent = true;
    category = value;
  }

  public Integer expectedVersion() {
    return expectedVersion;
  }

  public Integer expectedTransactionVersion() {
    return expectedTransactionVersion;
  }

  public String action() {
    return action;
  }

  public String category() {
    return category;
  }

  public boolean categoryPresent() {
    return categoryPresent;
  }
}
