package com.housesync.finance.connection.plaid;

/**
 * Application-level view of one provider account. The remote identity stays inside the service
 * layer long enough to derive its storage digest; it is never persisted raw, returned to the
 * browser, or logged.
 */
public record RemoteAccount(String remoteAccountId, String name, String kind, String currency) {}
