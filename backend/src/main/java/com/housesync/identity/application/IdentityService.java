package com.housesync.identity.application;

import com.housesync.identity.domain.EmailPolicy;
import com.housesync.identity.domain.PasswordPolicy;
import com.housesync.identity.persistence.UserRepository;
import com.housesync.identity.web.IdentityExceptions;
import com.housesync.identity.web.SafeUserResponse;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Operator-gated enrollment and recovery, password changes, identity resolution and revocation.
 * Grant consumption and its account mutation share a transaction. Registration never signs the user
 * in; the uniqueness constraint remains authoritative for concurrent enrollment attempts.
 */
@Service
public class IdentityService {

  private final UserRepository users;
  private final PasswordEncoder passwordEncoder;
  private final Clock clock;
  private final IdentityGrants grants;
  private final JdbcTemplate jdbc;

  public IdentityService(
      UserRepository users,
      PasswordEncoder passwordEncoder,
      Clock clock,
      IdentityGrants grants,
      JdbcTemplate jdbc) {
    this.users = users;
    this.passwordEncoder = passwordEncoder;
    this.clock = clock;
    this.grants = grants;
    this.jdbc = jdbc;
  }

  @Transactional
  public SafeUserResponse register(String rawEmail, String password, String enrollmentCode) {
    if (!grants.consume("ENROLLMENT", rawEmail, enrollmentCode)) {
      throw new IdentityExceptions.EnrollmentInvalidException();
    }
    Map<String, String> fieldErrors = new LinkedHashMap<>();
    EmailPolicy.violation(rawEmail).ifPresent(message -> fieldErrors.put("email", message));
    PasswordPolicy.registrationViolation(password)
        .ifPresent(message -> fieldErrors.put("password", message));
    if (!fieldErrors.isEmpty()) {
      throw new IdentityExceptions.ValidationFailedException(fieldErrors);
    }
    String canonical = EmailPolicy.normalize(rawEmail);
    if (users.existsByEmail(canonical)) {
      throw new IdentityExceptions.RegistrationConflictException();
    }
    UUID id = UUID.randomUUID();
    int inserted =
        users.insertIgnoreConflict(
            id, canonical, passwordEncoder.encode(password), Instant.now(clock));
    if (inserted == 0) {
      throw new IdentityExceptions.RegistrationConflictException();
    }
    return new SafeUserResponse(id, canonical);
  }

  @Transactional
  public void recover(String email, String code, String newPassword) {
    if (!grants.consume("RECOVERY", email, code)) {
      throw new IdentityExceptions.RecoveryInvalidException();
    }
    PasswordPolicy.registrationViolation(newPassword)
        .ifPresent(
            message -> {
              throw new IdentityExceptions.ValidationFailedException(
                  Map.of("newPassword", message));
            });
    String canonical = EmailPolicy.normalize(email);
    jdbc.update(
        "UPDATE users SET password_hash = ?, session_generation = session_generation + 1 WHERE email = ?",
        passwordEncoder.encode(newPassword),
        canonical);
    revokeSessions(canonical);
  }

  @Transactional
  public void changePassword(UUID id, String currentPassword, String newPassword) {
    var user = users.findById(id).orElseThrow(IdentityExceptions.UnauthenticatedException::new);
    if (PasswordPolicy.loginViolation(currentPassword).isPresent()
        || !passwordEncoder.matches(currentPassword, user.getPasswordHash())) {
      throw new IdentityExceptions.InvalidCredentialsException();
    }
    PasswordPolicy.registrationViolation(newPassword)
        .ifPresent(
            message -> {
              throw new IdentityExceptions.ValidationFailedException(
                  Map.of("newPassword", message));
            });
    jdbc.update(
        "UPDATE users SET password_hash = ?, session_generation = session_generation + 1 WHERE id = ?",
        passwordEncoder.encode(newPassword),
        id);
    revokeSessions(user.getEmail());
  }

  @Transactional
  public void revokeSessions(UUID id) {
    var user = users.findById(id).orElseThrow(IdentityExceptions.UnauthenticatedException::new);
    jdbc.update("UPDATE users SET session_generation = session_generation + 1 WHERE id = ?", id);
    revokeSessions(user.getEmail());
  }

  private void revokeSessions(String canonicalEmail) {
    jdbc.update("DELETE FROM SPRING_SESSION WHERE PRINCIPAL_NAME = ?", canonicalEmail);
  }

  @Transactional
  public void disableAccess(String email) {
    if (EmailPolicy.violation(email).isPresent())
      throw new IllegalArgumentException("Invalid account email.");
    String canonical = EmailPolicy.normalize(email);
    var ids =
        jdbc.query(
            "SELECT id FROM users WHERE email = ? AND access_disabled = FALSE FOR UPDATE",
            (rs, n) -> rs.getObject(1, UUID.class),
            canonical);
    if (ids.isEmpty()) throw new IllegalArgumentException("Account not available for departure.");
    UUID id = ids.getFirst();
    if (Boolean.TRUE.equals(
        jdbc.queryForObject(
            "SELECT EXISTS (SELECT 1 FROM household_members WHERE user_id = ?)",
            Boolean.class,
            id))) {
      throw new IllegalArgumentException(
          "Remove all household memberships before disabling access.");
    }
    var now = clock.instant().atOffset(ZoneOffset.UTC);
    jdbc.update(
        "UPDATE users SET access_disabled = TRUE, session_generation = session_generation + 1 WHERE id = ?",
        id);
    jdbc.update(
        "INSERT INTO identity_grant_audit (id, grant_id, action, occurred_at, actor) "
            + "SELECT gen_random_uuid(), id, 'REVOKED', ?, 'operator:self' FROM identity_grants "
            + "WHERE recipient_email = ? AND revoked_at IS NULL AND consumed_at IS NULL",
        now,
        canonical);
    jdbc.update(
        "UPDATE identity_grants SET revoked_at = ? WHERE recipient_email = ? AND revoked_at IS NULL AND consumed_at IS NULL",
        now,
        canonical);
    revokeSessions(canonical);
    jdbc.update(
        "INSERT INTO identity_account_audit (id, user_id, action, occurred_at, actor) VALUES (?, ?, 'DISABLED', ?, 'operator:self')",
        UUID.randomUUID(),
        id,
        now);
  }

  @Transactional(readOnly = true)
  public SafeUserResponse resolve(UUID id) {
    return users
        .findById(id)
        .filter(entity -> !entity.isAccessDisabled())
        .map(entity -> new SafeUserResponse(entity.getId(), entity.getEmail()))
        .orElseThrow(IdentityExceptions.UnauthenticatedException::new);
  }
}
