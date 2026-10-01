# Manual-finance API

**Status:** Implemented manual accounts, ledger, sharing, allocations and spending reports.
[ADR 0006](../decisions/ADR-0006-manual-finance-contracts.md) owns the financial/privacy decisions and
[ADR 0007](../decisions/ADR-0007-categories-sharing-allocations.md) owns the category, allocation, and
balance decisions below.
Existing session, CSRF, safe-error,
and `Cache-Control: no-store` conventions follow the [identity](identity-api.md) and
[household](household-api.md) APIs.

The [shared-finance contract](shared-finance-contract.md) extends the original equal allocation
contract with exact shares, external repayment records and contribution views; existing equal
calculations and durable creation-key replays remain supported. The
[financial-insights contract](financial-insights-contract.md) extends reporting with comparisons,
recurring evidence and explicit plans, budget targets and a coherent household summary. Plans
and budgets do not become ledger facts.

## Capabilities

- **Accounts:** private manual account create/list/detail/update and archive/unarchive with durable
  creation retries and household-scoped authorization.
- **Ledger:** private entries, linked refunds, transfers, correction and void retention, with
  durable retries and PostgreSQL concurrency controls.
- **Disclosure and classification:** fixed category taxonomy and per-transaction sharing/revocation,
  including linked refund groups.
- **Allocation:** exact participant shares and derived per-currency member balances.
- **Reporting:** household settings and authorized exact spending summaries.

Only delivered method/path combinations enter the security allowlist. Category/sharing, allocation/balance,
and settings/summary routes are allowlisted with their authorization and projection checks; all undocumented
methods and paths remain denied.

## Common transport rules

- All resource IDs are UUIDs. JSON field names and enum tokens are case-sensitive. Unknown request fields,
  duplicate JSON keys, unknown query parameters, duplicate query parameters, wrong scalar types, and unsupported
  enum values are rejected rather than ignored. No coercion of JSON numbers into money strings.
- Missing optional fields use their documented defaults. Explicit null is invalid for request fields unless
  specifically permitted; the transaction `category` is the documented exception. Responses include the
  documented nullable fields as null, not omitted. The fixed taxonomy and grouped balance responses are bounded
  and are exempt from the paginated page envelope, as documented in their sections.
- Body-bearing requests use `application/json`. Authentication derives the actor; household ID comes from the
  path and still requires membership. Unsafe operations require the existing session CSRF header.
- Resource mutation versions are nonnegative JSON integers, initially 0, bounded by 2147483647. A mutation
  increments once when state changes; an authorized current-version no-op returns unchanged version. Exhaustion
  fails safely with `RESOURCE_VERSION_EXHAUSTED` (409); do not wrap. Requests carry `expectedVersion`.
- UUIDs, money, dates, and enums have strict syntax. Names/descriptions use the existing household-name Unicode
  outer-trim and control-character policy; measure length in Unicode code points. Account names require 1–100;
  descriptions require 1–200. Preserve interior text. Financial data must not appear in diagnostic logs.
- Transaction dates range from `1900-01-01` through `9999-12-30`; report/filter boundaries may extend through
  `9999-12-31` so the final supported transaction date remains queryable in a half-open interval.

## Money boundary

Money is an object with exactly `amount` and `currency`, for example:

```json
{"amount":"-12.34","currency":"BRL"}
```

Currency is an uppercase allowlisted code: BRL/USD/EUR/GBP/CAD scale 2, JPY scale 0, KWD scale 3. CAD was added
with connected finance without changing the other currencies or their scales. Input amount grammar
is `-?(0|[1-9][0-9]{0,11})(\.[0-9]+)?`, further limited to at most the currency's scale fractional digits.
For scale 0 no decimal point is allowed. Reject whitespace, leading plus, exponent notation, commas, symbols,
leading zeros, negative zero, and zero transaction values. Amount strings are at most 17 characters (sign,
12 integral digits, decimal point, three fractional digits), bounded before parsing.

Fewer fractional digits are accepted and padded: BRL `"-12.3"` returns `"-12.30"`; KWD `"1"` returns `"1.000"`.
JPY `"1.0"` and BRL `"1.230"` fail even though trimming zeros could preserve numeric value. This makes the input
precision rule explicit. API validation must reject excess precision before a database driver can round it.

Maximum magnitude is `999999999999.99` for scale 2, `999999999999` for JPY, and `999999999999.999` for KWD.
Aggregate responses retain currency scale but may have more than 12 integral digits; the input bound is not an
aggregate truncation rule. Exact zero aggregates are `"0.00"`, `"0"`, or `"0.000"`, never negative zero.

## Accounts

Prefix: `/api/households/{householdId}/financial-accounts`.

| Method/path | Request | Success |
| --- | --- | --- |
| `POST` prefix | `name`, `kind`, `currency`; required `Idempotency-Key` header | 201 new account; 200 same-key replay |
| `GET` prefix | `limit`, `offset`, `status` | 200 page of the actor's own accounts |
| `GET` prefix`/{accountId}` | No body | 200 private account |
| `PATCH` prefix`/{accountId}` | `expectedVersion` plus at least one of `name`, `status` | 200 updated account |

Creation accepts exactly these fields:

```json
{"name":"Daily spending","kind":"CHECKING","currency":"BRL"}
```

`kind` is `CASH`, `CHECKING`, `SAVINGS`, or `CREDIT_CARD`. `currency` has no implicit default. Accounts created by
this endpoint have `source: MANUAL`, `visibility: PRIVATE`, `status: ACTIVE`, and version 0; these are not
create-request fields. Connected finance can add `source: CONNECTED` checking/savings/credit-card rows only through the
owner's explicit [connection account-selection flow](connected-finance-contract.md#7-browser-api-surface).
The authenticated actor owns the account. Duplicate labels create separate accounts under separate keys.

An account response has exactly:

```json
{
  "id":"10000000-0000-4000-8000-000000000001",
  "householdId":"20000000-0000-4000-8000-000000000001",
  "ownerUserId":"30000000-0000-4000-8000-000000000001",
  "name":"Daily spending",
  "kind":"CHECKING",
  "currency":"BRL",
  "source":"MANUAL",
  "visibility":"PRIVATE",
  "status":"ACTIVE",
  "version":0,
  "createdAt":"2026-09-16T12:00:00Z",
  "updatedAt":"2026-09-16T12:00:00Z"
}
```

GET responses use `source: MANUAL|CONNECTED`; the example remains a manually created account. `PATCH` accepts
`status: ACTIVE|ARCHIVED`. Archive/unarchive and rename are financial-owner-only; account kind,
currency, ownership, household, source, and privacy are immutable. Archive is not deletion; it prevents new
transactions while retaining all historical queries and corrections. No account balance is returned.

## Transactions

Prefix: `/api/households/{householdId}/transactions`.

| Method/path | Request | Success |
| --- | --- | --- |
| `POST` prefix | `accountId`, `kind`, `money`, `occurredOn`, `description`, optional `visibility`, optional `category`, refund-only `refundOfTransactionId`; required `Idempotency-Key` | 201 new entry; 200 same-key replay |
| `GET` prefix | `limit`, `offset`, `view`, optional `accountId`, `currency`, `from`, `to`, `status` | 200 authorized page |
| `GET` prefix`/{transactionId}` | No body | 200 authorized entry |
| `PATCH` prefix`/{transactionId}` | `expectedVersion` plus at least one of `money`, `occurredOn`, `description`, `visibility`, `category`, `status` | 200 updated entry |

Create example:

```json
{
  "accountId":"10000000-0000-4000-8000-000000000001",
  "kind":"EXPENSE",
  "money":{"amount":"-12.34","currency":"BRL"},
  "occurredOn":"2026-09-16",
  "description":"Groceries",
  "visibility":"PRIVATE"
}
```

Defaults are `visibility: PRIVATE`, `source: MANUAL`, `status: POSTED`, `category: null` (uncategorized), and
version 0. Source, status, owner, household, version, and server timestamps cannot be supplied at
creation. Transaction currency must equal the private source account's immutable currency; the account must be
active and owned by the actor.

A response has exactly:

```json
{
  "id":"40000000-0000-4000-8000-000000000001",
  "householdId":"20000000-0000-4000-8000-000000000001",
  "ownerUserId":"30000000-0000-4000-8000-000000000001",
  "accountId":"10000000-0000-4000-8000-000000000001",
  "kind":"EXPENSE",
  "money":{"amount":"-12.34","currency":"BRL"},
  "occurredOn":"2026-09-16",
  "description":"Groceries",
  "category":null,
  "visibility":"PRIVATE",
  "source":"MANUAL",
  "status":"POSTED",
  "refundOfTransactionId":null,
  "version":0,
  "createdAt":"2026-09-16T12:00:00Z",
  "updatedAt":"2026-09-16T12:00:00Z"
}
```

For another current member reading a `HOUSEHOLD` entry, `accountId` is null. All other documented fields are
intentional disclosures; no account metadata, email, related private IDs, or balance is embedded. A refund source
ID is disclosed only within its equally visible refund group. `refundOfTransactionId` is null on non-refunds and
required/non-null on refund creation; supplying it on any other kind, even as null, is a validation error.

### Corrections, refunds, and visibility

- `EXPENSE` amount must be negative; `INCOME` and `REFUND` positive; `TRANSFER` either sign. The UI takes a
  positive magnitude plus kind and, for transfers, direction, then encodes the signed string exactly.
- A refund source must be a `POSTED` `EXPENSE` owned by the same actor in the same account/household/currency.
  Its date cannot precede the expense's date. Refund visibility is inherited: omission inherits the source,
  explicit mismatch fails. Check reference access before returning semantic conflicts.
- Combined posted refunds may equal but never exceed the original expense magnitude. Expense amount/date
  corrections must preserve that bound and the date ordering of every live refund. An active
  allocation additionally blocks expense money correction entirely. Income/transfer entries cannot
  be refund sources. Cross-account refunds are not supported.
- Kind, account, refund source, owner, source, currency, and household cannot be changed. Partial `money` objects
  are invalid. A wrong kind/account is corrected by voiding and creating a new entry under a new key.
- `status` in a patch accepts only `VOIDED`, with required `expectedVersion` and no other mutable field.
  Voiding preserves data and excludes it from totals; voided economic fields cannot be restored or edited. An
  already voided record accepts a current-version void no-op. Visibility-only patches remain allowed on
  voided non-refund entries, including refund-group propagation, so retained history can still be made private.
  Void live refunds before voiding their expense.
- Setting an expense's visibility changes every linked refund's visibility, including retained voided
  refunds, in one transaction. Reject direct visibility updates on refunds. Under the household lock, use the
  expense version as the refund-group concurrency token: creation or any state-changing correction/void of a
  refund also increments its source expense version and updates its timestamp. A group visibility update increments versions/timestamps
  for each changed member. This makes a stale expense form conflict rather than unknowingly share a new refund.
- Changing `HOUSEHOLD` back to `PRIVATE` removes the refund group from
  other members' future reads/summaries but cannot retract already seen facts.
  With an active allocation, disclosure revocation and expense money changes
  are blocked until the owner revokes the allocation; see
  [allocations](#allocations-and-member-balances).

### Categories

- The original manual category taxonomy is fixed, server-owned and flat, with
  exactly 16 tokens. [Categorization](categorization-contract.md) subsequently
  added provenance, rules and optional suggestions; no category changes economic
  kind, spending inclusion or disclosure.
- Creation accepts `category` as an omitted field (uncategorized), explicit `null` (uncategorized), or exactly
  one taxonomy token. Patch accepts the same values; omission means no change and explicit `null` clears.
  Unknown, empty-string, wrong-type, or lowercase-mismatched tokens are `VALIDATION_FAILED` field errors on
  `category`. Category participates in the create fingerprint: omitted and explicit-null normalize to null for
  non-refunds; a refund records the inherit instruction (below) rather than the source's mutable value.
- A refund inherits its source expense's category. Omission inherits; an explicit token must equal the source's
  current category; explicit `null` is a mismatch unless the source is uncategorized; any mismatch fails
  validation on `category` without echoing submitted values. Direct category patches on refunds are always
  rejected. Patching the source expense's category propagates to every linked refund, including retained voided
  refunds, in one transaction under the refund-group lock, bumping the version and `updatedAt` of each refund
  whose category changed, exactly like a group visibility update.
- A direct `category` change on a voided entry is rejected with `TRANSACTION_VOIDED`. Category changes never
  affect shares, allocations, or balances.

## Transaction categories

`GET /api/households/{householdId}/transaction-categories` returns the fixed taxonomy to every current member.
It is a bounded fixed list, not a paginated collection.

| Method/path | Request | Success |
| --- | --- | --- |
| `GET` `/api/households/{householdId}/transaction-categories` | No body, no query parameters | 200 fixed category list |

The response always contains exactly these 16 items, in this order: `HOUSING`, `GROCERIES`, `DINING`,
`UTILITIES`, `TRANSPORTATION`, `SHOPPING`, `ENTERTAINMENT`, `HEALTHCARE`, `TRAVEL`, `EDUCATION`, `PERSONAL`,
`HOUSEHOLD_SUPPLIES`, `SUBSCRIPTIONS`, `INCOME`, `TRANSFERS`, `MISCELLANEOUS`.

```json
{
  "items":[
    {"code":"HOUSING","label":"Housing"},
    {"code":"GROCERIES","label":"Groceries"},
    {"code":"TRANSFERS","label":"Transfers"},
    {"code":"MISCELLANEOUS","label":"Miscellaneous"}
  ]
}
```

Labels are server-returned display text, not localized, and are the only user-visible category names;
clients must render returned labels and must not derive labels from tokens. The category `code` is the same
case-sensitive token accepted by transaction create/patch. Non-members receive the generic household 404.

## Allocations and member balances

Prefix: `/api/households/{householdId}/transactions/{transactionId}/allocation` — singular, because an expense
has at most one active allocation. [Shared finance](shared-finance-contract.md) adds exact participant shares
and a read-only current refund preview;
existing equal allocations and their durable request keys retain their historical semantics.

| Method/path | Request | Success |
| --- | --- | --- |
| `POST` prefix | `expectedVersion` and **exactly one** of `participantUserIds` (EQUAL) or `participantShares` (EXACT); required `Idempotency-Key` header | 201 new allocation; 200 same-key replay |
| `POST` prefix `/preview` | Same body union, CSRF; no idempotency key | 200 current calculation, no reservation or mutation |
| `GET` prefix | No body | 200 active allocation with current impact |
| `PATCH` prefix | `expectedVersion` plus exactly `status: "REVOKED"` | 200 revoked allocation with `impact: null` |

### Eligibility, creation, and concurrency

- Only the expense's financial owner may create or revoke an allocation. The expense must be a `POSTED`
  `HOUSEHOLD` `EXPENSE` with no active allocation; otherwise the mutation returns `409 ALLOCATION_CONFLICT`.
  A hidden, missing, or foreign expense answers the generic resource 404 before any eligibility signal.
- EQUAL's `participantUserIds` is a nonempty array of distinct current household member UUIDs; EXACT uses
  `participantShares: [{"userId":"…","share":{"amount":"7.00","currency":"USD"}},…]`.
  Supply exactly one nonempty array, never both. UUIDs must be distinct before canonical sorting and current
  under the lifecycle lock. Every exact amount must be nonnegative at the expense currency's scale, at most the
  original expense magnitude, and all shares must sum to **the entire magnitude**. Explicit zero shares and
  payer inclusion, exclusion, or payer-only allocation are valid; there is no implicit personal remainder.
  Malformed, duplicate, nonmember, wrong-currency, negative, imprecise, or wrong-sum inputs return
  `VALIDATION_FAILED` on `participantUserIds` or `participantShares` as appropriate.
- `expectedVersion` must equal the expense's current transaction version. Creation and revocation each bump
  the expense version once, so stale expense forms and stale revoke calls return
  `409 RESOURCE_VERSION_CONFLICT` instead of acting on moved state. The expense version is the allocation's
  only concurrency token; the allocation itself carries no separate mutable version.
- Creation freezes the expense magnitude, ordered participants, original shares, `method` and `refundPolicy`.
  EQUAL divides once with remainder minor units awarded in ascending canonical user UUID order; EXACT stores
  the supplied canonical-scale shares in that order. The participant set and shares never change; revoke and
  recreate under a **fresh key** to correct them.
- Creation idempotency scope is `(actor user UUID, household UUID, ALLOCATION_CREATE, key)`. EQUAL retains its
  historical SHA-256 fingerprint byte-for-byte: transaction ID, `expectedVersion`, sorted participants joined
  with NUL separators. EXACT uses SHA-256 of NUL-separated `EXACT_V1`, transaction UUID, decimal version,
  then each sorted UUID/currency/canonical-scale-share triple. Same-key replay reauthorizes membership and
  financial ownership, then returns 200 with the current representation (possibly revoked) without reapplying
  create preconditions. A rolled-back create reserves nothing. `PATCH` has no key: its version guard prevents
  a stale retry. Preview also has no key and does not reserve a future creation.

An allocation response has exactly:

```json
{
  "id":"50000000-0000-4000-8000-000000000001",
  "transactionId":"40000000-0000-4000-8000-000000000001",
  "householdId":"20000000-0000-4000-8000-000000000001",
  "payerUserId":"30000000-0000-4000-8000-000000000001",
  "currency":"USD",
  "originalAmount":{"amount":"10.00","currency":"USD"},
  "participants":[
    {"userId":"30000000-0000-4000-8000-000000000001","share":{"amount":"3.34","currency":"USD"}},
    {"userId":"30000000-0000-4000-8000-000000000002","share":{"amount":"3.33","currency":"USD"}},
    {"userId":"30000000-0000-4000-8000-000000000003","share":{"amount":"3.33","currency":"USD"}}
  ],
  "status":"ACTIVE",
  "createdAt":"2026-09-16T12:00:00Z",
  "revokedAt":null,
  "transactionVersion":1,
  "method":"EQUAL",
  "refundPolicy":"EQUAL_V1",
  "impact":{
    "cumulativeRefundAmount":{"amount":"0.00","currency":"USD"},
    "payerCredit":{"amount":"10.00","currency":"USD"},
    "participants":[
      {"userId":"30000000-0000-4000-8000-000000000001","cumulativeRefundShare":{"amount":"0.00","currency":"USD"},"remainingObligation":{"amount":"3.34","currency":"USD"}},
      {"userId":"30000000-0000-4000-8000-000000000002","cumulativeRefundShare":{"amount":"0.00","currency":"USD"},"remainingObligation":{"amount":"3.33","currency":"USD"}},
      {"userId":"30000000-0000-4000-8000-000000000003","cumulativeRefundShare":{"amount":"0.00","currency":"USD"},"remainingObligation":{"amount":"3.33","currency":"USD"}}
    ]
  }
}
```

- `participants` is ordered by canonical UUID; each `share` is a frozen original, and shares sum exactly to
  `originalAmount`. EQUAL remainder ordering can produce a zero share for a small magnitude; EXACT explicitly
  permits zero shares. `method` and `refundPolicy` are immutable pairs: `EQUAL/EQUAL_V1` or
  `EXACT/EXACT_JEFFERSON_V1`. The `impact` on ACTIVE resources is computed from all current posted refunds,
  not only the visible transaction page. A same-key replay of a since-revoked creation returns `status: REVOKED`,
  non-null `revokedAt`, frozen shares and `impact: null`; later changes must not project a revoked magnitude.
  `transactionVersion` is the expense version at response time and is informational only; mutations must
  read the expense's live version first. All existing ACTIVE and REVOKED rows were tagged EQUAL/EQUAL_V1
  without recomputing shares, amounts, versions, timestamps, or idempotency fingerprints in forward migration V19.
- Reads: every current member may `GET` the active allocation of an expense they are authorized to read (their
  own, or a `HOUSEHOLD` entry). An authorized expense without an active allocation answers
  `404 ALLOCATION_NOT_FOUND`, including for the owner after revocation. Revoked allocations are retained
  server-side but no route returns them, so a later visibility revocation leaks nothing about the old
  allocation.
- Mutations: only the financial owner. Another member's `POST` or `PATCH` on a household-visible expense is
  `403 FORBIDDEN`, and on a hidden or foreign expense it is the generic resource 404. `PATCH` accepts only
  `status: "REVOKED"` with a current `expectedVersion`; patching when no active allocation exists answers
  `ALLOCATION_NOT_FOUND`.


`POST` prefix `/preview` accepts the same union and `expectedVersion`, requires CSRF and the financial owner,
but rejects an `Idempotency-Key`. It checks current roster, eligible posted/shared expense, active-allocation
conflict, version and the entire locked refund group; it does **not** reserve a key, create an allocation, or
bump a version. Its seven fields are exactly `transactionId`, `transactionVersion`, `method`,
`refundPolicy`, `originalAmount`, `participants`, and `impact`, using the same original-share and impact
shapes as the resource. Creation recomputes everything under the same locks and can still fail if a refund,
version, roster, or active allocation moved.

### Refund and balance mathematics

- Original participants and shares stay frozen through membership changes. Refund shares are **not stored per
  refund**: for original minor-unit magnitude `M`, frozen shares `s_i`, and cumulative current `POSTED` refund
  magnitude `R` across the complete linked group, calculate tagged cumulative `F_i(R)`:
  - `EQUAL_V1` keeps historical equal division of `R` and ascending-UUID remainder, **not** proportional
    reinterpretation of the legacy original shares.
  - `EXACT_JEFFERSON_V1` takes the first `R` exact priorities `s_i/k` (`k=1…s_i`), descending; UUID ascending
    breaks ties. It starts with BigInteger floors `⌊R·s_i/M⌋`, then awards fewer than the participant count in
    remainder minor units using a bounded exact-priority heap. This highest-averages policy is monotone and
    conservative, but can favor a larger share over the closest proportional cent. Corrected/voided refunds
    recompute the cumulative function; no per-record rounding or persisted refund allocation is involved.
- Participant remaining obligation is `s_i − F_i(R)`; payer credit is `M − R`. Payer credit minus all
  obligations is exactly zero in each currency, including when the payer is a participant or is absent. A
  full refund exactly reverses all frozen shares and removes nonzero balances.

| EQUAL example (USD 10.00, participants A/B/C ascending) | R | Refund shares A/B/C | Obligations A/B/C | Payer credit |
| --- | --- | --- | --- | --- |
| Allocated, no refund | 0.00 | — | 3.34 / 3.33 / 3.33 | 10.00 |
| Refund 1.00 posted | 1.00 | 0.34 / 0.33 / 0.33 | 3.00 / 3.00 / 3.00 | 9.00 |
| Second refund 2.00 posted (R = 3.00) | 3.00 | 1.00 / 1.00 / 1.00 | 2.34 / 2.33 / 2.33 | 7.00 |
| Full refund posted (R = 10.00) | 10.00 | 3.34 / 3.33 / 3.33 | 0.00 / 0.00 / 0.00 | 0.00 |

- For JPY scale 0 the same rule applies in whole units: 1000 JPY across three participants is 334/333/333.
- EXACT USD 10.00 with payer A retaining 7.00 and B owing 3.00: at cumulative refund 1.00,
  `EXACT_JEFFERSON_V1` reverses 0.70/0.30, leaving obligations 6.30/2.70 and payer credit 9.00.
  Net balances are +2.70/-2.70. If the payer is absent from the participant list, their original
  obligation is zero; every cent still belongs to an explicit non-payer participant.

### Interaction with transaction mutations

- While an allocation is active, expense money correction returns `409 ALLOCATION_CONFLICT`, and a
  `visibility` patch from `HOUSEHOLD` to `PRIVATE` returns `409 ALLOCATION_CONFLICT`. Description,
  `occurredOn`, and `category` changes remain allowed under their existing rules (refund date ordering, group
  propagation, voided-entry restrictions); they change no shares.
- Revoke the allocation first — obtaining the new expense version — then patch visibility or money.
- Voiding the expense remains gated by the existing rule that live refunds must be voided first; the void and
  the allocation deactivation (`status: REVOKED`, `revokedAt` set) commit atomically in one transaction. A
  voided expense cannot be restored, and its deactivated allocation is never returned again.
- Refund create/correct/void remain allowed while an allocation is active; each changes `R` and therefore
  derived balances, under the existing refund-group locks and expense-version bump.
- Deterministic lock order for allocation and group mutations: household lifecycle lock, then the expense's
  account lock, then the source expense row, then linked refund UUIDs ascending, then allocation rows.
  Membership removal takes the lifecycle lock first, so no finance mutation commits after removal. Bounded
  five-second lock timeouts and `FINANCE_BUSY` behavior are unchanged.

### Member balances

`GET /api/households/{householdId}/member-balances` — every current member may read it. The example shows the
no-refund state of the USD 10.00 expense above with the payer included and participant C departed: payer credit
10.00 minus their own 3.34 share leaves 6.66 owed, and the departed participants keep their recorded
obligations. Response:

```json
{
  "currencies":[
    {
      "currency":"USD",
      "balances":[
        {"userId":"30000000-0000-4000-8000-000000000001","membershipStatus":"CURRENT","amount":"6.66"},
        {"userId":"30000000-0000-4000-8000-000000000002","membershipStatus":"CURRENT","amount":"-3.33"},
        {"userId":"30000000-0000-4000-8000-000000000003","membershipStatus":"DEPARTED","amount":"-3.33"}
      ]
    }
  ]
}
```

- Currencies are ordered by code; balances inside a currency are ordered by ascending canonical user UUID.
  `amount` is an exact currency-scale string: positive means the user **is owed**, negative means the user
  **owes**; `"0.00"`-style exact zeros are the scale's zero.
- `membershipStatus` is derived at read time: `CURRENT` when the user holds an active membership row in this
  household, otherwise `DEPARTED`. No email, display name for a departed user, or other profile data is
  included; identity is the stable user UUID only.
- Every user with a nonzero combined obligation appears, including departed payers, departed participants and
  confirmed-repayment parties. Exact zero balances and entire zero currencies are omitted; with neither
  active allocations nor confirmed repayments, the response is `{"currencies":[]}`. Each currency sums to zero.
- Active allocations contribute the `POSTED` `HOUSEHOLD` expense magnitude and current `POSTED` refunds through
  `R`. Confirmed external repayments contribute **+accepted amount to sender / −accepted amount to recipient**,
  even when a replacement/void amendment is pending or the originating expense is refunded or its allocation
  revoked. Pending, rejected, cancelled and voided repayments contribute nothing. Private, unallocated, voided
  and revoked-allocation ledger entries contribute nothing, including their refunds; ledger `TRANSFER` entries
  never automatically adjust these balances. Overpayments may reverse who owes whom.
- Allocation deltas, effective confirmed repayments and current/departed membership are read under one
  household lifecycle lock before dropping zeros. There is no FX conversion or grand total across currencies.

## External repayments and settlement suggestions

An external repayment is a **record of a completed transfer**, not a HouseSync payment or a bank verification.
It has no transaction, account or allocation reference; a manual/imported `TRANSFER` remains independent.
Only its sender and recipient while current members may see its amount, date, status, event history or pending
amendment. A third party, even a household `OWNER`, gets an empty party list and generic 404
`REPAYMENT_NOT_FOUND` for direct record/event IDs. All current members may see the resulting **net** member
balances and suggestions; these aggregates can imply that payment activity occurred.

Prefix: `/api/households/{householdId}/repayments`.

| Method/path | Exact request | Success |
| --- | --- | --- |
| `POST` prefix | `{recipientUserId,money,occurredOn}`, plus UUID `Idempotency-Key` | 201 `PENDING` version 0; 200 authorized same-key replay |
| `GET` prefix | Optional `limit,offset,currency,status,from,to` | Party-only page |
| `GET` prefix`/{id}` | No query/body | Current party-only record |
| `POST` prefix`/{id}/decision` | `{expectedVersion,decision}`; `CONFIRM`, `REJECT` or `CANCEL` | Current record |
| `POST` prefix`/{id}/amendment` | `{expectedVersion,action}` for `VOID`, or additionally `money,occurredOn` for `REPLACE` | One pending amendment |
| `POST` prefix`/{id}/amendment/decision` | `{expectedVersion,decision}`; `CONFIRM`, `REJECT` or `CANCEL` | Current record |
| `GET` prefix`/{id}/events` | Optional `limit,offset` | Party-only immutable event page |

The server sets `senderUserId` from the session; `recipientUserId` must name a distinct current member.
`money` is a positive exact amount in one of the seven supported currencies, with immutable currency/parties.
`occurredOn` is a completed date from 1900-01-01 through the household-zone today (at most 9999-12-30).
Initial confirmation and confirmation of a replacement recheck that bound. An authorized same-key creation
replay keeps its historical key and resource after departure/rejoin and does not reapply current date/recipient
eligibility. Different normalized facts under the key return 409 `IDEMPOTENCY_CONFLICT`; two distinct
real payments may legitimately have the same amount/date.

The record has exactly `id,householdId,senderUserId,recipientUserId,money,occurredOn,status,version,createdAt,`
`updatedAt,confirmedAt,voidedAt,pendingAmendment,allowedActions`. Status is
`PENDING|CONFIRMED|REJECTED|CANCELLED|VOIDED`. `pendingAmendment` is null or
`{action,proposedByUserId,money,occurredOn,createdAt}`; `VOID` has null proposed money/date.
`allowedActions` is ordered server advice, never permission granted by the client. Recipient alone can
confirm/reject a pending assertion; sender can cancel. Either party may propose a replacement or void of a
confirmed record; only the *other* party may confirm/reject it, proposer may cancel it. The previously
confirmed amount remains effective until the amendment is confirmed. Departed parties cannot read or give
positive consent until rejoining, but the remaining party may reject/cancel a pending item. Rejected,
cancelled and voided records are terminal; an accepted void corrects a mistaken record, not a return payment.
Every successful versioned transition increments the parent version once and appends an immutable event
atomically. Versioned POST outcomes are never blindly retried: fetch the current record/events and review.
Events are ascending-version pages with exactly
`{version,eventType,actorUserId,recordedAt,status,money,occurredOn,pendingAmendment}`.
The page envelope is `{items,limit,offset,hasMore}`, with default 50, limit 1–100 and offset 0–10000;
scope parties **before** filtering, sorting and `hasMore`. Status defaults `ALL`, accepts the five states
or `ALL`; `from` inclusive/`to` exclusive are both supplied or neither. No full-history export is promised.

`GET /api/households/{householdId}/settlement-suggestions?currency=USD&limit=50` is read-only and available
to every current member. Currency is required and explicit; limit defaults 50, maximum 100. The exact
five-field response is `currency,snapshot,items,nextCursor,residuals`. Each item has
`{senderUserId,recipientUserId,money}`; residuals has
`{currentDebtAfterPlan,currentCreditAfterPlan,departedDebt,departedCredit}` as nonnegative exact
currency-scale strings **for the entire plan**, not just the displayed page. This plan greedily pairs current
negative/positive members in ascending canonical UUID order, using the smaller outstanding amount.
DEPARTED balances remain in the zero-sum vector but never form suggested payment edges; residuals make
unmatched current/departed amounts explicit. Empty currency balances return an empty plan and exact zeros,
not a default inferred from ledger data. Suggestions neither execute nor record payments.

`snapshot` is a lowercase SHA-256 freshness fingerprint over household, currency, algorithm
`CURRENT_UUID_GREEDY_V1` and the sorted nonzero balance/member-status vector. The opaque base64url
`cursor` (at most 1024 characters) names the next edge in that snapshot. Each page recomputes the full
authorized vector under the household lifecycle lock; changed money or relevant membership returns
409 `SETTLEMENT_SNAPSHOT_STALE`, requiring a first-page restart. Invalid, wrong-currency or out-of-range
cursors return 400 `VALIDATION_FAILED`; `nextCursor` is null only after the last edge. Responses are
`Cache-Control: no-store`, never expose private repayment histories or account IDs, and contain no
grand total or cross-currency conversion.

## Period contribution summary

`GET /api/households/{householdId}/contribution-summary?from=2026-09-01&to=2026-10-01&currency=USD`
answers **who paid** for disclosed household purchases and **who bears their currently assigned cost**.
Any current member may read it; household `OWNER` has no broader private-data scope. Required `from`/`to`
are valid dates in `[1900-01-01,9999-12-31]`, with `from < to` and a half-open interval; required currency
is one explicit supported code. Optional `limit` is 1–100 (default 50), `offset` 0–10000 (default 0),
and `snapshot` a lowercase 64-character SHA-256. Offset > 0 requires a supplied snapshot. Unknown,
duplicate, blank, malformed, out-of-range or contradictory query values return 400 `VALIDATION_FAILED`.
The response has `Cache-Control: no-store` and exactly these top-level fields:

`{from,to,reportingTimeZone,currency,snapshot,totals,items,limit,offset,hasMore}`.

`totals` has exactly five **whole-population** exact-scale strings:
`{expenseTotal,refundTotal,netSpending,allocatedCostTotal,unallocatedNet}`. Expense/refund totals
are positive magnitudes; net spending, allocated cost and unallocated net can be negative in a refund-only
period. Each ascending-UUID `items` row has exactly
`{userId,membershipStatus,expensePaid,refundReceived,netPaid,allocatedCost}`. Paid/refund values are
nonnegative; net paid and assigned cost may be negative. `CURRENT`/`DEPARTED` is the user's status now,
not at month end. Emit a row only when at least one amount is nonzero; never pad with roster/profile data.
The explicitly selected currency returns exact zero totals and `items: []` when empty; it does not infer
a default currency from balances or create a dashboard currency group.

Only currently `POSTED` `HOUSEHOLD` expenses/refunds contribute, even when the owner departed or an account
was archived. Private, voided, income, transfer, connected pending/unadmitted, category/rule/AI and all
repayment facts are excluded. For period $P=[from,to)$, each expense payer gets its expense magnitude as
`expensePaid_i`; each posted refund owner gets its refund magnitude as `refundReceived_i`;
`netPaid_i=expensePaid_i−refundReceived_i`. Every *active* allocation assigns frozen participant share
`s_i` when its source expense occurred in P, then subtracts
`F_i(R_<to)−F_i(R_<from)`, where `R_<x` is the source's **cumulative current posted refund magnitude**
strictly before x and F is the persisted EQUAL_V1 or EXACT_JEFFERSON_V1 tagged policy. Refunds outside P
must contribute to these endpoints; never independently round each refund row. Exact conservation:
`sum(netPaid_i)=netSpending`, and `sum(allocatedCost_i)+unallocatedNet=netSpending`. Unallocated net
represents eligible spending whose expense group has **no active allocation**, not guessed owner cost.
For example a September USD10.00 expense paid by A with EXACT A7/B3 costs A7/B3 in September;
an October USD1.00 refund produces A−1.00 net paid and A−0.70/B−0.30 October assigned costs.
Accepted repayment of USD2.70 affects the separate *all-time* net balances but **no** period column.
Current allocation revoke restates prior periods' assigned cost into unallocatedNet; explicitly unsharing
the expense/refund group excludes those facts entirely. Never describe this as historical as-of debt.

The server computes totals and all nonzero rows under one authorized household lifecycle lock, then pages
rows by canonical UUID. `snapshot` is a freshness fingerprint, not an access credential: SHA-256 over
the domain `HouseSync:contribution-summary`, tag `CONTRIBUTIONS_V1`, household ID, period bounds,
reporting zone, currency, five totals in response order, four-byte big-endian row count and each sorted
row's six fields. Every string is UTF-8 framed by a four-byte big-endian length; the digest is lowercase
hex. A supplied snapshot that differs from the current full projection returns
409 `CONTRIBUTION_SNAPSHOT_STALE` (even if spending totals still match). Each page reauthorizes and
recomputes; `hasMore`/`limit`/`offset` apply to rows **only**, never to totals. The UI restarts at page
one on a stale continuation and labels the member list incomplete at offset 10000; totals still cover
everyone. No saved as-of snapshot, FX/grand total, account grouping, period repayment sent/received,
repayment count or inferred payment appears in this response.

## Collection and query contract

Account, transaction, repayment and repayment-event lists use
`{"items":[...],"limit":50,"offset":0,"hasMore":false}` with no total count. The fixed
category list, grouped balance response, cursor-paged settlement suggestions and snapshot-bound
contribution summary are exceptions. `limit` defaults to 50, range 1–100; `offset` defaults to 0,
range 0–10000, with decimal integers only. Fetch at most `limit + 1` authorized list rows to derive
`hasMore`; no unbounded history export. Concurrent updates may shift ordinary offset pages, so the UI
refreshes from page 1 after mutations and deduplicates by ID. Contributions instead recompute the full
authorized projection before slicing rows and require the snapshot for continuation.

- Accounts: order `createdAt ASC, id ASC`; `status` defaults to `ACTIVE`, accepts `ACTIVE|ARCHIVED|ALL`.
- Transactions: order `occurredOn DESC, createdAt DESC, id DESC`; `status` defaults to `POSTED`, accepts
  `POSTED|VOIDED|ALL`. Sorting uses stored timestamps/UUIDs, not locale-specific formatted strings.
- Repayments: party scope before filters/paging; order `createdAt DESC, id DESC`; `status` defaults to `ALL`,
  accepts the five record states or `ALL`. Events use the same page envelope and ascending version order.
  Suggestions instead use a bounded opaque snapshot cursor, never an offset.
- `view` defaults to `OWN`: all of the actor's entries, private or household-visible. `HOUSEHOLD` means
  only household-visible entries from any owner, including departed owners; it does not include the viewer's
  additional private records. `accountId` is accepted only with `OWN`, requires private account ownership,
  and returns the same generic account 404 for hidden/missing/foreign accounts. Archived accounts can be filtered.
- **Visibility filter:** `GET .../transactions` accepts optional `visibility=PRIVATE|HOUSEHOLD` only with
  `view=OWN` (including the omitted OWN default). Omission means all of the actor's private and
  household-visible entries; `ALL`, blank, unknown or duplicate values, or a visibility selector
  with `view=HOUSEHOLD`, return safe 400 `VALIDATION_FAILED`. Membership, financial ownership and
  visibility apply in SQL before ordering/paging and `hasMore`. The web offers All / Private /
  Shared by me for own entries and bounded Load more for both feeds, keeping `status=ALL` so
  retained voided history is reachable. Offset 10000 is inclusive; further history is explicitly
  incomplete when the server reports more. A refund's inherited visibility is managed through its
  authorized source expense, even when that expense lies outside the loaded page.
- Optional currency filters use the allowlist. `from` is inclusive and `to` exclusive; supply both or neither,
  use supported dates and require `from < to`. Date and currency filters apply in SQL **after** the applicable
  transaction visibility or repayment party scope, never to an unrestricted in-memory result.

## Durable creation retries and concurrent writes

`Idempotency-Key` is one UUID header for account, transaction, allocation and external repayment creation.
Missing or malformed keys are 400. Scope is
`(actor user UUID, household UUID, operation ACCOUNT_CREATE|TRANSACTION_CREATE|ALLOCATION_CREATE|REPAYMENT_CREATE, key)`
with a database unique constraint. Normalize money and creation facts, then store a canonical request fingerprint
and server-generated resource ID atomically with creation.

- First committed create returns 201. Same scoped key and normalized request returns 200 with the **current**
  authorized resource, not a second creation or a stale snapshot. Account/transaction/allocation replay checks
  current membership and financial ownership; repayment replay checks current membership and sender-party
  authority (including rejoin), without rerunning its original recipient eligibility or historical date bound.
  Other current create preconditions, such as an account now archived or a fully used refund, are not reapplied.
- The fingerprint describes the original normalized input, not the edited resource. Omitted refund visibility
  is recorded as an inheritance instruction rather than replaced in the fingerprint by mutable source visibility;
  omitted non-refund visibility normalizes to `PRIVATE`. Category behaves the same: omitted and explicit-null
  non-refund category normalizes to uncategorized, and omitted refund category is an inheritance instruction.
  Equivalent money strings such as `"1"` and `"1.00"` have the same fingerprint after successful scale validation.
- Same key with different normalized input returns 409 `IDEMPOTENCY_CONFLICT`. A rolled-back create leaves no
  success record/key reservation; a subsequent valid attempt may use the key. Simultaneous duplicates serialize
  through the unique constraint and household lock. Never infer duplicates from amount/date/description.
- Persist associations for the resource's retention lifetime, including after archive, void, removal, and rejoin.
  Do not log keys, request fingerprints, descriptions, or financial payloads. Authenticated replay uses no-store.
- Updates compare `expectedVersion` after authorization under the lifecycle lock and resource locks. Stale writes
  return 409 `RESOURCE_VERSION_CONFLICT`; include no current private values in the error. Cross-row changes
  commit atomically. Refund-group operations lock the source expense first, then refund UUIDs in ascending order
  after the household/account locks. The response exposes the new target version; refresh related records.
- Use a transaction-local PostgreSQL lock timeout of five seconds for finance operations; on lock timeout roll
  back the entire transaction and return `FINANCE_BUSY`. Do not leave a partially reserved key or partial mutation.

## Reporting

- `GET /api/households/{householdId}/finance-settings` returns exactly `{"reportingTimeZone":"Etc/UTC","version":0}`.
  All current members may read it. `PATCH` requires current household `OWNER`, CSRF, and exactly
  `reportingTimeZone` plus `expectedVersion`; it returns the updated object. Accept IANA region names in the JVM
  zone-ID set (including `Etc/UTC`); reject bare offsets and short aliases such as `EST`. Existing/new households
  begin at `Etc/UTC`. Use the household lifecycle lock.
- `GET /api/households/{householdId}/spending-summary?from=2026-09-01&to=2026-10-01` requires both dates and current
  membership. Response fields are `from`, `to`, `reportingTimeZone`, and `currencies`. Each currency entry has
  `currency`, `expenseTotal`, `refundTotal`, `netSpending`, and `incomeTotal`, all amounts exact strings; order by
  currency code. Expense/refund/income totals are nonnegative magnitudes. `netSpending = expenseTotal - refundTotal`.
  Include only currencies with authorized posted entries in the interval; an included currency with only transfers
  has zero values. No entries yields `currencies: []`, never an invented default-currency zero.
- Only household-visible, posted entries contribute, including entries belonging to departed members or archived
  accounts. Transfers contribute zero; private and voided entries contribute nothing and do not introduce a
  currency bucket. There is no all-currency grand total and no account/member balance in this response.
- Browser default dates derive from the household zone and current clock, never browser/server default zones;
  always show the actual period and zone. The server applies the explicit date interval, not timestamp conversion.
  Implement a coherent authorized snapshot for all grouped sums and settings.

## Authorization and safe errors

| Actor/resource | Read | Mutate |
| --- | --- | --- |
| Unauthenticated | 401 | 401, or existing security-layer CSRF rejection when token is absent |
| Non-member / removed actor / missing household | Generic household 404 | Same |
| Current member, own account or own entry | Allowed | Allowed within lifecycle/version rules |
| Current member, another's private account/entry | Generic resource 404 | Same, including household owners |
| Current member, another's household-visible entry | Redacted account reference | 403 `FORBIDDEN` |
| Current member, transaction categories list | Allowed (fixed list) | No mutation routes |
| Current member, active allocation of an authorized expense | Allowed | Only the expense's financial owner; others 403 |
| Current member, combined member balances or settlement suggestions | Allowed | Read-only; suggestion edges are not payments |
| Current sender/recipient, own repayment/event | Allowed while current | State/party/other-party consent and version rules |
| Current non-party, another repayment/event (including `OWNER`) | Generic repayment 404; no list rows | Same 404 |
| Current member, household finance settings | Allowed | Only household `OWNER`; others 403 |

Use the existing `{code,message,correlationId,fieldErrors?}` error shape. Optional field errors only name known
input fields (nested money fields may use `money.amount` and `money.currency`); never echo submitted values.

| Status/code | Meaning |
| --- | --- |
| 400 `VALIDATION_FAILED` | Shape, unsupported value, money/sign/scale/currency mismatch, date/name, query, or header validation |
| 415 `VALIDATION_FAILED` | Unsupported body media type |
| 401 `UNAUTHENTICATED`; 403 `CSRF_INVALID` / `FORBIDDEN` | Existing session/CSRF/action policy |
| 404 `HOUSEHOLD_NOT_FOUND` | Missing household or actor no longer a member |
| 404 `FINANCIAL_ACCOUNT_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | Missing, foreign, or hidden resource; identical safe code/message within resource type |
| 404 `ALLOCATION_NOT_FOUND` | Authorized expense without an active allocation, including revoked or never-allocated |
| 404 `REPAYMENT_NOT_FOUND` | Missing, foreign, or another party's repayment/event, including household owners |
| 409 `ACCOUNT_ARCHIVED` | Creating a new entry in an authorized archived account |
| 409 `RESOURCE_VERSION_CONFLICT` / `RESOURCE_VERSION_EXHAUSTED` | Stale update or safe version limit |
| 409 `IDEMPOTENCY_CONFLICT` | Key reused with different input |
| 409 `REFUND_CONFLICT` | Authorized refund group violates live source, sum cap, date ordering, or void dependency |
| 409 `TRANSACTION_VOIDED` | Attempt to edit economic fields of, or restore, a voided record |
| 409 `ALLOCATION_CONFLICT` | Allocation ineligibility, or a mutation blocked by an active allocation |
| 409 `REPAYMENT_CONFLICT` | Authorized invalid consent/amendment transition or unavailable counterparty |
| 409 `SETTLEMENT_SNAPSHOT_STALE` | Balance/member vector changed after a suggestion cursor; restart from page one |
| 409 `CONTRIBUTION_SNAPSHOT_STALE` | Any supplied contribution fingerprint differs from the current full authorized projection; restart page one |
| 503 `FINANCE_BUSY` | Bounded lock contention/timeout; outcome may be unknown to the client |
| 500 `INTERNAL_ERROR` | Other safe failure |

Validate syntax without exposing resources; after authentication/CSRF, resolve current membership, then authorized
resources, then semantic conflicts. Never expose account status, refund sum, version, or key existence before
authorization. Reuse existing correlation handling and security-filter precedence.

## Persistence and application integration

- Forward-only Flyway migrations after V7 preserve existing migrations and existing users, sessions,
  and finance data. Account/transaction UUID primary keys, user/household restrictive foreign keys,
  enum/name/version constraints, and durable idempotency uniqueness are required. Records cannot reference
  membership rows that leave/removal deletes. A composite account reference must enforce transaction
  household/owner/currency consistency in the DB.
- Categories and sharing ship in one forward migration: the transaction `category` nullable column with the exact
  16-token check constraint, and the visibility check widened from `PRIVATE`-only to `PRIVATE`/`HOUSEHOLD`. Allocations ship in a
  separate forward migration: `financial_transaction_allocations` (allocation UUID key, restrictive
  transaction/household references, immutable currency, positive original magnitude, `ACTIVE`/`REVOKED` status,
  server timestamps) with frozen `financial_transaction_allocation_participants` rows (allocation reference,
  stable-user reference, persisted exact share), the `ALLOCATION_CREATE` idempotency table, and a partial unique
  index enforcing one active allocation per expense. The category/sharing migration precedes the allocation
  migration; they are not combined.
- Refund references enforce same account/owner/household/currency, with live expense/type/date/sum checks under
  transactional locks. Allocation rows mirror their expense's household/owner/currency with restrictive stable
  user references — never membership rows — so departure freezes the recorded participants instead of deleting
  their history. Persisted shares sum to the expense magnitude transactionally under the expense lock; aggregate
  share/refund invariants are tested under concurrency, not assumed from DTO validation.
- Obtain membership plus lifecycle locking through the household application's public use case within the finance
  transaction. Queries project only authorized fields, including account-reference redaction. Do not expose JPA
  entities or depend on browser state for permissions.

## Browser contract

- Show explicit account currency and privacy on creation; currency/kind become immutable after creation. Provide
  archive and unarchive with explanations of preserved history. Empty states have no synthetic balance.
- Use the household's selected reporting zone for default manual dates and future-date warnings; existing and new
  households begin at `Etc/UTC` until an owner changes it.
- Keep financial input as strings; use a labeled decimal text control with `inputmode="decimal"`, not number
  arithmetic. Explain decimal-point input and reject ambiguous localized separators. Display signs and codes
  explicitly; never communicate direction/privacy/errors through color alone.
- Generate one create key per form submission intent and retain it with the exact request while the outcome is
  unknown. An explicit retry reuses both. Do not resend an edited payload under an uncertain key; reconcile the
  original operation first. An explicit new entry after a known outcome gets a fresh key.
- On timeout/503, show unknown outcome and offer same-key retry or refresh; do not claim failure or auto-replay.
  On version conflict reload before offering a correction. On CSRF error refresh the token and require explicit
  retry. Disable duplicate controls while pending. State is memory-only; after a page reload, review the list
  before creating again because the client has lost its key. Do not promise cross-device retry recovery.
- On household change, logout, confirmed expiry, or access 404, clear scoped finance data, drafts, keys, and
  pending callbacks. Cancel/ignore old responses. A network failure is not proof of lost membership. Sharing
  refreshes both own and household views; shared detail 404 clears stale detail. No financial data in web storage.
- Confirm household disclosure with a preview of the exact visible fields, explain that all current/future members
  can read it, and keep a clear revoke action. A refund inherits its source's disclosure; changing the expense
  previews that the whole refund group is affected, for both visibility and category. Leave/removal explains
  retained shared history and lost access.
- Category controls load the fixed taxonomy from the API and show server-returned labels with an explicit
  uncategorized option; correction offers the same tokens plus explicit null to clear. Category changes on an
  expense with refunds preview the whole-group propagation before submission.
- Allocation creation shows the current roster, payer and eligible exact participants. The server's authoritative
  preview returns frozen shares and exact current refund impact; never use floating-point or locally rounded
  amounts for submission. Revoke-then-recreate under a fresh key changes participant sets; active allocations
  block expense privacy revocation and money correction.
- Balance views group currencies, label "is owed"/"owes" in text, and mark `CURRENT`/`DEPARTED` UUIDs. Refresh
  on allocation/refund/confirmed repayment/membership changes. Party-only repayment activity explains the
  external-transfer assertion, consent/correction, effective accepted amount and aggregate disclosure; it
  retains one create key after an uncertain outcome and requires a fresh explicit review after uncertain
  versioned writes. Read-only currency-selected suggestions show the snapshot, bounded next page and full-plan
  residuals with restart on 409. No payment action, grand total, or cross-currency total.
- Period contributions choose a reporting-zone month or explicit half-open dates and **one currency**;
  label paid/refund/net-paid versus assigned cost as current-state period figures, show unallocated net
  without guessing a payer's obligation, and keep the all-time balances/party activity separate.
  Totals cover all contributors even while the member list is incomplete. A stale snapshot clears
  accumulated rows before an explicit page-one restart; a recoverable read keeps the last good result
  only with a visible stale warning. Refresh the applied period after ledger/share/refund/allocation,
  membership and reporting-zone changes, preserving draft inputs; repayment-only transitions
  cannot change these period columns. No hidden bank/account/category or another party's repayment
  detail is included.
- Include loading, empty, ready, validation, stale, forbidden, and recoverable failure states; associated errors,
  status announcements, keyboard focus, 44px targets, phone reflow, and 200% text inspection follow existing UI.

## Behavior matrix

These are reproducible behavior expectations for the implemented API, covered by the linked test suites. They do
not certify a particular deployment or replace human/device accessibility review.

| Area | Checked behavior |
| --- | --- |
| Exact money | All seven supported currencies; zero/negative-zero, numeric JSON, exponent, leading zeros, excess zeros/scale, unsupported code, mismatch, each range boundary; exact large totals beyond per-record bound |
| Sign and totals | BRL expense -100.00, income +200.00, refund +20.00, transfer -50.00 produce spending 80.00 and income 200.00; other transfer leg adds no spending; voided/private values excluded from household totals |
| Dates | Leap validity, date bounds, future warning, refund date ordering, half-open month/year boundaries; refund in the next month reduces that month; configured-zone midnight/DST and host/browser-zone independence |
| Accounts | Both roles create private accounts; duplicate names with separate keys; name bounds; immutable-field rejection; archive blocks creates but permits history/corrections; unarchive resumes creation |
| Privacy | Two members (including an owner), outsider, foreign household, removed user; private detail/list/filter/hasMore/key/error isolation; shared DTO redacts account; own versus household aggregate populations |
| Lifecycle | Removal racing create/correction cannot allow a post-removal commit; membership deletion preserves records; shared history persists without former email leakage; same-user rejoin restores ownership only in that household |
| Refunds | Missing/hidden/foreign/wrong-account references; over-refund; concurrent refund cap; expense reduction/date correction; void dependencies; group sharing and stale group-version conflict; no partial group commit |
| Categories | Fixed 16-category response for every current member with non-member household 404; unknown/lowercase/empty/wrong-type tokens rejected; omitted vs explicit-null create semantics; refund inheritance, explicit mismatch failure, direct refund patch rejection; source category propagation to posted and voided refunds with per-member version bumps and stale-expense conflict; voided-entry category ban; fingerprint reuse across replay |
| Sharing | Private default; household feed SQL scoping with joined-later and departed-owner visibility; non-owner account redaction; owner-only mutation; whole-refund-group visibility changes and revocation; disclosure preview matches actual response; revocation removes future reads only |
| Allocations | Eligibility only for owner-created POSTED HOUSEHOLD expenses; one active allocation; duplicate/non-member participant rejection; idempotent 201/200 replay with since-revoked representation; recreation after revoke needs a fresh key; expense-version token under concurrent create/revoke/refund/correction races; ALLOCATION_CONFLICT blocks money correction and privacy revocation; atomic void deactivation; frozen participants surviving departure; remainder conservation (10.00 → 3.34/3.33/3.33); no leak of revoked allocations |
| Balances | Zero-sum per currency with exact strings and stable ordering; partial refunds (refund 1.00 → obligations 3.00/3.00/3.00; cumulative refund 3.00 → obligations 2.34/2.33/2.33) and full-refund exact reversal; payer credit minus obligations zero; private/unallocated/voided/revoked exclusion; departed payer and participants keep obligations with CURRENT/DEPARTED labels and no email; coherent snapshot under concurrent removal |
| Retries and edits | Same-key simultaneous creation/restart produces one resource; changed payload conflicts; failed create can retry; replay after correction/archive/void reauthorizes and returns current resource; stale update cannot overwrite |
| Persistence | Fresh/upgrade Flyway, Hibernate validation, real PostgreSQL constraints, atomic rollback, exact NUMERIC behavior, restricted cross-household references, concurrency, persistence across restart; separate category/sharing and allocation migrations in that order; one-active-allocation partial unique index |
| Mobile recovery | Money digits/signs/currency preserved; duplicate submission, unknown outcome, key reuse, CSRF retry, expiry/access cleanup, household-switch cancellation, keyboard/focus/axe/reflow, explicit disclosure and archive controls; category selection/correction labels, participant selection with exact share preview, revoke/recreate flow, and balance labels for owed/owes and CURRENT/DEPARTED |

Categories, sharing, allocations and balances must preserve remainder conservation
(10.00 → 3.34/3.33/3.33), exact full/partial refund reversals, zero-sum currency-specific
obligations, immutable historical participants through departure, and the correction/revocation
contract in [ADR 0007](../decisions/ADR-0007-categories-sharing-allocations.md).

For reproducible checks, see [testing](../development/testing.md). This contract describes
implemented behavior; it is not evidence of hosted operations, provider coverage or formal
accessibility certification.
