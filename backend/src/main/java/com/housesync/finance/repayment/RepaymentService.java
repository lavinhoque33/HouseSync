package com.housesync.finance.repayment;

import com.housesync.finance.account.domain.SupportedCurrency;
import com.housesync.finance.repayment.RepaymentRepository.Fact;
import com.housesync.finance.repayment.RepaymentResponse.Event;
import com.housesync.finance.transaction.domain.TransactionMoneyPolicy;
import com.housesync.household.application.HouseholdService;
import com.housesync.identity.web.IdentityExceptions.ValidationFailedException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RepaymentService {
  public static final class NotFound extends RuntimeException {}

  public static final class IdempotencyConflict extends RuntimeException {}

  public record CreateResult(RepaymentResponse repayment, boolean replayed) {}

  public record Page<T>(List<T> items, int limit, int offset, boolean hasMore) {}

  public record Values(BigDecimal amount, SupportedCurrency currency, LocalDate date) {}

  private final RepaymentRepository repository;
  private final HouseholdService households;
  private final Clock clock;

  public RepaymentService(
      RepaymentRepository repository, HouseholdService households, Clock clock) {
    this.repository = repository;
    this.households = households;
    this.clock = clock;
  }

  @Transactional
  public CreateResult create(
      UUID household,
      UUID actor,
      UUID key,
      String recipient,
      String amount,
      String currency,
      String date) {
    UUID recipientId = parseUuid(recipient, "recipientUserId");
    Values values = validate(amount, currency, date);
    households.lockForFinance(household, actor);
    String fingerprint = fingerprint(recipientId, values);
    var previous = repository.key(household, actor, key);
    if (previous.isPresent()) {
      if (!previous.get().fingerprint().equals(fingerprint)) throw new IdempotencyConflict();
      Fact f = find(household, previous.get().repaymentId(), actor, false);
      return new CreateResult(response(f, actor, household), true);
    }
    if (actor.equals(recipientId)
        || !households.currentMemberUserIds(household).contains(recipientId)) {
      throw new ValidationFailedException(
          Map.of("recipientUserId", "Choose another current household member."));
    }
    checkDate(values.date(), household);
    Instant now = now();
    Fact f =
        new Fact(
            UUID.randomUUID(),
            household,
            actor,
            recipientId,
            values.currency(),
            values.amount(),
            values.date(),
            "PENDING",
            0,
            now,
            now,
            null,
            null,
            null,
            null,
            null,
            null,
            null);
    repository.create(f);
    repository.event(f, "CREATED", actor);
    repository.key(household, actor, key, fingerprint, f.id(), now);
    return new CreateResult(response(f, actor, household), false);
  }

  @Transactional
  public RepaymentResponse get(UUID household, UUID id, UUID actor) {
    households.lockForFinance(household, actor);
    return response(find(household, id, actor, false), actor, household);
  }

  @Transactional
  public Page<RepaymentResponse> list(
      UUID household,
      UUID actor,
      int limit,
      int offset,
      String currency,
      String status,
      LocalDate from,
      LocalDate to) {
    households.lockForFinance(household, actor);
    Set<UUID> roster = households.currentMemberUserIds(household);
    List<Fact> rows =
        repository.list(household, actor, currency, status, from, to, limit + 1, offset);
    return page(
        rows.stream().limit(limit).map(f -> RepaymentResponse.of(f, actor, roster)).toList(),
        limit,
        offset,
        rows.size() > limit);
  }

  @Transactional
  public Page<Event> events(UUID household, UUID id, UUID actor, int limit, int offset) {
    households.lockForFinance(household, actor);
    find(household, id, actor, false);
    var rows = repository.events(household, id, limit + 1, offset);
    return page(
        rows.stream().limit(limit).map(Event::of).toList(), limit, offset, rows.size() > limit);
  }

  private static <T> Page<T> page(List<T> items, int limit, int offset, boolean more) {
    return new Page<>(items, limit, offset, more);
  }

  @Transactional
  public RepaymentResponse decide(
      UUID household,
      UUID id,
      UUID actor,
      int version,
      String phase,
      String decision,
      String rawAmount,
      String rawCurrency,
      String rawDate) {
    // Parse replacement intent before touching any private resource; semantic state checks follow
    // scoped lookup.
    Values replacement =
        phase.equals("propose") && "REPLACE".equals(decision)
            ? validate(rawAmount, rawCurrency, rawDate)
            : null;
    households.lockForFinance(household, actor);
    Fact original = find(household, id, actor, true);
    if (replacement != null && replacement.currency() != original.currency())
      throw new ValidationFailedException(Map.of("money.currency", "Use the original currency."));
    var transition =
        RepaymentPolicy.change(
            original,
            actor,
            households.currentMemberUserIds(household),
            version,
            phase,
            decision,
            replacement == null ? null : replacement.amount(),
            replacement == null ? null : replacement.date(),
            now());
    if ((phase.equals("initial") && "CONFIRM".equals(decision))
        || (phase.equals("amendment")
            && "CONFIRM".equals(decision)
            && "REPLACE".equals(original.amendmentAction()))) {
      checkDate(
          phase.equals("initial") ? original.occurredOn() : original.amendmentOccurredOn(),
          household);
    }
    if (replacement != null) checkDate(replacement.date(), household);
    repository.update(transition.fact());
    repository.event(transition.fact(), transition.eventType(), actor);
    return response(transition.fact(), actor, household);
  }

  private Fact find(UUID household, UUID id, UUID actor, boolean lock) {
    return repository.find(household, id, actor, lock).orElseThrow(NotFound::new);
  }

  private RepaymentResponse response(Fact f, UUID actor, UUID household) {
    return RepaymentResponse.of(f, actor, households.currentMemberUserIds(household));
  }

  private Instant now() {
    return Instant.now(clock).truncatedTo(ChronoUnit.MICROS);
  }

  private void checkDate(LocalDate date, UUID household) {
    ZoneId zone = ZoneId.of(households.financeSettings(household).reportingTimeZone());
    if (date.isAfter(LocalDate.now(clock.withZone(zone))))
      throw new ValidationFailedException(Map.of("occurredOn", "Choose a completed payment date."));
  }

  public static UUID parseUuid(String input, String field) {
    if (input != null)
      try {
        UUID parsed = UUID.fromString(input);
        if (parsed.toString().equalsIgnoreCase(input)) return parsed;
      } catch (IllegalArgumentException ignored) {
      }
    throw new ValidationFailedException(
        Map.of(
            field,
            field.equals("idempotencyKey")
                ? "Provide a valid request key."
                : "Choose a valid user."));
  }

  public static Values validate(String amount, String rawCurrency, String rawDate) {
    Map<String, String> errors = new LinkedHashMap<>();
    SupportedCurrency currency = null;
    try {
      currency = SupportedCurrency.valueOf(rawCurrency);
    } catch (IllegalArgumentException | NullPointerException ignored) {
      errors.put("money.currency", "Choose a supported currency.");
    }
    BigDecimal parsed =
        currency == null ? null : TransactionMoneyPolicy.parseAmount(amount, currency, errors);
    if (parsed != null && parsed.signum() <= 0)
      errors.put("money.amount", "Enter a positive amount.");
    LocalDate date = null;
    try {
      date = LocalDate.parse(rawDate);
      if (!date.toString().equals(rawDate)
          || date.isBefore(LocalDate.of(1900, 1, 1))
          || date.isAfter(LocalDate.of(9999, 12, 30))) throw new IllegalArgumentException();
    } catch (RuntimeException ignored) {
      errors.put("occurredOn", "Choose a valid payment date.");
    }
    if (!errors.isEmpty()) throw new ValidationFailedException(errors);
    return new Values(parsed, currency, date);
  }

  private static String fingerprint(UUID recipient, Values values) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      for (String field :
          List.of(
              "REPAYMENT_CREATE",
              recipient.toString(),
              values.currency().name(),
              TransactionMoneyPolicy.toResponseString(values.amount(), values.currency()),
              values.date().toString())) {
        digest.update(field.getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
      }
      return HexFormat.of().formatHex(digest.digest());
    } catch (NoSuchAlgorithmException unavailable) {
      throw new IllegalStateException(unavailable);
    }
  }
}
