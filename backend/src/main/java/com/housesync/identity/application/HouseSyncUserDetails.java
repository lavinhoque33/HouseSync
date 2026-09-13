package com.housesync.identity.application;

import java.io.Serial;
import java.io.Serializable;
import java.util.List;
import java.util.UUID;
import org.springframework.security.core.CredentialsContainer;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

/**
 * Authenticated principal. Carries only the stable user UUID and
 * canonical email, plus the password hash the provider needs for a single comparison at login. The
 * login controller erases the hash once authentication succeeds, so the JDBC-persisted session
 * principal never contains it (the field is also transient as defense in depth). Household
 * membership and permissions are checked against current backend data later, never copied into this
 * principal.
 */
public final class HouseSyncUserDetails implements UserDetails, CredentialsContainer, Serializable {

  @Serial private static final long serialVersionUID = 1L;

  private final UUID id;
  private final String email;
  private transient String passwordHash;

  public HouseSyncUserDetails(UUID id, String email, String passwordHash) {
    this.id = id;
    this.email = email;
    this.passwordHash = passwordHash;
  }

  public UUID getId() {
    return id;
  }

  public String getEmail() {
    return email;
  }

  @Override
  public String getUsername() {
    return email;
  }

  @Override
  public String getPassword() {
    return passwordHash;
  }

  /**
   * Drops the password hash. Called after a successful login so the hash is usable for exactly one
   * provider comparison and never reaches the persisted session.
   */
  @Override
  public void eraseCredentials() {
    passwordHash = null;
  }

  @Override
  public List<GrantedAuthority> getAuthorities() {
    return List.of();
  }
}
