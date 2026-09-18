package com.housesync.finance.connection.webhook;

import com.housesync.finance.activity.persistence.ProviderWebhookEventEntity;
import com.housesync.finance.activity.persistence.ProviderWebhookEventRepository;
import com.housesync.finance.connection.application.ConnectionSyncDemandRegistrar;
import com.housesync.finance.connection.config.ConnectedFinanceProperties;
import com.housesync.finance.connection.crypto.ConnectionCrypto;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkEntity;
import com.housesync.finance.connection.persistence.ConnectionRevocationWorkRepository;
import com.housesync.finance.connection.persistence.ConnectionSyncWorkRepository;
import com.housesync.finance.connection.persistence.FinancialConnectionEntity;
import com.housesync.finance.connection.persistence.FinancialConnectionRepository;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.VerifiedEvent;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.WebhookUnavailableException;
import jakarta.persistence.EntityManager;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataAccessException;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Durable webhook admission (connected-finance contract §5). Verification happens before any domain
 * write; this service then commits the replay fingerprint together with the coalesced sync demand
 * or the conservative health transition in one transaction, and the endpoint only returns 200 after
 * that commit. A replayed fingerprint commits nothing new but still coalesces demand. Unknown Items
 * and irrelevant verified events commit their fingerprint and return 200 without revealing whether
 * the Item exists. A database outage surfaces as a 503, never a success.
 *
 * <p>Health handling is deliberately stop-only: ITEM login errors fence the connection into
 * REAUTH_REQUIRED and never fetch, consent/permission revocation suspends and queues durable remote
 * cleanup. Nothing reactivates a connection, and legacy transaction webhooks never apply ledger
 * deltas — the cursor stays the only transaction truth.
 */
@Service
public class WebhookIngressService {

  private static final Duration REPLAY_TTL = Duration.ofHours(24);

  private final ConnectedFinanceProperties properties;
  private final FinancialConnectionRepository connections;
  private final ProviderWebhookEventRepository events;
  private final ConnectionSyncDemandRegistrar demands;
  private final ConnectionSyncWorkRepository syncWork;
  private final ConnectionRevocationWorkRepository revocations;
  private final PlaidAdapter adapter;
  private final Clock clock;
  private final EntityManager entityManager;
  private final TransactionTemplate transactions;

  public WebhookIngressService(
      ConnectedFinanceProperties properties,
      FinancialConnectionRepository connections,
      ProviderWebhookEventRepository events,
      ConnectionSyncDemandRegistrar demands,
      ConnectionSyncWorkRepository syncWork,
      ConnectionRevocationWorkRepository revocations,
      PlaidAdapter adapter,
      Clock clock,
      EntityManager entityManager,
      PlatformTransactionManager transactionManager) {
    this.properties = properties;
    this.connections = connections;
    this.events = events;
    this.demands = demands;
    this.syncWork = syncWork;
    this.revocations = revocations;
    this.adapter = adapter;
    this.clock = clock;
    this.entityManager = entityManager;
    this.transactions = new TransactionTemplate(transactionManager);
  }

  /** Verifies that the feature is enabled; admission of a disabled deployment is a 503. */
  public boolean enabled() {
    return properties.isEnabled();
  }

  /**
   * Commits the replay fingerprint plus routing effect. {@code signedJwtHash} is the SHA-256 of the
   * signature header; neither the header nor the body is ever stored or logged.
   *
   * <p>The connection row is locked and re-read before any lifecycle or sync-state mutation, in the
   * documented connection-before-work order, under the same five-second transaction-local lock
   * timeout as every finance operation. A signed stale health event therefore observes a concurrent
   * disconnect, suspension, or newer generation/version and never overwrites it, and lock
   * contention fails fast as the shared generic 503 instead of waiting indefinitely. An unknown
   * Item still commits its fingerprint and returns 200 without revealing existence.
   */
  public void admit(VerifiedEvent event, byte[] originalBody, String signatureHeader) {
    try {
      transactions.execute(
          status -> {
            entityManager.createNativeQuery("SET LOCAL lock_timeout = '5s'").executeUpdate();
            Instant now = Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
            events.reserve(
                UUID.randomUUID(),
                adapter.providerName(),
                properties.environmentToken(),
                ConnectionCrypto.sha256Hex(signatureHeader),
                sha256Hex(originalBody),
                now);
            if (event.remoteItemId() == null) {
              return null;
            }
            String digest =
                ConnectionCrypto.sha256Hex(
                    adapter.providerName()
                        + "\0"
                        + properties.environmentToken()
                        + "\0"
                        + event.remoteItemId());
            FinancialConnectionEntity connection =
                connections
                    .findDigestForUpdate(
                        adapter.providerName(), properties.environmentToken(), digest)
                    .orElse(null);
            if (connection == null) {
              return null;
            }
            route(connection, event, now);
            return null;
          });
    } catch (DataAccessException outage) {
      throw new WebhookUnavailableException();
    }
  }

  /** Webhook replay fingerprints expire after 24 hours; bounded batches keep the sweep cheap. */
  @Scheduled(fixedDelayString = "${app.connected-finance.sync-scrub-ms:600000}")
  public void scrubExpiredWebhookEvents() {
    if (!properties.isEnabled()) {
      return;
    }
    transactions.execute(
        status -> {
          Instant threshold = now().minus(REPLAY_TTL);
          List<ProviderWebhookEventEntity> expired =
              events.findExpired(threshold, PageRequest.of(0, 200));
          if (!expired.isEmpty()) {
            events.deleteByIds(expired.stream().map(ProviderWebhookEventEntity::getId).toList());
          }
          return null;
        });
  }

  private void route(FinancialConnectionEntity connection, VerifiedEvent event, Instant now) {
    switch (event.webhookType()) {
      case "TRANSACTIONS" -> {
        if ("SYNC_UPDATES_AVAILABLE".equals(event.webhookCode())) {
          demands.demand(connection.getId(), now);
        }
        // Legacy TRANSACTIONS codes (DEFAULT_UPDATE, HISTORICAL_UPDATE, TRANSACTIONS_REMOVED)
        // deliberately apply no ledger deltas.
      }
      case "ITEM" -> {
        if ("ITEM_LOGIN_REQUIRED".equals(event.errorCode())) {
          fenceIfActive(connection, "REAUTH_REQUIRED", now);
        }
        // Any other ITEM error is left to the fetch path; a signed event never reactivates.
      }
      case "USER_PERMISSION_REVOKED", "PENDING_DISCONNECT" -> {
        // Consent is gone: stop imports, fence generation, and queue durable remote cleanup.
        if (!"DISCONNECTED".equals(connection.getState())) {
          fenceIfVersionAvailable(connection, "SUSPENDED", now);
          queueRevocation(connection.getId(), now);
          coalesceSyncWork(connection.getId(), now);
        }
      }
      default -> {
        // Unknown or irrelevant verified event: fingerprint committed, no action, 200.
      }
    }
  }

  private void fenceIfActive(FinancialConnectionEntity connection, String nextState, Instant now) {
    if (!"ACTIVE".equals(connection.getState())) {
      return;
    }
    fenceIfVersionAvailable(connection, nextState, now);
    coalesceSyncWork(connection.getId(), now);
  }

  private void fenceIfVersionAvailable(
      FinancialConnectionEntity connection, String nextState, Instant now) {
    if (connection.getVersion() == Integer.MAX_VALUE) {
      // An exhausted lifecycle counter must not turn a webhook into a 500; the connection is
      // already unusable and the next worker round fails closed.
      return;
    }
    connection.fence(nextState, now);
  }

  /**
   * Releases any running lease and preserves one queued demand. The worker re-checks ACTIVE before
   * any fetch, so a health event never fetches now and never loses a later wake-up. Called with the
   * connection row already locked, in the connection-before-work order.
   */
  private void coalesceSyncWork(UUID connectionId, Instant now) {
    syncWork
        .findByConnectionIdForUpdate(connectionId)
        .ifPresent(
            work -> {
              if ("RUNNING".equals(work.getState())) {
                work.releaseLease(now);
              }
              if (!"QUEUED".equals(work.getState())) {
                work.demand(now);
              }
            });
  }

  private static String sha256Hex(byte[] value) {
    try {
      return java.util.HexFormat.of()
          .formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(value));
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is required by the Java platform", impossible);
    }
  }

  private Instant now() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  private void queueRevocation(UUID connectionId, Instant now) {
    revocations.save(new ConnectionRevocationWorkEntity(UUID.randomUUID(), connectionId, now));
    revocations.flush();
  }
}
