package com.housesync.household.invitation.application;

import com.housesync.household.application.HouseholdService;
import com.housesync.household.domain.MemberRole;
import com.housesync.household.invitation.persistence.InvitationEntity;
import com.housesync.household.invitation.persistence.InvitationRepository;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationForbiddenException;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationNotFoundException;
import com.housesync.household.invitation.web.InvitationExceptions.InvitationServiceException;
import com.housesync.household.invitation.web.InvitationResponses.InvitationCreatedResponse;
import com.housesync.household.invitation.web.InvitationResponses.InvitationPreviewResponse;
import com.housesync.household.invitation.web.InvitationResponses.InvitationSummary;
import com.housesync.household.persistence.HouseholdEntity;
import com.housesync.household.persistence.HouseholdMemberRepository;
import com.housesync.household.persistence.HouseholdRepository;
import com.housesync.household.web.HouseholdExceptions.HouseholdNotFoundException;
import com.housesync.household.web.HouseholdResponse;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Invitation use cases.
 *
 * <p>The actor always comes from the authenticated {@code HouseSyncUserDetails} UUID; the household
 * comes from the owner-authorized route during creation and revocation, and from the invitation
 * itself during preview and acceptance. Owner authorization resolves current membership on every
 * operation: missing and non-member households share the generic household 404, while a current
 * non-owner member receives 403. Capability misses (wrong secret, missing record, expiry,
 * revocation, or consumption by another actor) share one generic invitation 404 that reveals no
 * household metadata.
 */
@Service
public class InvitationService {

  /** Invitation lifetime: exactly 168 hours after creation. */
  public static final Duration INVITATION_TTL = Duration.ofHours(168);

  private final InvitationRepository invitations;
  private final HouseholdRepository households;
  private final HouseholdMemberRepository memberships;
  private final JdbcTemplate jdbc;
  private final TransactionTemplate attempts;
  private final Clock clock;

  public InvitationService(
      InvitationRepository invitations,
      HouseholdRepository households,
      HouseholdMemberRepository memberships,
      JdbcTemplate jdbc,
      PlatformTransactionManager transactions,
      Clock clock) {
    this.invitations = invitations;
    this.households = households;
    this.memberships = memberships;
    this.jdbc = jdbc;
    this.attempts = new TransactionTemplate(transactions);
    this.attempts.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    this.clock = clock;
  }

  /**
   * Creates one independent invitation for an owner-authorized household. The raw secret is
   * returned once and never persisted; only its SHA-256 digest is stored. Owner authorization runs
   * inside the insert transaction under the household lifecycle lock, so a demotion that completes
   * first denies the stale owner before any row is written. A digest collision triggers one
   * server-side regeneration attempt, then a safe failure. Each attempt runs in its own transaction
   * because PostgreSQL aborts the enclosing transaction on a unique violation, so a retry inside
   * the same transaction could never succeed.
   */
  public InvitationCreatedResponse create(UUID householdId, UUID actorId) {
    Instant createdAt = microsNow();
    Instant expiresAt = createdAt.plus(INVITATION_TTL);
    for (int attempt = 0; attempt < 2; attempt++) {
      UUID id = UUID.randomUUID();
      String secret = newSecret();
      byte[] digest = InvitationSecrets.sha256(InvitationSecrets.decodeStrict(secret));
      try {
        attempts.executeWithoutResult(
            status -> {
              authorizeOwner(householdId, actorId);
              jdbc.update(
                  "INSERT INTO household_invitations"
                      + " (id, household_id, created_by_user_id, secret_hash, created_at,"
                      + " expires_at)"
                      + " VALUES (?, ?, ?, ?, ?, ?)",
                  id,
                  householdId,
                  actorId,
                  digest,
                  Timestamp.from(createdAt),
                  Timestamp.from(expiresAt));
            });
        return new InvitationCreatedResponse(id, secret, createdAt, expiresAt);
      } catch (DuplicateKeyException collision) {
        if (attempt == 1) {
          throw new InvitationServiceException(collision);
        }
      }
    }
    throw new InvitationServiceException();
  }

  /**
   * Lists the active invitations of an owner-authorized household, ordered by creation then ID.
   * Owner authorization takes the household lifecycle lock before reading, so a demotion that
   * commits first denies the stale owner's list result.
   */
  @Transactional
  public List<InvitationSummary> listActive(UUID householdId, UUID actorId) {
    authorizeOwner(householdId, actorId);
    return invitations.findActiveByHousehold(householdId, microsNow()).stream()
        .map(
            invitation ->
                new InvitationSummary(
                    invitation.getId(), invitation.getCreatedAt(), invitation.getExpiresAt()))
        .toList();
  }

  /**
   * Revokes an active invitation. Owner authorization takes the household lifecycle lock before the
   * invitation row lock, serializing revocation with membership mutations. Revoking an
   * already-revoked row is a successful no-op; accepted, expired, missing, and wrong-household IDs
   * are the generic invitation 404 after path household authorization.
   */
  @Transactional
  public void revoke(UUID householdId, UUID invitationId, UUID actorId) {
    authorizeOwner(householdId, actorId);
    InvitationEntity invitation =
        invitations.findByIdForUpdate(invitationId).orElseThrow(InvitationNotFoundException::new);
    if (!invitation.getHouseholdId().equals(householdId) || invitation.getAcceptedAt() != null) {
      throw new InvitationNotFoundException();
    }
    if (invitation.getRevokedAt() != null) {
      return;
    }
    if (!microsNow().isBefore(invitation.getExpiresAt())) {
      throw new InvitationNotFoundException();
    }
    invitation.setRevokedAt(microsNow());
    invitations.save(invitation);
  }

  /**
   * Previews an active invitation. Reads by invitation ID and compares the secret digest; it never
   * loads a household first. Only active rows reveal the household name, resulting role, and
   * expiry.
   */
  @Transactional(readOnly = true)
  public InvitationPreviewResponse preview(String invitationId, String secret) {
    InvitationEntity invitation = loadActive(CapabilityCredential.parse(invitationId, secret));
    HouseholdEntity household =
        households
            .findById(invitation.getHouseholdId())
            .orElseThrow(InvitationNotFoundException::new);
    return new InvitationPreviewResponse(
        household.getName(), MemberRole.MEMBER.name(), invitation.getExpiresAt());
  }

  /**
   * Accepts an invitation in one row-locked transaction: inserts the actor's {@code MEMBER} row
   * when absent with database-backed conflict handling, then records the accepting actor. An
   * already-member actor still consumes the invitation and receives their current role. A replay by
   * the recorded accepting actor returns the current membership-scoped household only while that
   * actor remains a member; it never recreates removed membership.
   */
  @Transactional
  public HouseholdResponse accept(String invitationId, String secret, UUID actorId) {
    CapabilityCredential credential = CapabilityCredential.parse(invitationId, secret);
    InvitationEntity invitation =
        invitations
            .findByIdForUpdate(credential.invitationId())
            .orElseThrow(InvitationNotFoundException::new);
    if (!InvitationSecrets.digestEquals(
        invitation.getSecretHash(), InvitationSecrets.sha256(credential.rawSecret()))) {
      throw new InvitationNotFoundException();
    }
    if (actorId.equals(invitation.getAcceptedByUserId())) {
      return memberships
          .findScopedByHouseholdAndActor(invitation.getHouseholdId(), actorId)
          .map(HouseholdService::toResponse)
          .orElseThrow(InvitationNotFoundException::new);
    }
    if (invitation.getAcceptedAt() != null
        || invitation.getRevokedAt() != null
        || !microsNow().isBefore(invitation.getExpiresAt())) {
      throw new InvitationNotFoundException();
    }
    // Serialize with operator disable even if this request passed the session guard earlier.
    // Otherwise a late invitation write could leave membership on a disabled account.
    var enabled =
        jdbc.query(
            "SELECT NOT access_disabled FROM users WHERE id = ? FOR SHARE",
            (rs, row) -> rs.getBoolean(1),
            actorId);
    if (enabled.size() != 1 || !enabled.getFirst()) {
      throw new InvitationForbiddenException();
    }
    jdbc.update(
        "INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'MEMBER')"
            + " ON CONFLICT DO NOTHING",
        invitation.getHouseholdId(),
        actorId);
    Instant acceptedAt = microsNow();
    invitation.setAcceptedAt(acceptedAt);
    invitation.setAcceptedByUserId(actorId);
    invitations.save(invitation);
    return memberships
        .findScopedByHouseholdAndActor(invitation.getHouseholdId(), actorId)
        .map(HouseholdService::toResponse)
        .orElseThrow(InvitationServiceException::new);
  }

  /**
   * Loads the invitation for a validated credential and requires the active state. Every miss —
   * missing record, wrong secret, revocation, prior consumption, or expiry — is the same generic
   * 404.
   */
  private InvitationEntity loadActive(CapabilityCredential credential) {
    InvitationEntity invitation =
        invitations
            .findById(credential.invitationId())
            .orElseThrow(InvitationNotFoundException::new);
    if (!InvitationSecrets.digestEquals(
        invitation.getSecretHash(), InvitationSecrets.sha256(credential.rawSecret()))) {
      throw new InvitationNotFoundException();
    }
    if (invitation.getAcceptedAt() != null
        || invitation.getRevokedAt() != null
        || !microsNow().isBefore(invitation.getExpiresAt())) {
      throw new InvitationNotFoundException();
    }
    return invitation;
  }

  /**
   * Admits only current members through a non-locking membership-scoped read, then resolves the
   * path household under the shared lifecycle household write lock and re-reads membership under
   * it. Missing and non-member households share the generic 404 without ever queueing on the lock;
   * a current non-owner member receives 403. The lock serializes owner-authorized invitation writes
   * with membership mutations: a demotion that completes first denies the stale owner before this
   * write commits.
   */
  private void authorizeOwner(UUID householdId, UUID actorId) {
    memberships
        .findScopedByHouseholdAndActor(householdId, actorId)
        .orElseThrow(HouseholdNotFoundException::new);
    households.findByIdForUpdate(householdId).orElseThrow(HouseholdNotFoundException::new);
    MemberRole role =
        memberships
            .findScopedByHouseholdAndActor(householdId, actorId)
            .orElseThrow(HouseholdNotFoundException::new)
            .role();
    if (role != MemberRole.OWNER) {
      throw new InvitationForbiddenException();
    }
  }

  private Instant microsNow() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  /**
   * Generates one candidate secret. A separate method so tests can script digest collisions
   * deterministically; production always uses fresh secure random bytes.
   */
  protected String newSecret() {
    return InvitationSecrets.generate();
  }
}
