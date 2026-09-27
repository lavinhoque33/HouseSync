package com.housesync.identity.application;

import com.housesync.identity.domain.EmailPolicy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Host-operator bearer grants. Raw secrets exist only in the issue result and consuming request.
 */
@Service
public class IdentityGrants {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final Duration LIFETIME = Duration.ofHours(24);
  private final JdbcTemplate jdbc;
  private final Clock clock;

  public IdentityGrants(JdbcTemplate jdbc, Clock clock) {
    this.jdbc = jdbc;
    this.clock = clock;
  }

  public record Issued(UUID id, String code, Instant expiresAt) {}

  @Transactional
  public Issued issue(String kind, String email) {
    if (!kind.equals("ENROLLMENT") && !kind.equals("RECOVERY")) {
      throw new IllegalArgumentException("Unknown grant kind.");
    }
    if (EmailPolicy.violation(email).isPresent()) {
      throw new IllegalArgumentException("Invalid recipient email.");
    }
    String canonical = EmailPolicy.normalize(email);
    List<UUID> users =
        jdbc.query(
            "SELECT id FROM users WHERE email = ? AND access_disabled = FALSE",
            (rs, n) -> rs.getObject(1, UUID.class),
            canonical);
    if ((kind.equals("RECOVERY") && users.size() != 1)
        || (kind.equals("ENROLLMENT") && !users.isEmpty())) {
      throw new IllegalArgumentException("Recipient is not eligible for this grant.");
    }
    if (kind.equals("ENROLLMENT")
        && Boolean.TRUE.equals(
            jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM users WHERE email = ?)", Boolean.class, canonical))) {
      throw new IllegalArgumentException("Recipient is not eligible for this grant.");
    }
    byte[] secret = new byte[32];
    RANDOM.nextBytes(secret);
    String code = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
    UUID id = UUID.randomUUID();
    Instant now = clock.instant();
    Instant expires = now.plus(LIFETIME);
    jdbc.update(
        "INSERT INTO identity_grants (id, kind, recipient_email, user_id, token_digest, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        kind,
        canonical,
        users.isEmpty() ? null : users.getFirst(),
        digest(code),
        jdbcTime(now),
        jdbcTime(expires));
    audit(id, "ISSUED", "operator:self");
    return new Issued(id, code, expires);
  }

  @Transactional
  public boolean revoke(UUID id) {
    int changed =
        jdbc.update(
            "UPDATE identity_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND consumed_at IS NULL",
            jdbcTime(clock.instant()),
            id);
    if (changed == 1) audit(id, "REVOKED", "operator:self");
    return changed == 1;
  }

  /**
   * Row locking serializes concurrent consumers; consumption and account mutation share one
   * transaction.
   */
  @Transactional
  public boolean consume(String kind, String email, String code) {
    if (code == null
        || !code.matches("[A-Za-z0-9_-]{43}")
        || EmailPolicy.violation(email).isPresent()) return false;
    String canonical = EmailPolicy.normalize(email);
    List<Grant> grants =
        jdbc.query(
            "SELECT id, user_id FROM identity_grants WHERE token_digest = ? AND kind = ? AND recipient_email = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ? FOR UPDATE",
            (rs, n) -> new Grant(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)),
            digest(code),
            kind,
            canonical,
            jdbcTime(clock.instant()));
    if (grants.isEmpty()) return false;
    Grant grant = grants.getFirst();
    if (kind.equals("RECOVERY")) {
      List<UUID> current =
          jdbc.query(
              "SELECT id FROM users WHERE id = ? AND email = ? AND access_disabled = FALSE",
              (rs, n) -> rs.getObject(1, UUID.class),
              grant.userId(),
              canonical);
      if (current.isEmpty()) return false;
    }
    jdbc.update(
        "UPDATE identity_grants SET consumed_at = ? WHERE id = ?",
        jdbcTime(clock.instant()),
        grant.id());
    audit(grant.id(), "CONSUMED", "recipient");
    return true;
  }

  private void audit(UUID id, String action, String actor) {
    jdbc.update(
        "INSERT INTO identity_grant_audit (id, grant_id, action, occurred_at, actor) VALUES (?, ?, ?, ?, ?)",
        UUID.randomUUID(),
        id,
        action,
        jdbcTime(clock.instant()),
        actor);
  }

  private static OffsetDateTime jdbcTime(Instant instant) {
    return instant.atOffset(ZoneOffset.UTC);
  }

  private static byte[] digest(String code) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(code.getBytes(StandardCharsets.US_ASCII));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  private record Grant(UUID id, UUID userId) {}
}
