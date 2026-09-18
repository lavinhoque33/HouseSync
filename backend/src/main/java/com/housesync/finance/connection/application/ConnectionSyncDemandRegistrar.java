package com.housesync.finance.connection.application;

import com.housesync.finance.connection.persistence.ConnectionSyncWorkRepository;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Registers durable sync demand inside the caller's transaction. Every demand increments a
 * monotonic sequence, so a webhook, manual sync, selection reset, or reconnect wake-up that lands
 * while a round is running forces another round instead of being swallowed by completion.
 *
 * <p>The increment is one atomic PostgreSQL upsert. A concurrent first demand therefore never
 * raises a flush-time unique violation that would poison the caller's persistence context, and the
 * caller's transaction remains atomic with its own work.
 */
@Component
public class ConnectionSyncDemandRegistrar {

  private final ConnectionSyncWorkRepository work;

  public ConnectionSyncDemandRegistrar(ConnectionSyncWorkRepository work) {
    this.work = work;
  }

  /** Creates or increments the connection's demand row; callers needing state re-read it locked. */
  public void demand(UUID connectionId, Instant now) {
    work.upsertDemand(UUID.randomUUID(), connectionId, now);
  }
}
