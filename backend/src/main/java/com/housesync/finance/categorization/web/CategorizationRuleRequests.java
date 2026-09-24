package com.housesync.finance.categorization.web;

import com.fasterxml.jackson.annotation.JsonSetter;

public final class CategorizationRuleRequests {

  private CategorizationRuleRequests() {}

  /**
   * Exact create body: {@code {"expectedTransactionVersion":N}}. Every other field is rejected by
   * the strict mapper; the server derives household, owner, and match fields from authorized stored
   * evidence.
   */
  public static final class CreateCategorizationRuleRequest {
    private Integer expectedTransactionVersion;
    private boolean expectedTransactionVersionPresent;

    @JsonSetter("expectedTransactionVersion")
    public void setExpectedTransactionVersion(Integer expectedTransactionVersion) {
      this.expectedTransactionVersionPresent = true;
      this.expectedTransactionVersion = expectedTransactionVersion;
    }

    public Integer expectedTransactionVersion() {
      return expectedTransactionVersion;
    }

    public boolean expectedTransactionVersionPresent() {
      return expectedTransactionVersionPresent;
    }
  }

  /**
   * Exact patch body: {@code expectedVersion} plus exactly one of {@code category} or {@code
   * status:"INACTIVE"}. Presence flags distinguish explicit null from omission; explicit null is
   * invalid for both fields.
   */
  public static final class PatchCategorizationRuleRequest {
    private Integer expectedVersion;
    private boolean expectedVersionPresent;
    private String category;
    private boolean categoryPresent;
    private String status;
    private boolean statusPresent;

    @JsonSetter("expectedVersion")
    public void setExpectedVersion(Integer expectedVersion) {
      this.expectedVersionPresent = true;
      this.expectedVersion = expectedVersion;
    }

    @JsonSetter("category")
    public void setCategory(String category) {
      this.categoryPresent = true;
      this.category = category;
    }

    @JsonSetter("status")
    public void setStatus(String status) {
      this.statusPresent = true;
      this.status = status;
    }

    public Integer expectedVersion() {
      return expectedVersion;
    }

    public boolean expectedVersionPresent() {
      return expectedVersionPresent;
    }

    public String category() {
      return category;
    }

    public boolean categoryPresent() {
      return categoryPresent;
    }

    public String status() {
      return status;
    }

    public boolean statusPresent() {
      return statusPresent;
    }
  }
}
