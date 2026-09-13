package com.housesync.identity.application;

import com.housesync.identity.domain.EmailPolicy;
import com.housesync.identity.persistence.UserEntity;
import com.housesync.identity.persistence.UserRepository;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Loads principals by canonical email. Unknown identifiers throw {@link UsernameNotFoundException}
 * so the {@code DaoAuthenticationProvider} performs its dummy-hash comparison and the controller
 * can return the same generic 401 for unknown users and wrong passwords.
 */
@Service
public class HouseSyncUserDetailsService implements UserDetailsService {

  private final UserRepository users;

  public HouseSyncUserDetailsService(UserRepository users) {
    this.users = users;
  }

  @Override
  @Transactional(readOnly = true)
  public UserDetails loadUserByUsername(String login) throws UsernameNotFoundException {
    String canonical = login == null ? null : EmailPolicy.normalize(login);
    UserEntity entity = canonical == null ? null : users.findByEmail(canonical).orElse(null);
    if (entity == null) {
      throw new UsernameNotFoundException("Unknown login identifier.");
    }
    return new HouseSyncUserDetails(entity.getId(), entity.getEmail(), entity.getPasswordHash());
  }
}
