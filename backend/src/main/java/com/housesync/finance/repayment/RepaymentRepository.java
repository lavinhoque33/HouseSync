package com.housesync.finance.repayment;

import com.housesync.finance.account.domain.SupportedCurrency;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Household-scoped facts; callers hold the household lifecycle lock before every query. */
@Repository
public class RepaymentRepository {
  private static final String COLUMNS =
      "id,household_id,sender_user_id,recipient_user_id,currency,amount,occurred_on,status,version,created_at,updated_at,confirmed_at,voided_at,amendment_action,amendment_proposer,amendment_amount,amendment_occurred_on,amendment_created_at";
  private final JdbcTemplate jdbc;

  public RepaymentRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public record Fact(
      UUID id,
      UUID householdId,
      UUID senderUserId,
      UUID recipientUserId,
      SupportedCurrency currency,
      BigDecimal amount,
      LocalDate occurredOn,
      String status,
      int version,
      Instant createdAt,
      Instant updatedAt,
      Instant confirmedAt,
      Instant voidedAt,
      String amendmentAction,
      UUID amendmentProposer,
      BigDecimal amendmentAmount,
      LocalDate amendmentOccurredOn,
      Instant amendmentCreatedAt) {
    public boolean party(UUID actor) {
      return senderUserId.equals(actor) || recipientUserId.equals(actor);
    }
  }

  public record Key(String fingerprint, UUID repaymentId) {}

  /** Effective accepted payments only; never derive a balance from pending or voided events. */
  public record Confirmed(
      UUID senderUserId, UUID recipientUserId, SupportedCurrency currency, BigDecimal amount) {}

  private static Fact map(ResultSet rs, int index) throws SQLException {
    return new Fact(
        (UUID) rs.getObject("id"),
        (UUID) rs.getObject("household_id"),
        (UUID) rs.getObject("sender_user_id"),
        (UUID) rs.getObject("recipient_user_id"),
        SupportedCurrency.valueOf(rs.getString("currency")),
        rs.getBigDecimal("amount"),
        rs.getObject("occurred_on", LocalDate.class),
        rs.getString("status"),
        rs.getInt("version"),
        rs.getTimestamp("created_at").toInstant(),
        rs.getTimestamp("updated_at").toInstant(),
        instant(rs, "confirmed_at"),
        instant(rs, "voided_at"),
        rs.getString("amendment_action"),
        (UUID) rs.getObject("amendment_proposer"),
        rs.getBigDecimal("amendment_amount"),
        rs.getObject("amendment_occurred_on", LocalDate.class),
        instant(rs, "amendment_created_at"));
  }

  static Instant instant(ResultSet rs, String column) throws SQLException {
    var value = rs.getTimestamp(column);
    return value == null ? null : value.toInstant();
  }

  public Optional<Fact> find(UUID household, UUID id, UUID actor, boolean lock) {
    List<Fact> rows =
        jdbc.query(
            "SELECT "
                + COLUMNS
                + " FROM external_repayments WHERE household_id=? AND id=? AND (sender_user_id=? OR recipient_user_id=?)"
                + (lock ? " FOR UPDATE" : ""),
            RepaymentRepository::map,
            household,
            id,
            actor,
            actor);
    return rows.stream().findFirst();
  }

  public Optional<Key> key(UUID household, UUID actor, UUID key) {
    return jdbc
        .query(
            "SELECT request_fingerprint,repayment_id FROM external_repayment_idempotency_keys WHERE household_id=? AND actor_user_id=? AND operation='REPAYMENT_CREATE' AND idempotency_key=?",
            (rs, i) -> new Key(rs.getString(1), (UUID) rs.getObject(2)),
            household,
            actor,
            key)
        .stream()
        .findFirst();
  }

  public void create(Fact f) {
    jdbc.update(
        "INSERT INTO external_repayments (id,household_id,sender_user_id,recipient_user_id,currency,amount,occurred_on,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'PENDING',0,?,?)",
        f.id(),
        f.householdId(),
        f.senderUserId(),
        f.recipientUserId(),
        f.currency().name(),
        f.amount(),
        f.occurredOn(),
        timestamp(f.createdAt()),
        timestamp(f.updatedAt()));
  }

  public void key(UUID household, UUID actor, UUID key, String fingerprint, UUID id, Instant now) {
    jdbc.update(
        "INSERT INTO external_repayment_idempotency_keys (actor_user_id,household_id,operation,idempotency_key,request_fingerprint,repayment_id,created_at) VALUES (?,?,'REPAYMENT_CREATE',?,?,?,?)",
        actor,
        household,
        key,
        fingerprint,
        id,
        timestamp(now));
  }

  public void update(Fact f) {
    jdbc.update(
        "UPDATE external_repayments SET amount=?,occurred_on=?,status=?,version=?,updated_at=?,confirmed_at=?,voided_at=?,amendment_action=?,amendment_proposer=?,amendment_amount=?,amendment_occurred_on=?,amendment_created_at=? WHERE household_id=? AND id=? AND version=?",
        f.amount(),
        f.occurredOn(),
        f.status(),
        f.version(),
        timestamp(f.updatedAt()),
        timestamp(f.confirmedAt()),
        timestamp(f.voidedAt()),
        f.amendmentAction(),
        f.amendmentProposer(),
        f.amendmentAmount(),
        f.amendmentOccurredOn(),
        timestamp(f.amendmentCreatedAt()),
        f.householdId(),
        f.id(),
        f.version() - 1);
  }

  public void event(Fact f, String type, UUID actor) {
    jdbc.update(
        "INSERT INTO external_repayment_events (repayment_id,version,event_type,actor_user_id,recorded_at,status,currency,amount,occurred_on,amendment_action,amendment_proposer,amendment_amount,amendment_occurred_on,amendment_created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        f.id(),
        f.version(),
        type,
        actor,
        timestamp(f.updatedAt()),
        f.status(),
        f.currency().name(),
        f.amount(),
        f.occurredOn(),
        f.amendmentAction(),
        f.amendmentProposer(),
        f.amendmentAmount(),
        f.amendmentOccurredOn(),
        timestamp(f.amendmentCreatedAt()));
  }

  private static Timestamp timestamp(Instant instant) {
    return instant == null ? null : Timestamp.from(instant);
  }

  public List<Fact> list(
      UUID household,
      UUID actor,
      String currency,
      String status,
      LocalDate from,
      LocalDate to,
      int limit,
      int offset) {
    return jdbc.query(
        "SELECT "
            + COLUMNS
            + " FROM external_repayments WHERE household_id=? AND (sender_user_id=? OR recipient_user_id=?) AND (CAST(? AS varchar) IS NULL OR currency=?) AND (CAST(? AS varchar) IS NULL OR status=?) AND (?::date IS NULL OR occurred_on>=?::date) AND (?::date IS NULL OR occurred_on<?::date) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
        RepaymentRepository::map,
        household,
        actor,
        actor,
        currency,
        currency,
        status,
        status,
        from,
        from,
        to,
        to,
        limit,
        offset);
  }

  public List<RepaymentEvent> events(UUID household, UUID id, int limit, int offset) {
    return jdbc.query(
        "SELECT e.version,e.event_type,e.actor_user_id,e.recorded_at,e.status,e.currency,e.amount,e.occurred_on,e.amendment_action,e.amendment_proposer,e.amendment_amount,e.amendment_occurred_on,e.amendment_created_at FROM external_repayment_events e JOIN external_repayments r ON r.id=e.repayment_id WHERE r.household_id=? AND e.repayment_id=? ORDER BY e.version ASC LIMIT ? OFFSET ?",
        (rs, i) ->
            new RepaymentEvent(
                rs.getInt(1),
                rs.getString(2),
                (UUID) rs.getObject(3),
                rs.getTimestamp(4).toInstant(),
                rs.getString(5),
                SupportedCurrency.valueOf(rs.getString(6)),
                rs.getBigDecimal(7),
                rs.getObject(8, LocalDate.class),
                rs.getString(9),
                (UUID) rs.getObject(10),
                rs.getBigDecimal(11),
                rs.getObject(12, LocalDate.class),
                instant(rs, "amendment_created_at")),
        household,
        id,
        limit,
        offset);
  }

  public record RepaymentEvent(
      int version,
      String eventType,
      UUID actorUserId,
      Instant recordedAt,
      String status,
      SupportedCurrency currency,
      BigDecimal amount,
      LocalDate occurredOn,
      String amendmentAction,
      UUID amendmentProposer,
      BigDecimal amendmentAmount,
      LocalDate amendmentOccurredOn,
      Instant amendmentCreatedAt) {}

  /**
   * C2 seam: call inside the same authorized household lock and transaction as allocation
   * projection.
   */
  public List<Confirmed> confirmedForHousehold(UUID household) {
    return jdbc.query(
        "SELECT sender_user_id,recipient_user_id,currency,amount FROM external_repayments WHERE household_id=? AND status='CONFIRMED' ORDER BY id",
        (rs, i) ->
            new Confirmed(
                (UUID) rs.getObject(1),
                (UUID) rs.getObject(2),
                SupportedCurrency.valueOf(rs.getString(3)),
                rs.getBigDecimal(4)),
        household);
  }
}
