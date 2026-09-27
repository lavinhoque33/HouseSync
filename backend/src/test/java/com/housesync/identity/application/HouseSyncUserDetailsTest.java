package com.housesync.identity.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class HouseSyncUserDetailsTest {

  // Deliberately hash-shaped but fake; this test never logs or prints it.
  private static final String HASH_MARKER = "{bcrypt}$2a$12$test-only-hash-marker-00000000000";

  @Test
  void eraseCredentialsRemovesHashAndSerializesCleanly() throws Exception {
    UUID id = UUID.randomUUID();
    HouseSyncUserDetails principal =
        new HouseSyncUserDetails(id, "person@example.test", HASH_MARKER, 7);
    assertThat(principal.getPassword()).isEqualTo(HASH_MARKER);

    principal.eraseCredentials();
    assertThat(principal.getPassword()).isNull();
    assertThat(principal.getId()).isEqualTo(id);
    assertThat(principal.getEmail()).isEqualTo("person@example.test");
    assertThat(principal.getSessionGeneration()).isEqualTo(7);

    byte[] serialized = serialize(principal);
    assertThat(new String(serialized, StandardCharsets.ISO_8859_1)).doesNotContain(HASH_MARKER);
    HouseSyncUserDetails restored = deserialize(serialized);
    assertThat(restored.getId()).isEqualTo(id);
    assertThat(restored.getEmail()).isEqualTo("person@example.test");
    assertThat(restored.getPassword()).isNull();
    assertThat(restored.getSessionGeneration()).isEqualTo(7);
  }

  private static byte[] serialize(HouseSyncUserDetails principal) throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (ObjectOutputStream out = new ObjectOutputStream(bytes)) {
      out.writeObject(principal);
    }
    return bytes.toByteArray();
  }

  private static HouseSyncUserDetails deserialize(byte[] bytes) throws Exception {
    try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(bytes))) {
      return (HouseSyncUserDetails) in.readObject();
    }
  }
}
