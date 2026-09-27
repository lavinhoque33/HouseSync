package com.housesync.identity.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Application user row. Email is stored in canonical form (see {@code EmailPolicy}) with a database
 * uniqueness constraint; {@code passwordHash} holds the delegating encoder output and is never
 * exposed through the API.
 */
@Entity
@Table(name = "users")
public class UserEntity {

  @Id private UUID id;

  @Column(nullable = false, length = 254, unique = true)
  private String email;

  @Column(name = "password_hash", nullable = false, length = 255)
  private String passwordHash;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "access_disabled", nullable = false)
  private boolean accessDisabled;

  @Column(name = "session_generation", nullable = false)
  private long sessionGeneration;

  protected UserEntity() {}

  public UserEntity(UUID id, String email, String passwordHash, Instant createdAt) {
    this.id = id;
    this.email = email;
    this.passwordHash = passwordHash;
    this.createdAt = createdAt;
  }

  public UUID getId() {
    return id;
  }

  public String getEmail() {
    return email;
  }

  public String getPasswordHash() {
    return passwordHash;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public boolean isAccessDisabled() {
    return accessDisabled;
  }

  public long getSessionGeneration() {
    return sessionGeneration;
  }
}
