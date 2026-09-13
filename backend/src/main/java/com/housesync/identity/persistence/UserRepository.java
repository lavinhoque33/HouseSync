package com.housesync.identity.persistence;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UserRepository extends JpaRepository<UserEntity, UUID> {

  Optional<UserEntity> findByEmail(String canonicalEmail);

  boolean existsByEmail(String canonicalEmail);

  /**
   * Atomic registration insert. Concurrent duplicates resolve inside PostgreSQL instead of raising
   * a unique-violation exception, so no SQL error (and no identifier detail) is ever logged for an
   * expected race.
   *
   * @return 1 when the row was inserted, 0 when the email already existed.
   */
  @Modifying
  @Query(
      value =
          "INSERT INTO users (id, email, password_hash, created_at)"
              + " VALUES (:id, :email, :passwordHash, :createdAt)"
              + " ON CONFLICT (email) DO NOTHING",
      nativeQuery = true)
  int insertIgnoreConflict(
      @Param("id") UUID id,
      @Param("email") String canonicalEmail,
      @Param("passwordHash") String passwordHash,
      @Param("createdAt") Instant createdAt);
}
