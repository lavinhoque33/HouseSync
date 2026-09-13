package com.housesync.identity.web;

import java.util.UUID;

/** Opaque per-error correlation identifiers for safe client/server diagnosis. */
public final class CorrelationIds {

  private CorrelationIds() {}

  public static String newId() {
    return UUID.randomUUID().toString();
  }
}
