package com.housesync.finance.categorization.application;

import com.housesync.finance.account.persistence.FinancialAccountRepository;
import com.housesync.finance.categorization.domain.CategorizationOrigin;
import com.housesync.finance.categorization.domain.RuleTextNormalizer;
import com.housesync.finance.categorization.persistence.CategorizationReviewEntity;
import com.housesync.finance.categorization.persistence.CategorizationReviewRepository;
import com.housesync.finance.transaction.domain.TransactionKind;
import com.housesync.finance.transaction.domain.TransactionStatus;
import com.housesync.finance.transaction.persistence.FinancialTransactionEntity;
import com.housesync.finance.transaction.persistence.FinancialTransactionRepository;
import com.housesync.household.application.HouseholdService;
import com.housesync.household.persistence.HouseholdRepository;
import jakarta.persistence.EntityManager;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Transactional enqueue and fenced completion. Claim runs in its own short transaction. */
@Service
public class CategorizationAiWorkService {
  public record Status(boolean enabled, long pendingCount, long failedCount) {}

  public record Work(
      UUID id,
      UUID household,
      UUID owner,
      UUID transaction,
      int version,
      String evidence,
      String policy,
      long fence) {}

  private record ProviderCodes(String fingerprint, String primary, String detail) {}

  private static final ProviderCodes NO_PROVIDER_CODES = new ProviderCodes(null, null, null);

  private final boolean enabled;
  private final String policy;
  private final JdbcTemplate db;
  private final Clock clock;
  private final HouseholdService households;
  private final HouseholdRepository householdRows;
  private final FinancialTransactionRepository transactions;
  private final CategorizationReviewRepository reviews;
  private final FinancialAccountRepository accounts;
  private final EntityManager entityManager;

  public CategorizationAiWorkService(
      @Value("${app.categorization-ai.enabled:false}") boolean enabled,
      @Value("${app.categorization-ai.policy:}") String policy,
      @Value("${app.categorization-ai.model:}") String model,
      @Value("${app.categorization-ai.key:}") String key,
      JdbcTemplate db,
      Clock clock,
      HouseholdService households,
      FinancialAccountRepository accounts,
      FinancialTransactionRepository transactions,
      CategorizationReviewRepository reviews,
      EntityManager entityManager,
      HouseholdRepository householdRows) {
    if (enabled
        && (policy == null
            || !policy.matches("[A-Za-z0-9_.-]{1,32}")
            || model == null
            || model.isBlank()
            || model.length() > 100
            || key == null
            || key.isBlank()))
      throw new IllegalArgumentException(
          "AI configuration requires a bounded policy, model and key");
    this.enabled = enabled;
    this.policy = enabled ? reviewPolicy(model, policy) : "";
    this.db = db;
    this.clock = clock;
    this.households = households;
    this.accounts = accounts;
    this.transactions = transactions;
    this.reviews = reviews;
    this.entityManager = entityManager;
    this.householdRows = householdRows;
  }

  public boolean enabled() {
    return enabled;
  }

  /** V17 permits at most 32 characters; bind review identity to both model and policy. */
  static String reviewPolicy(String model, String policy) {
    return sha(model + "\0" + policy).substring(0, 32);
  }

  static String fingerprint(
      FinancialTransactionEntity entry, String providerEvidence, String policy) {
    return sha(
        entry.getKind() + "\0" + entry.getDescription() + "\0" + providerEvidence + "\0" + policy);
  }

  private static String sha(String input) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public void enqueue(FinancialTransactionEntity entry, String providerEvidence) {
    if (!enabled
        || entry.getCategoryOrigin() != CategorizationOrigin.NONE
        || entry.getStatus() != TransactionStatus.POSTED
        || entry.getKind() == TransactionKind.REFUND
        || RuleTextNormalizer.normalize(entry.getDescription()).isEmpty()) return;
    // Unique key preserves resolved work and prevents replays from reopening the same revision.
    entityManager.flush(); // JDBC foreign key must see the newly created JPA ledger row.
    Instant now = Instant.now(clock);
    db.update(
        "INSERT INTO categorization_ai_work (id,household_id,owner_user_id,transaction_id,transaction_version,evidence_fingerprint,policy_version,state,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'QUEUED',?,?,?) ON CONFLICT (transaction_id,transaction_version,evidence_fingerprint,policy_version) DO NOTHING",
        UUID.randomUUID(),
        entry.getHouseholdId(),
        entry.getOwnerUserId(),
        entry.getId(),
        entry.getVersion(),
        fingerprint(entry, providerEvidence, policy),
        policy,
        java.sql.Timestamp.from(now),
        java.sql.Timestamp.from(now),
        java.sql.Timestamp.from(now));
  }

  @Transactional(readOnly = true)
  public Status status(UUID household, UUID owner) {
    households.requireFinanceMembership(household, owner);
    if (!enabled) return new Status(false, 0, 0);
    // A failed attempt is actionable only while its entry still needs a suggestion. Keep
    // historical work for diagnosis without telling an owner to choose a category they already
    // chose. Multiple evidence revisions count as one entry: only the newest work is current.
    return db.queryForObject(
        """
        SELECT count(*) FILTER (WHERE latest.state IN ('QUEUED','RUNNING','RETRY_WAIT')),
               count(*) FILTER (WHERE latest.state = 'FAILED')
        FROM (
          SELECT DISTINCT ON (w.transaction_id) w.state
          FROM categorization_ai_work w
          JOIN financial_transactions t ON t.id = w.transaction_id
            AND t.household_id = w.household_id AND t.owner_user_id = w.owner_user_id
          JOIN household_members m ON m.household_id = w.household_id
            AND m.user_id = w.owner_user_id
          WHERE w.household_id = ? AND w.owner_user_id = ? AND w.policy_version = ?
            AND t.status = 'POSTED' AND t.kind <> 'REFUND'
            AND t.category_origin = 'NONE' AND t.version = w.transaction_version
          ORDER BY w.transaction_id, w.created_at DESC, w.id DESC
        ) latest
        """,
        (rs, row) -> new Status(true, rs.getLong(1), rs.getLong(2)),
        household,
        owner,
        policy);
  }

  @Transactional
  public Work claim() {
    // A crashed final attempt becomes terminal; old fences cannot commit afterwards.
    db.update(
        "UPDATE categorization_ai_work SET state='FAILED',lease_until=NULL,updated_at=now() WHERE state='RUNNING' AND lease_until <= now() AND attempts >= 3");
    List<Work> found =
        db.query(
            "WITH due AS (SELECT id FROM categorization_ai_work WHERE attempts < 3 AND ((state IN ('QUEUED','RETRY_WAIT') AND due_at <= now()) OR (state='RUNNING' AND lease_until <= now())) ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE categorization_ai_work w SET state='RUNNING',attempts=w.attempts+1,fence=w.fence+1,lease_until=now()+interval '30 seconds',updated_at=now() FROM due WHERE w.id=due.id RETURNING w.id,w.household_id,w.owner_user_id,w.transaction_id,w.transaction_version,w.evidence_fingerprint,w.policy_version,w.fence",
            (rs, row) ->
                new Work(
                    rs.getObject(1, UUID.class),
                    rs.getObject(2, UUID.class),
                    rs.getObject(3, UUID.class),
                    rs.getObject(4, UUID.class),
                    rs.getInt(5),
                    rs.getString(6),
                    rs.getString(7),
                    rs.getLong(8)));
    return found.isEmpty() ? null : found.getFirst();
  }

  /**
   * Preflight is read-only and never holds a transaction across HTTP. Completion repeats all
   * checks.
   */
  @Transactional(readOnly = true)
  public CategorizationAiProvider.Evidence evidence(Work work) {
    var entry =
        transactions
            .findOwnedScoped(work.household(), work.transaction(), work.owner())
            .orElse(null);
    if (entry == null || !eligible(entry, work)) return null;
    var codes = providerCodes(entry);
    if (codes == null || !fingerprint(entry, codes.fingerprint(), policy).equals(work.evidence()))
      return null;
    return RuleTextNormalizer.normalize(entry.getDescription())
        .map(
            description ->
                new CategorizationAiProvider.Evidence(
                    description, entry.getKind(), codes.primary(), codes.detail()))
        .orElse(null);
  }

  /**
   * Serializes membership then canonical account/ledger then work/review, never work then ledger.
   */
  @Transactional
  public void finish(Work work, CategorizationAiProvider.Candidate candidate, boolean retry) {
    entityManager.createNativeQuery("SET LOCAL lock_timeout = '5s'").executeUpdate();
    // The household lifecycle lock serializes removal before we inspect current membership.
    // Missing membership is not an exception: safely settle retained work as STALE.
    householdRows.findByIdForUpdate(work.household()).orElseThrow();
    Integer member =
        db.queryForObject(
            "SELECT count(*) FROM household_members WHERE household_id=? AND user_id=?",
            Integer.class,
            work.household(),
            work.owner());
    if (member == 0) {
      fencedState(work, "STALE", false);
      return;
    }
    FinancialTransactionEntity peek =
        transactions
            .findOwnedScoped(work.household(), work.transaction(), work.owner())
            .orElse(null);
    if (peek == null) {
      fencedState(work, "STALE", false);
      return;
    }
    accounts.findOwnedForUpdate(work.household(), peek.getAccountId(), work.owner()).orElseThrow();
    FinancialTransactionEntity entry =
        transactions
            .findOwnedForUpdate(work.household(), work.transaction(), work.owner())
            .orElseThrow();
    entityManager.refresh(entry);
    // Lock work only after ledger, since enqueue holds ledger before work.
    Long current =
        db.query(
            "SELECT fence FROM categorization_ai_work WHERE id=? AND state='RUNNING' AND lease_until > now() FOR UPDATE",
            rs -> rs.next() ? rs.getLong(1) : null,
            work.id());
    if (current == null || current != work.fence()) return;
    ProviderCodes codes = providerCodes(entry);
    if (!eligible(entry, work)
        || codes == null
        || !fingerprint(entry, codes.fingerprint(), policy).equals(work.evidence())) {
      fencedState(work, "STALE", false);
      return;
    }
    if (candidate == null) {
      fencedState(work, retry && attempts(work.id()) < 3 ? "RETRY_WAIT" : "FAILED", true);
      return;
    }
    String fingerprint = work.evidence();
    var existing =
        reviews.findOwnedEvidence(
            work.household(), work.owner(), work.transaction(), "AI", policy, fingerprint);
    if (existing.isEmpty()) {
      var open = reviews.findOwnedOpen(work.household(), work.owner(), work.transaction());
      open.ifPresent(item -> item.close("SUPERSEDED", Instant.now(clock)));
      if (open.isPresent()) reviews.flush();
      reviews.saveAndFlush(
          new CategorizationReviewEntity(
              UUID.randomUUID(),
              work.household(),
              work.owner(),
              work.transaction(),
              candidate.category(),
              "AI",
              candidate.confidence(),
              candidate.reasonCode(),
              policy,
              fingerprint,
              work.version(),
              Instant.now(clock)));
    }
    fencedState(work, "SUCCEEDED", false);
  }

  private boolean eligible(FinancialTransactionEntity entry, Work work) {
    return policy.equals(work.policy())
        && entry.getVersion() == work.version()
        && entry.getStatus() == TransactionStatus.POSTED
        && entry.getKind() != TransactionKind.REFUND
        && entry.getCategoryOrigin() == CategorizationOrigin.NONE
        && entry.getHouseholdId().equals(work.household())
        && entry.getOwnerUserId().equals(work.owner());
  }

  private ProviderCodes providerCodes(FinancialTransactionEntity entry) {
    if (!"CONNECTED".equals(entry.getSource())) return NO_PROVIDER_CODES;
    @SuppressWarnings("unchecked")
    List<Object[]> rows =
        entityManager
            .createNativeQuery(
                "SELECT o.categorization_evidence_fingerprint,o.pfc_primary_code,o.pfc_detail_code FROM connection_ledger_associations a JOIN connection_observations o ON o.id=a.observation_id AND o.household_id=a.household_id AND o.owner_user_id=a.owner_user_id JOIN household_members m ON m.household_id=a.household_id AND m.user_id=a.owner_user_id WHERE a.transaction_id=:transaction AND a.household_id=:household AND a.owner_user_id=:owner AND a.state='CURRENT' AND o.state='POSTED'")
            .setParameter("transaction", entry.getId())
            .setParameter("household", entry.getHouseholdId())
            .setParameter("owner", entry.getOwnerUserId())
            .getResultList();
    if (rows.size() != 1) return null;
    Object[] row = rows.getFirst();
    return new ProviderCodes((String) row[0], (String) row[1], (String) row[2]);
  }

  private int attempts(UUID id) {
    return db.queryForObject(
        "SELECT attempts FROM categorization_ai_work WHERE id=?", Integer.class, id);
  }

  private void fencedState(Work work, String state, boolean failure) {
    Instant due =
        failure && "RETRY_WAIT".equals(state)
            ? Instant.now(clock).plusSeconds(1L << attempts(work.id()))
            : Instant.now(clock);
    db.update(
        "UPDATE categorization_ai_work SET state=?,lease_until=NULL,due_at=?,updated_at=now() WHERE id=? AND fence=? AND state='RUNNING' AND lease_until > now()",
        state,
        java.sql.Timestamp.from(due),
        work.id(),
        work.fence());
  }
}
