package com.housesync.finance.account.application;

import com.housesync.finance.account.domain.FinancialAccountKind;
import com.housesync.finance.account.domain.FinancialAccountNamePolicy;
import com.housesync.finance.account.domain.FinancialAccountStatus;
import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.account.persistence.AccountIdempotencyEntity;
import com.housesync.finance.account.persistence.AccountIdempotencyKey;
import com.housesync.finance.account.persistence.AccountIdempotencyRepository;
import com.housesync.finance.account.persistence.FinancialAccountEntity;
import com.housesync.finance.account.persistence.FinancialAccountRepository;
import com.housesync.finance.account.web.FinancialAccountExceptions.FinancialAccountNotFoundException;
import com.housesync.finance.account.web.FinancialAccountExceptions.IdempotencyConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionConflictException;
import com.housesync.finance.account.web.FinancialAccountExceptions.ResourceVersionExhaustedException;
import com.housesync.finance.account.web.FinancialAccountListResponse;
import com.housesync.finance.account.web.FinancialAccountResponse;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FinancialAccountService {

  private static final String CREATE_OPERATION = "ACCOUNT_CREATE";

  private final FinancialAccountRepository accounts;
  private final AccountIdempotencyRepository idempotency;
  private final HouseholdService households;
  private final Clock clock;

  public FinancialAccountService(
      FinancialAccountRepository accounts,
      AccountIdempotencyRepository idempotency,
      HouseholdService households,
      Clock clock) {
    this.accounts = accounts;
    this.idempotency = idempotency;
    this.households = households;
    this.clock = clock;
  }

  @Transactional
  public CreateResult create(
      UUID householdId,
      UUID actorId,
      UUID idempotencyKey,
      String rawName,
      String rawKind,
      String rawCurrency) {
    CreateValues values = validateCreate(rawName, rawKind, rawCurrency);
    households.lockForFinance(householdId, actorId);

    AccountIdempotencyKey key =
        new AccountIdempotencyKey(actorId, householdId, CREATE_OPERATION, idempotencyKey);
    String fingerprint = fingerprint(values);
    var existing = idempotency.findById(key);
    if (existing.isPresent()) {
      if (!existing.get().getRequestFingerprint().equals(fingerprint)) {
        throw new IdempotencyConflictException();
      }
      FinancialAccountEntity account =
          accounts
              .findOwnedForUpdate(householdId, existing.get().getResourceId(), actorId)
              .orElseThrow(FinancialAccountNotFoundException::new);
      return new CreateResult(toResponse(account), true);
    }

    Instant now = now();
    FinancialAccountEntity account =
        new FinancialAccountEntity(
            UUID.randomUUID(),
            householdId,
            actorId,
            values.name(),
            values.kind(),
            values.currency(),
            now);
    accounts.save(account);
    idempotency.save(new AccountIdempotencyEntity(key, fingerprint, account.getId(), now));
    accounts.flush();
    idempotency.flush();
    return new CreateResult(toResponse(account), false);
  }

  @Transactional(readOnly = true)
  public FinancialAccountListResponse list(
      UUID householdId, UUID actorId, String status, int limit, int offset) {
    List<FinancialAccountEntity> page =
        accounts.findOwnedPage(householdId, actorId, status, limit + 1, offset);
    if (page.isEmpty()) {
      // Preserve missing/non-member equivalence without a separate broad account read.
      households.requireFinanceMembership(householdId, actorId);
    }
    boolean hasMore = page.size() > limit;
    List<FinancialAccountResponse> items =
        page.stream().limit(limit).map(FinancialAccountService::toResponse).toList();
    return new FinancialAccountListResponse(items, limit, offset, hasMore);
  }

  @Transactional(readOnly = true)
  public FinancialAccountResponse get(UUID householdId, UUID accountId, UUID actorId) {
    return accounts
        .findOwnedScoped(householdId, accountId, actorId)
        .map(FinancialAccountService::toResponse)
        .orElseGet(
            () -> {
              // A miss is either a foreign/hidden account for a current member (generic resource
              // 404) or a non-member/removed actor (generic household 404); membership decides.
              households.requireFinanceMembership(householdId, actorId);
              throw new FinancialAccountNotFoundException();
            });
  }

  @Transactional
  public FinancialAccountResponse update(
      UUID householdId,
      UUID accountId,
      UUID actorId,
      Integer expectedVersion,
      boolean expectedVersionPresent,
      String rawName,
      boolean namePresent,
      String rawStatus,
      boolean statusPresent) {
    UpdateValues values =
        validateUpdate(
            expectedVersion,
            expectedVersionPresent,
            rawName,
            namePresent,
            rawStatus,
            statusPresent);
    households.lockForFinance(householdId, actorId);
    FinancialAccountEntity account =
        accounts
            .findOwnedForUpdate(householdId, accountId, actorId)
            .orElseThrow(FinancialAccountNotFoundException::new);
    if (account.getVersion() != values.expectedVersion()) {
      throw new ResourceVersionConflictException();
    }

    String nextName = values.name() == null ? account.getName() : values.name();
    FinancialAccountStatus nextStatus =
        values.status() == null ? account.getStatus() : values.status();
    if (account.getName().equals(nextName) && account.getStatus() == nextStatus) {
      return toResponse(account);
    }
    if (account.getVersion() == Integer.MAX_VALUE) {
      throw new ResourceVersionExhaustedException();
    }
    account.update(nextName, nextStatus, now());
    accounts.saveAndFlush(account);
    return toResponse(account);
  }

  private static CreateValues validateCreate(String name, String kind, String currency) {
    Map<String, String> errors = new LinkedHashMap<>();
    FinancialAccountNamePolicy.violation(name).ifPresent(message -> errors.put("name", message));
    FinancialAccountKind parsedKind = parseKind(kind, errors);
    SupportedCurrency parsedCurrency = parseCurrency(currency, errors);
    if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    return new CreateValues(FinancialAccountNamePolicy.normalize(name), parsedKind, parsedCurrency);
  }

  private static UpdateValues validateUpdate(
      Integer expectedVersion,
      boolean expectedVersionPresent,
      String name,
      boolean namePresent,
      String status,
      boolean statusPresent) {
    Map<String, String> errors = new LinkedHashMap<>();
    if (!expectedVersionPresent || expectedVersion == null || expectedVersion < 0) {
      errors.put("expectedVersion", "Provide the current account version.");
    }
    if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    if (!namePresent && !statusPresent) {
      // Body-level rule with no real field to name; the shared shape omits empty fieldErrors.
      throw new ValidationFailedException(Map.of());
    }
    String normalizedName = null;
    if (namePresent) {
      FinancialAccountNamePolicy.violation(name).ifPresent(message -> errors.put("name", message));
      normalizedName = FinancialAccountNamePolicy.normalize(name);
    }
    FinancialAccountStatus parsedStatus = null;
    if (statusPresent) {
      if (status == null) {
        errors.put("status", "Choose active or archived.");
      } else {
        try {
          parsedStatus = FinancialAccountStatus.valueOf(status);
        } catch (IllegalArgumentException rejected) {
          errors.put("status", "Choose active or archived.");
        }
      }
    }
    if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    return new UpdateValues(expectedVersion, normalizedName, parsedStatus);
  }

  private static FinancialAccountKind parseKind(String value, Map<String, String> errors) {
    if (value != null) {
      try {
        return FinancialAccountKind.valueOf(value);
      } catch (IllegalArgumentException rejected) {
        // Safe field error below.
      }
    }
    errors.put("kind", "Choose cash, checking, savings, or credit card.");
    return null;
  }

  private static SupportedCurrency parseCurrency(String value, Map<String, String> errors) {
    if (value != null) {
      try {
        return SupportedCurrency.valueOf(value);
      } catch (IllegalArgumentException rejected) {
        // Safe field error below.
      }
    }
    errors.put("currency", "Choose a supported currency.");
    return null;
  }

  private static String fingerprint(CreateValues values) {
    String canonical = values.name() + "\u0000" + values.kind() + "\u0000" + values.currency();
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(canonical.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is required by the Java platform", impossible);
    }
  }

  private Instant now() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  private static FinancialAccountResponse toResponse(FinancialAccountEntity account) {
    return new FinancialAccountResponse(
        account.getId(),
        account.getHouseholdId(),
        account.getOwnerUserId(),
        account.getName(),
        account.getKind().name(),
        account.getCurrency().name(),
        account.getSource(),
        account.getVisibility(),
        account.getStatus().name(),
        account.getVersion(),
        account.getCreatedAt(),
        account.getUpdatedAt());
  }

  public record CreateResult(FinancialAccountResponse account, boolean replayed) {}

  private record CreateValues(String name, FinancialAccountKind kind, SupportedCurrency currency) {}

  private record UpdateValues(int expectedVersion, String name, FinancialAccountStatus status) {}
}
