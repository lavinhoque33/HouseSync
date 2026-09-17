package com.housesync.finance.connection.application;

import java.util.UUID;

/**
 * Household-lifecycle callback invoked inside the membership removal/leave transaction.
 * Implementations suspend the departed member's connections and queue durable revocation so remote
 * cleanup survives the membership loss.
 */
public interface ConnectionMembershipHook {

  void suspendOwnerConnections(UUID householdId, UUID ownerUserId);
}
