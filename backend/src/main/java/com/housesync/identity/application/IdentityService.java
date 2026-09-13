package com.housesync.identity.application;

import com.housesync.identity.domain.EmailPolicy;
import com.housesync.identity.domain.PasswordPolicy;
import com.housesync.identity.persistence.UserRepository;
import com.housesync.identity.web.IdentityExceptions;
import com.housesync.identity.web.SafeUserResponse;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Registration and identity-resolution use cases.
 *
 * <p>Registration validates transport-adjacent shape (canonical email, password policy), rejects
 * duplicates with a generic conflict, and never signs the user in; sign-in stays a separate login
 * call. A pre-check gives a fast conflict answer, while the atomic {@code ON CONFLICT} insert
 * against the database uniqueness constraint remains authoritative for concurrent races — without
 * ever throwing (and logging) a unique-violation SQL error for an expected duplicate.
 */
@Service
public class IdentityService {

  private final UserRepository users;
  private final PasswordEncoder passwordEncoder;
  private final Clock clock;

  public IdentityService(UserRepository users, PasswordEncoder passwordEncoder, Clock clock) {
    this.users = users;
    this.passwordEncoder = passwordEncoder;
    this.clock = clock;
  }

  @Transactional
  public SafeUserResponse register(String rawEmail, String password) {
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

  @Transactional(readOnly = true)
  public SafeUserResponse resolve(UUID id) {
    return users
        .findById(id)
        .map(entity -> new SafeUserResponse(entity.getId(), entity.getEmail()))
        .orElseThrow(IdentityExceptions.UnauthenticatedException::new);
  }
}
