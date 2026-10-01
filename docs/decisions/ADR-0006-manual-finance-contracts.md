# ADR 0006 - Manual finance, exact money, and selected sharing

- **Status:** Accepted and implemented; this ADR records the original manual-finance decisions.
- **Scope:** Manual accounts and transactions, exact money, visibility, retention and reporting basis.
- **Related:** [Manual-finance API contract](../architecture/manual-finance-api.md),
  [household lifecycle](ADR-0005-household-membership-lifecycle.md) and
  [shared-finance extension](ADR-0010-shared-finance.md).

## Context

Identity and household membership exist. Manual finance must establish trustworthy money and privacy rules before provider data,
categories, splits, or charts depend on them. Current membership removal deletes a household-membership row.
Household ownership governs membership administration; it must not become ownership of another person's money.

The initial model favors private financial accounts with individually shared transactions. It supports partially
shared finances without designing joint-account authority, totals-only disclosures, or provider reconciliation now.

## Decision

### 1. Exact monetary values and currency

- Use an immutable backend money value containing `BigDecimal` constructed from decimal text plus currency.
  Arithmetic requires equal currencies. Normalize once at the API boundary with the currency scale and
  `RoundingMode.UNNECESSARY`; reject excess fractional digits, including excess trailing zeros, before normalization.
- JSON amounts are plain decimal **strings**, never numbers. Responses have exactly the currency's fractional
  digits. JavaScript preserves strings; exact client previews may use `bigint` minor units, never `number` math
  or `parseFloat`. Display formatting must preserve all digits and show the currency code.
- The original explicit allowlist is **BRL, USD, EUR, GBP (scale 2), JPY (scale 0), KWD (scale 3)**; CAD was added later. This is a bounded
  initial product choice covering zero-, two-, and three-decimal money, not a claim to support every ISO currency.
  Neither currency nor scale comes from locale, a symbol, or the runtime's evolving currency catalog.
- Per-record magnitude is at most `999999999999` major units plus the currency's maximum fractional part
  (12 integral digits). Transactions must be nonzero. Aggregate results can exceed the per-record bound;
  calculate with arbitrary-precision decimal/integer operations and return exact strings without narrowing.
- Persist transaction amounts as PostgreSQL `NUMERIC(15,3)` with currency, range, nonzero, and sign constraints.
  Validate currency scale before binding a value: PostgreSQL scale coercion is not a rounding policy. Stored
  zero padding is internal; responses use the declared currency scale. No binary floating-point intermediates.
- There is no foreign-exchange conversion or household-wide implicit currency. Accounts have one immutable
  supported currency; transactions must match it. Reports group currencies separately and never add them together.

### 2. Meaning and sign of a transaction

Amounts describe the account holder's economic direction, consistently across cash, bank, and credit-card accounts:

| Kind | Stored/API sign | Spending contribution | Meaning |
| --- | --- | --- | --- |
| `EXPENSE` | Negative | Positive magnitude | Purchase/outflow, including a card purchase that increases liability |
| `INCOME` | Positive | Zero | Income/inflow; reported separately from spending |
| `REFUND` | Positive | Negative magnitude | Return against a specific recorded expense |
| `TRANSFER` | Either, nonzero | Zero | Incoming or outgoing movement, including a card payment |

- A refund must reference a non-voided expense in the same household, owned by the same user, in the same account
  and currency. Sum of non-voided refunds cannot exceed the expense magnitude. Lock/recheck the expense when
  creating, correcting, or voiding a refund or correcting its source expense. Refund and expense visibility match;
  a visibility change updates the whole linked group atomically. This avoids revealing private source references.
- Manual transfers are signed ledger entries, with no automatic inferred pairing, income classification, or
  obligation settlement. A user recording both sides creates two records; both are excluded from spending and
  income. Amount/date/description similarity never deduplicates them. Linked atomic transfers are deferred.
- Manual entries are `POSTED`; manual finance does not accept provisional `PENDING` data. Correction by voiding uses `VOIDED`,
  retaining the record while excluding its contribution. An expense with live refunds cannot be voided until
  those refunds are voided. A refund is not a reversal: voiding negates the entry's validity rather than recording
  a second economic event. Provider pending/reversal/replacement semantics belong to [connected finance](ADR-0008-connected-finance.md).
- A credit-card payment is a transfer, not a second expense. Manual finance does not promise a bank balance, available credit,
  or reconciled opening balance. Ledger net movement, spending, and member obligations have distinct labels.

### 3. Dates and reporting ownership

- `occurredOn` is an ISO `YYYY-MM-DD` calendar date (`LocalDate` / SQL `DATE`), in `1900-01-01` through
  `9999-12-30`; reserve `9999-12-31` as the final exclusive reporting boundary. It is entered by the user and
  never converted to midnight UTC. Future dates are permitted as
  explicit manual facts; the UI warns about them and reports include them only when the requested period does.
  This is not a scheduling or pending-transaction feature.
- `createdAt` and `updatedAt` are server-clock `Instant` values, persisted as `TIMESTAMPTZ`, returned in UTC
  with `Z` and at most microsecond precision. They never determine a spending period.
- Reporting intervals are half-open `[from, to)`, using `occurredOn`. Refunds reduce spending on their own date;
  they do not rewrite the original month's spending. Negative net spending in a refund-heavy period is valid.
- The household owns its reporting time zone. Before dashboard delivery, introduce a stored IANA region zone,
  initially `Etc/UTC` for existing and new households; owners can explicitly change it. Show the zone in reporting
  UI. It defines “today” and default month boundaries, never a reinterpretation of saved dates. Use an injected
  clock; changing zone may change a default period, but not results for an explicit date interval.

### 4. Accounts, ownership, and visibility

- Every manual account belongs to one household and one stable user UUID. The creator becomes its financial
  owner from authentication; request bodies cannot nominate owners. Both household roles may create accounts.
  Ownership is immutable and does not assert legal ownership of a real bank account.
- Supported manual account kinds are `CASH`, `CHECKING`, `SAVINGS`, and `CREDIT_CARD`; source is `MANUAL`.
  Name is a user label, not an institution identifier. Duplicate names are legitimate. No bank credentials,
  routing numbers, balances, or provider objects are collected for manual accounts.
- Accounts and their metadata are **always private to their financial owner**, subject to current household
  membership. A transaction can independently have `PRIVATE` or `HOUSEHOLD` visibility; default is `PRIVATE`.
  `HOUSEHOLD` explicitly discloses the transaction's full amount, currency, date, kind, description, owner user
  UUID, lifecycle, and visible refund relationship to every current member, including members joining later.
- Sharing a transaction never shares account ID/name/kind, account totals, sibling transactions, or owner email.
  Non-owner transaction DTOs redact `accountId` to null and never embed account metadata. The financial owner
  alone may create entries in their account or correct/void/share their entries. Household `OWNER` grants no
  finance override; others' shared entries are read-only.
- Visibility and cost allocation are distinct. A visible transaction is not automatically split, and sharing
  does not create debt. Disclosure is full-transaction; publishing only a household portion of a
  mixed/private purchase requires a later projection design. There is no totals-only mode or implicit disclosure.
- Household spending totals use only `HOUSEHOLD`, non-voided transactions, even when the viewer owns additional
  private entries. A separately labeled “My transactions” view contains only that actor's entries; never mix
  these populations into one unlabeled dashboard total.

### 5. Lifecycle, retention, and authorization

- Every request checks current household membership and resource ownership/visibility in backend queries.
  Foreign-household, hidden, and nonexistent resources are indistinguishable. Known shared records that another
  member cannot edit return a safe forbidden response. Counts, filters, cursors, errors, and aggregates obey the
  same boundary; an account filter cannot be used to enumerate another member's account.
- Account archive prevents new entries, preserves history, and can be reversed by its financial owner. Existing
  records can still be corrected/voided. There is no hard-delete API for accounts or transactions.
- Finance records reference households and stable users with restrictive foreign keys, **not membership rows**.
  Removal/leave immediately denies all household finance access, including access to one's own private records
  through that household. It neither deletes records nor exposes private ones nor transfers ownership to an admin.
  Previously shared history remains readable by current members with its recorded user UUID; do not look up or
  disclose a former member's email. New edits by that user require current membership again.
- Rejoining with the same user UUID restores their financial ownership access; it does not create a new owner or
  reset history. Private retained records have no member-accessible recovery route while the owner is absent.
  This is an explicit retention limit; export, erasure, household deletion, and ownership transfer need
  separate lifecycle decisions. Leave/removal UI explains retained shared history.
- Finance mutations acquire the household lifecycle lock before checking current membership, then account and
  related transaction locks in a deterministic order. This orders commits with membership removal. Reads enforce
  membership and visibility in the same SQL statement/snapshot; access revoked after a read cannot recall bytes
  already disclosed. Multi-query aggregates require a consistent authorized snapshot or the lifecycle lock.
- Expose a household application authorization/locking use case for finance integration; do not make finance
  reach into household repositories or use an unlocked “check membership, then write” sequence.

### 6. Retry, correction, and conservation

- Account and transaction creation require a durable, actor/household/operation-scoped idempotency key.
  Commit key and result association with the new resource atomically. Same normalized input returns that same
  resource; different input conflicts. No expiration while the resource is retained. Always reauthorize replay.
- Mutable resources have a version and reject stale writes; never overwrite another correction after a timeout.
  IDs, ownership, source, currency, and account association are immutable. Transaction kind and refund source
  are also immutable; correct those mistakes by voiding and recording a new entry.
- The subsequently implemented equal-split API enforces conservation with currency-scale minor units,
  current eligible participants, and atomic transaction/allocation updates. Equal division awards remainder units
  in ascending canonical user-UUID order. Calculate on the positive expense magnitude, then apply the same
  portions with opposite obligation signs for refunds; never round each participant independently. USD 10.00
  across three ordered participants is 3.34, 3.33, 3.33; a full refund reverses those exact portions.
- Member balances are obligations, separately grouped by currency, with positive meaning “is owed” and negative
  meaning “owes.” Sum of balances is zero. See [ADR 0007](ADR-0007-categories-sharing-allocations.md)
  for original equal/refund policy and [ADR 0010](ADR-0010-shared-finance.md)
  for exact allocation, departure and repayment extensions.

## Build sequence and consequences

1. **Private manual accounts:** create/list/detail/rename/archive/unarchive, exact currency policy, durable retries,
   membership integration, mobile UI, and negative authorization checks. No invented balance.
2. **Private manual transactions:** create/list/detail/correction/void, sign/date validation, linked refunds,
   transfers, exact retry and concurrency behavior. Privacy is enforced before any records are exposed.
3. **Categories and selected transaction sharing:** explicit disclosure/revocation and refund-group behavior;
   neither a category named “Transfers” nor a “Personal” label substitutes for kind or visibility.
4. **Basic splits/balances and dashboard:** conserved obligations, reporting settings, and authorized
   per-currency summaries.

This ADR records the original manual-finance boundary, not the present full feature
set. Reviewed connected imports, deterministic categorization and record-only
repayments have since been implemented; joint account authority, totals-only
disclosure and FX remain unsupported. See [system overview](../architecture/system-overview.md).

## Alternatives and tradeoffs

- Integer minor units would also be exact, but `BigDecimal` plus explicit scale maps naturally to Java/PostgreSQL
  and avoids a fixed-width integer ceiling for totals. Minor units remain useful for deterministic splitting.
- Household-wide account sharing is simpler for an administrator but violates partially shared finance privacy.
  Selected transaction sharing gives users an explicit disclosure boundary at the cost of redacted DTOs.
- A single default currency would simplify charts but make multi-currency data misleading. Explicit selection and
  separate totals are a small initial cost; conversion requires a separate decision and evidence.
- Household locking serializes writes for a small household and extends the membership lifecycle model.
  Optimize only with evidence while preserving the same revocation and concurrency guarantees.

## Verification

The [manual-finance API behavior matrix](../architecture/manual-finance-api.md#behavior-matrix)
records executable examples and behavioral checks for this decision.
