package com.housesync.household.invitation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.housesync.household.invitation.application.CapabilityCredential;
import com.housesync.household.invitation.application.InvitationSecrets;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Pure unit coverage for the capability secret codec and request validation: exact 43-character
 * unpadded base64url shape, 32-byte payloads, strict rejection of padded/alternate/non-canonical
 * encodings, digest-only storage inputs, and safe field-error keys that never echo values.
 */
class InvitationSecretsTest {

  @Test
  void generatedSecretsAreUnique43CharBase64UrlCarrying32Bytes() {
    Set<String> seen = new HashSet<>();
    for (int i = 0; i < 25; i++) {
      String secret = InvitationSecrets.generate();
      assertThat(secret).hasSize(InvitationSecrets.SECRET_TEXT_LENGTH);
      assertThat(secret).matches(InvitationSecrets.SECRET_PATTERN);
      assertThat(Base64.getUrlDecoder().decode(secret))
          .hasSize(InvitationSecrets.SECRET_BYTE_LENGTH);
      assertThat(seen.add(secret)).isTrue();
    }
  }

  @Test
  void decodedBytesReencodeToTheCanonicalSecret() {
    String secret = InvitationSecrets.generate();
    byte[] raw = InvitationSecrets.decodeStrict(secret);
    assertThat(raw).hasSize(32);
    assertThat(Base64.getUrlEncoder().withoutPadding().encodeToString(raw)).isEqualTo(secret);
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "",
        "short",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa+_",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/_",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa A",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nA",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaé"
      })
  void malformedSecretsAreRejected(String candidate) {
    assertThatThrownBy(() -> InvitationSecrets.decodeStrict(candidate))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void nullSecretIsRejected() {
    assertThatThrownBy(() -> InvitationSecrets.decodeStrict(null))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void nonCanonicalTrailingBitsAreRejected() {
    // 43 pattern-valid characters decoding to 32 bytes, but the two spare low bits of the final
    // character are set, so the string is not the canonical encoding of its payload.
    String canonical = InvitationSecrets.generate();
    char last = canonical.charAt(42);
    char tampered = last == 'B' ? 'C' : 'B';
    String candidate = canonical.substring(0, 42) + tampered;
    assertThat(candidate).matches(InvitationSecrets.SECRET_PATTERN);
    assertThat(Base64.getUrlDecoder().decode(candidate)).hasSize(32);
    assertThatThrownBy(() -> InvitationSecrets.decodeStrict(candidate))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void digestsAre32BytesDeterministicAndComparedConstantTime() {
    byte[] raw = InvitationSecrets.decodeStrict(InvitationSecrets.generate());
    byte[] first = InvitationSecrets.sha256(raw);
    byte[] second = InvitationSecrets.sha256(raw.clone());
    assertThat(first).hasSize(32);
    assertThat(InvitationSecrets.digestEquals(first, second)).isTrue();
    byte[] other =
        InvitationSecrets.sha256(
            InvitationSecrets.decodeStrict("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    assertThat(InvitationSecrets.digestEquals(first, other)).isFalse();
    assertThat(InvitationSecrets.digestEquals(first, new byte[31])).isFalse();
    assertThat(InvitationSecrets.digestEquals(first, null)).isFalse();
  }

  @Test
  void credentialParsesValidRequests() {
    UUID id = UUID.randomUUID();
    String secret = InvitationSecrets.generate();
    CapabilityCredential credential = CapabilityCredential.parse(id.toString(), secret);
    assertThat(credential.invitationId()).isEqualTo(id);
    assertThat(credential.rawSecret()).isEqualTo(Base64.getUrlDecoder().decode(secret));
  }

  @Test
  void credentialRejectsMissingValuesWithBothFieldKeys() {
    assertThatThrownBy(() -> CapabilityCredential.parse(null, null))
        .isInstanceOf(ValidationFailedException.class)
        .satisfies(
            failure ->
                assertThat(((ValidationFailedException) failure).getFieldErrors().keySet())
                    .containsExactlyInAnyOrder("invitationId", "secret"));
  }

  @Test
  void credentialRejectsMalformedUuidWithoutEchoingIt() {
    String secret = InvitationSecrets.generate();
    assertThatThrownBy(() -> CapabilityCredential.parse("not-a-uuid", secret))
        .isInstanceOf(ValidationFailedException.class)
        .satisfies(
            failure -> {
              var fieldErrors = ((ValidationFailedException) failure).getFieldErrors();
              assertThat(fieldErrors.keySet()).containsExactly("invitationId");
              assertThat(fieldErrors.values()).doesNotContain("not-a-uuid");
              assertThat(failure.getMessage()).doesNotContain("not-a-uuid");
            });
  }

  @Test
  void credentialRejectsBadSecretsWithoutEchoingThem() {
    String candidate = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
    assertThatThrownBy(() -> CapabilityCredential.parse(UUID.randomUUID().toString(), candidate))
        .isInstanceOf(ValidationFailedException.class)
        .satisfies(
            failure -> {
              var fieldErrors = ((ValidationFailedException) failure).getFieldErrors();
              assertThat(fieldErrors.keySet()).containsExactly("secret");
              assertThat(fieldErrors.values()).doesNotContain(candidate);
              assertThat(failure.getMessage()).doesNotContain(candidate);
            });
  }
}
