# Shared-finance contract

**Status:** Visibility management, exact allocations, external repayment records and
contribution views are implemented. [ADR 0010](../decisions/ADR-0010-shared-finance.md)
records their design decisions; [manual finance](manual-finance-api.md) defines the underlying
ledger and original equal-share behavior.

## 1. Goal and scope

Two or more current household members must be able to find shared purchases, divide their cost fairly and
exactly, understand outstanding obligations, agree records of repayments made outside HouseSync, and explain
who paid versus who bears costs without an external expense-splitting tool for routine purchases.

| Capability | User-facing behavior |
| --- | --- |
| Visibility management | Find All / Private / Shared by me entries across bounded pages; manage existing disclosure. |
| Flexible allocations | Equal or exact unequal shares, including a payer-retained portion, with deterministic partial/full refund attribution. |
| Settlement coordination | Deterministic suggestions and two-party records/corrections of payments made outside HouseSync. |
| Contribution views | Period paid-versus-assigned-cost, distinct from all-time balances and external repayments. |

The [connected-finance](connected-finance-contract.md) and
[categorization](categorization-contract.md) contracts retain provider provenance and
owner-private evidence boundaries. Selected sharing and equal allocations predate the exact
allocation and repayment extensions.

### Invariants and exclusions

- Accounts and account metadata stay private to their financial owner. A household OWNER has no financial
  override. Joining, changing role or confirming a split never grants account access or shares sibling entries.
- Transactions remain PRIVATE or HOUSEHOLD. HOUSEHOLD discloses the full transaction projection to
  every current/future member; non-owner accountId stays null. Disclosure and cost allocation are independent.
- A payer-retained/personal cost portion is economic allocation, **not hidden purchase detail**. A shared
  purchase still reveals its whole amount and description. No partial/redacted or totals-only disclosure.
- Only confirmed POSTED ledger expenses with HOUSEHOLD visibility can have an active allocation. Financial owner
  equals payer. No owner transfer, joint account authority or independently nominated expense payer.
- Refund visibility/category follow the source expense including retained voided refunds. Amount/date/cap,
  source-version checks and revoke-before-unshare/amount-edit remain. Provider reconciliation cannot bypass them.
- No deletion/edit of Plaid history, payment execution, bank-transfer initiation, bank-login storage or automatic
  repayment matching. A manual/imported TRANSFER is not automatically a settlement and is excluded from spending.
- No account auto-sharing, bulk visibility writes, percentages/weights, mixed-category line items,
  FX, cross-member categorization learning, private-data aggregate counts, exports or erasure.
  Explicit budget targets and recurring plans exist separately in
  [financial insights](financial-insights-contract.md); neither is a settlement or ledger fact.
- Live bank-initiated change/removal and live AI quality/production erasure remain unverified.

## 2. Common transport, money, authorization and concurrency

`H` means `/api/households/{householdId}`. Existing session/CSRF, no-store JSON, safe correlation IDs, strict
unknown/duplicate field rejection and membership-first resource authorization remain.
Only documented method/path combinations are allowed; no permissive placeholder
handlers. Request/response fields below are exact; documented nullable fields are
present as null. UUIDs use existing canonical parsing.

Money objects have exactly `{amount,currency}`. Amounts are decimal strings, never JSON numbers. Retain the
existing grammar, 12 integral digit input bound and seven currencies: BRL/USD/EUR/GBP/CAD scale 2, JPY scale 0,
KWD scale 3. Repayments and expenses are positive magnitudes where specified; exact participant shares may be
zero, but never negative/negative zero. Inputs reject extra precision rather than rounding. Aggregate strings
may exceed the input bound and must not be clamped. No cross-currency total. Use checked integer minor units
or exact decimal operations; use BigInteger for products/comparators exceeding long, never floating point.

Versions remain nonnegative 32-bit JSON integers with exhaustion rejected before mutation. Creation keys are
canonical UUID `Idempotency-Key` headers, scoped by actor/household/operation, stored atomically with results;
same normalized intent returns the current authorized resource (201 first, 200 replay), differing intent is
409 IDEMPOTENCY_CONFLICT. Reauthorize every replay; do not rerun eligibility after a committed creation.
Versioned PATCH/POST actions require fresh `expectedVersion`, do not auto-replay, and have no idempotency header.

All writes start with the existing household lifecycle lock and current membership check. Transaction work
preserves the established connection/account/source-expense/refund/allocation lock order; shared finance does not
invert the connected-finance connection ordering. Settlement work takes household then settlement row and never holds that row while
acquiring ledger/account locks. Combined multi-query reads/preview/projections hold the lifecycle lock for one
coherent authorized computation. Five-second lock timeout remains FINANCE_BUSY. No network call inside locks.
Single SQL transaction feeds retain snapshot membership joins: already-delivered bytes cannot be recalled.

Resource errors remain privacy preserving: non-member/missing household -> HOUSEHOLD_NOT_FOUND; hidden/missing
transaction -> TRANSACTION_NOT_FOUND; visible non-owner attempted transaction mutation -> FORBIDDEN. Structural
validation can precede resource lookup, but never disclose private state in semantic errors. No private amounts,
merchant descriptions, keys, provider payloads, account details or counterpart email in logs or error bodies.

## 3. Visibility management

### Query and discovery

Extend existing `GET H/transactions` with optional `visibility=PRIVATE|HOUSEHOLD`, valid only for `view=OWN`
(including omitted view's OWN default). Omission means both; UI All omits the parameter, never sends ALL.
Reject blank/unknown/duplicate values or visibility with HOUSEHOLD view using safe 400 VALIDATION_FAILED.
Keep all current filters, ordering and page/transaction DTOs. Membership, ownership and optional visibility,
account, currency, dates and status predicates run in SQL before limit/offset/hasMore; empty pages still
validate membership. Account filters stay OWN-only and cannot enumerate another member's accounts.

My transactions offers All / Private / Shared by me. Household feed retains all owners' shared entries,
including departed owners, and never includes the viewer's additional private entries. No counts or new grants.
Keep web `status=ALL` so retained voided shared history remains discoverable and revocable; API default stays
POSTED. Limit remains 1-100 (default 50); offset 0-10000 inclusive (default 0); response remains exactly
`{items,limit,offset,hasMore}`, with hasMore derived from at most limit+1 authorized matching rows.

Add explicit Load more to both transaction feeds. Offset follows the previous server page boundary, not
rendered/deduplicated item count. Dedupe IDs, prevent late responses overwriting newer rows, permit offset 10000,
and show incomplete-history state when hasMore indicates another page beyond the bound. This is not a snapshot
export. Retry failed pages without discarding already authorized rows. Filters/view changes restart the relevant
sequence, ignore stale callbacks, and preserve unrelated drafts under current busy/confirmation safeguards.

After mutations restart affected feeds at page one under current filters. Reconcile open detail by authorized
ID; absence from a filtered/first page does not prove deletion or lost access. An older refund must allow
navigation to its authorized source expense even when that source is not in loaded pages, never a direct
refund visibility patch. On logout/household switch/confirmed access loss clear all scoped data and callbacks.

### Existing decisions stay explicit

Reuse exact disclosure preview and owner-only versioned sharing patches. Entire refund groups move atomically.
An active allocation blocks unshare with ALLOCATION_CONFLICT; the owner must explicitly revoke it first.
No hidden combined revoke/unshare action. Voided non-refund entries retain visibility-only correction.
Refresh household spending after sharing and balances after relevant allocation/refund changes; view filters
never redefine those populations. Revocation blocks future reads, not information someone has already seen.

## 4. Flexible allocations and exact refunds

### Creation intent and personal portion

Retain `POST H/transactions/{id}/allocation`, `GET` active allocation and versioned `PATCH` with
`{expectedVersion,status:"REVOKED"}`. Creation requires the existing durable key and exactly one body shape:

```json
{"expectedVersion":3,"participantUserIds":["user-A-uuid","user-B-uuid"]}
```

```json
{"expectedVersion":3,"participantShares":[
  {"userId":"user-A-uuid","share":{"amount":"7.00","currency":"USD"}},
  {"userId":"user-B-uuid","share":{"amount":"3.00","currency":"USD"}}
]}
```

The illustrative IDs stand for valid UUIDs. The first is EQUAL; the second is EXACT. Reject both/neither arrays,
empty lists, duplicates before sorting, noncurrent participants, currency mismatch, negative shares and sums
not exactly the expense magnitude M. Each share is <= M. Zero-share participants are allowed and frozen;
payer absent means zero payer cost, not an unallocated remainder. Payer-only is valid and creates no debt.
All participants are sorted by canonical UUID. No implicit leftover, percentage or weight arithmetic.

For a 10.00 purchase with payer A retaining 7.00, explicitly assign A=7.00 and B=3.00. A is owed 3.00; B owes
3.00. This covers 100% of the purchase and supports partially shared economic cost without inventing a separate
personalAmount field. A remains free to choose EQUAL across any explicit current-member subset. All original
shares and the method/policy tag are immutable; changing them requires revoke and recreate with a fresh key.

### Cumulative refund policies

Persist `method=EQUAL|EXACT` and `refundPolicy=EQUAL_V1|EXACT_JEFFERSON_V1` with a database check allowing only
those pairs. Every existing active AND revoked allocation is EQUAL/EQUAL_V1. New equal allocations keep that
same policy. Let integer M>0 be original minor units, s_i>=0 original shares with sum M, and R in [0,M] be the
sum of current POSTED refund magnitudes, regardless of how many refund records exist.

- **EQUAL_V1:** unchanged equal division of cumulative R with ascending-UUID remainder. Never reinterpret
  historical equal shares using proportional weights from their already-rounded originals.
- **EXACT_JEFFERSON_V1:** participant i has priorities s_i/k for k=1..s_i. The first R priorities in descending
  exact rational order determine cumulative refund shares F_i(R); ties go to ascending canonical UUID.
  Zero-share participants receive zero. This is a mathematical definition, not an instruction to enumerate M
  units. Implement it efficiently:
  1. Initialize q_i=floor(R*s_i/M) using BigInteger products.
  2. Let d=R-sum(q_i), which is < participant count.
  3. Award those d residual units using a max-heap of s_i/(q_i+1) among unsaturated participants; compare by
     exact cross-products and UUID tie-break; update only the chosen participant's candidate.
  4. Return q. Work is O(n log n), independent of the monetary magnitude, with O(n) auxiliary space.

For R>0, the initial quotas count all priorities >= M/R, so the bounded residual procedure selects exactly the
global top-R prefix. Therefore sum F=R, 0<=F_i<=s_i, each F_i is monotone as R grows, and F_i(M)=s_i. Recompute
when a refund is corrected/voided: decreasing R legitimately increases remaining obligations. Do not persist
independently rounded per-refund shares or use largest remainders independently for each cumulative R; that can
make a participant's cumulative refund fall when the total grows.

Highest-averages rounding can favor larger shares at intermediate totals. It guarantees conservation and
monotonicity, not closest proportional rounding at every cent. For JPY shares (4,1,1), refund 2 yields (2,0,0).
Show exact current impact and this rounding explanation before creating an unequal split; do not promise
item-specific refunds. Manual and connected refund admission APIs remain unchanged.

Remaining obligation O_i=s_i-F_i(R); payer credit=M-R. Allocation contribution to member balance is payer credit
for the payer minus O_i for each participant, including the payer when present. Sum is zero per currency.
Private/unallocated/voided/revoked allocations contribute nothing; frozen departed participants remain.

| Example (ascending A/B/C; A pays) | Cumulative refund shares | Remaining cost / net balances |
| --- | --- | --- |
| Legacy equal USD10.00, R=1.00 | 0.34 / 0.33 / 0.33 | Cost 3.00 / 3.00 / 3.00; balances +6.00 / -3.00 / -3.00. |
| Exact USD10.00, original A7.00/B3.00, R=1.00 | 0.70 / 0.30 | Cost 6.30 / 2.70; balances +2.70 / -2.70. |
| Exact JPY10, original 5/3/2, R=4 | 2 / 1 / 1 | Cost 3/2/1; balances +3/-2/-1. |
| Exact KWD0.006, original 0.004/0.001/0.001, R=0.002 | 0.002 / 0.000 / 0.000 | Cost 0.002/0.001/0.001; balances +0.002/-0.001/-0.001. |
| Any method, R=M | Exactly original shares | Zero credit and obligations; no balance rows. |

### Preview, response and integration

Add read-only `POST H/transactions/{id}/allocation/preview` with the same create union and expectedVersion,
CSRF, no idempotency key and no mutation/reservation. Require owner, current membership, eligible expense, no
active allocation and current version under the existing group locks. Preview a previously refunded expense
from the complete authorized refund group, not its currently loaded UI page. Creation recomputes and rechecks;
preview is not a commitment or stale-write bypass.

Preview has exactly `transactionId,transactionVersion,method,refundPolicy,originalAmount,participants,impact`.
Original participants retain `{userId,share}`. Impact has exactly:

```json
{"cumulativeRefundAmount":{"amount":"1.00","currency":"USD"},
 "payerCredit":{"amount":"9.00","currency":"USD"},
 "participants":[
   {"userId":"user-A-uuid","cumulativeRefundShare":{"amount":"0.70","currency":"USD"},"remainingObligation":{"amount":"6.30","currency":"USD"}},
   {"userId":"user-B-uuid","cumulativeRefundShare":{"amount":"0.30","currency":"USD"},"remainingObligation":{"amount":"2.70","currency":"USD"}}
 ]}
```

Allocation resource responses keep all eleven current fields and add exactly `method,refundPolicy,impact`.
GET of active allocations and new/replayed ACTIVE creation return a coherent current impact. A since-REVOKED
creation replay returns `impact:null`: later expense/refund edits must not be projected against a revoked old
magnitude. Revoked allocations still have no standalone read route. All current members can read an authorized
active allocation/impact; only its financial owner previews/creates/revokes. No account metadata is added.

Expense version remains the sole allocation concurrency token. Create/revoke bump it once; refund changes
already bump it; preview/GET do not. Preserve legacy equal idempotency fingerprints byte-for-byte. Exact intent
uses SHA-256 of UTF-8 `EXACT_V1`, transaction UUID, decimal version, then sorted UUID/currency/canonical-scale
share triples, separated by NUL bytes. Strict input fields cannot contain that delimiter. This is distinct
from the preserved equal fingerprint, which begins with the transaction UUID rather than a policy tag.
Keep existing group cap/date/refund-kind rules, allocation money/unshare conflicts and atomic deactivation on
eligible expense void/bank replacement. Update categorization review evaluation versions on non-category ledger version bumps
without creating public review data or overwriting categories.

V19 is one forward migration adding policy tags and their pair constraint. Existing amounts, shares,
versions, timestamps, key fingerprints and balances must be unchanged; no historical recomputation/backfill.
Upgrade the strict web allocation parser/types with the backend DTO in one application release; no old/new
parallel routes. Route GET impact and member balances through one pure tagged refund policy implementation,
also used by period contributions (§6). No duplicated arithmetic or per-refund persisted allocation state.

## 5. Settlement suggestions and external repayments

### One authoritative balance, no money movement

Extend the existing member-balance computation, not a second ledger of cached balances. For each currency:

`balance_i = allocationCredit_i - remainingAllocatedCost_i + confirmedSent_i - confirmedReceived_i`.

Positive means is owed; negative means owes. Confirmed repayments with a pending amendment still use their
currently accepted amount. Pending/rejected/cancelled/voided repayments contribute zero. Keep the existing
member-balances response shape, exact strings, zero-row omission and CURRENT/DEPARTED UUID labels. Compute
allocations and repayments under one household lock before dropping zeros; every currency must sum to zero.
No repayments means exactly the existing B result.

A recorded repayment is an assertion of a transfer already made outside HouseSync, agreed by both parties.
HouseSync neither sends money nor verifies a bank transfer. No transaction/account/allocation foreign key or
free-text bank evidence is attached. Duplicate-looking real payments remain legitimate; only same-intent
idempotency keys deduplicate retries. Warn against recording the same real payment twice. Manual/imported
TRANSFER ledger entries remain independent and never double-adjust member balances.

Do not clamp an actual payment to today's debt. With A +5.00/B -5.00, B paying A 3.00 gives +2.00/-2.00;
another actual 4.00 gives A -2.00/B +2.00. If the originating expense is later fully refunded, voided or its
allocation revoked, accepted repayments remain. For example, B's accepted 2.70 payment after the §4 example
settles both balances to zero; removing that allocation leaves A -2.70/B +2.70, not a silently erased payment.
Show the reversal clearly. Unsharing an expense never reveals it through a repayment source reference.

### Disclosure and parties

Only sender and recipient, while current household members, can read repayment records, events and pending
amendments. Other current members, including household OWNER, receive REPAYMENT_NOT_FOUND for those IDs and
no rows/hasMore evidence in their lists. Sender is always the authenticated creator; recipient must be a
distinct current member. No third-party recording or administrator override. The recipient alone can confirm
the initial assertion. Confirmation copy explains that **the agreed payment changes household-visible net
balances/suggestions, while its amount/date/history are party-only**. Net-balance changes can imply payment
activity; do not promise that this aggregate disclosure is invisible.

Both parties must be current to create, confirm or open/confirm an amendment. A pending item is retained if
one leaves; it cannot be confirmed until the same user rejoins. A remaining creator can cancel their pending
proposal, and a remaining non-proposer can reject it. Apply the same reject/cancel policy to an amendment.
Confirmed balances survive departure with DEPARTED UUID-only labels. No debt forgiveness, ownership transfer,
synthetic payment or removal prohibition is inferred. A departed counterpart cannot consent in-app until
rejoining; this limitation is visible, not a hidden success. Rejoin restores the same party authority only.

### State machine and correction

| Current state | Authorized action | Result and balance effect |
| --- | --- | --- |
| PENDING, version 0 at creation | Recipient CONFIRM | CONFIRMED; apply positive amount once. |
| PENDING | Recipient REJECT / sender CANCEL | REJECTED / CANCELLED; terminal, no balance effect. |
| CONFIRMED without amendment | Either party proposes REPLACE or VOID | Keep CONFIRMED and old amount effective; open one amendment. |
| CONFIRMED with amendment | Other party CONFIRM amendment | Atomically accept replacement amount/date or set VOIDED; change balance by exact delta. |
| CONFIRMED with amendment | Other party REJECT / proposer CANCEL amendment | Clear pending amendment, preserve accepted amount/date and balances. |
| REJECTED, CANCELLED or VOIDED | Any new transition | REPAYMENT_CONFLICT; create a new record for a genuinely new assertion. |

REPLACE supplies the entire positive replacement money/date; currency and parties are immutable. VOID is a
correction of a mistaken record, not a refund or a new transfer back. A real return payment is a distinct
repayment in the opposite direction. Both require the appropriate counterparty's agreement. No self-confirm,
even when the requester is household OWNER. No direct edit of confirmed facts or hard delete.

Use one parent `expectedVersion` for every initial decision/amendment transition, including opening,
rejecting or cancelling an amendment. Increment once on success and append an immutable event in the same
transaction. One pending amendment maximum; no parallel replacement proposals. Concurrent confirmation,
cancellation, correction and removal serialize and stale versions conflict without double-applying money.
Retain every asserted/accepted/rejected/cancelled revision server-side; rejecting an amendment never rewrites
the accepted fact. An accidental accepted void is not restored; create a new two-party assertion instead.

Payment `occurredOn` is a completed-payment calendar date in 1900-01-01 through the earlier of 9999-12-30 and
today in the household reporting zone. Reject future-payment scheduling. Replacements use the same validation.
Check the current date bound again on positive initial/replacement confirmation; a reporting-zone change
that makes the asserted date future requires correction/cancellation, not silent scheduling. Authorized
creation replay returns its stored result without rerunning that date eligibility check.
The initial assertion can predate recorded expenses; an actual payment is not constrained by the current debt
sign or a suggestion. Suggestions are advisory, not a confirmation precondition. Show current balances and
overpayment/reverse-credit implications at review, but do not discard a real transfer because those balances
changed since a suggestion was read.

### Repayment API and exact projections

| Method/path | Exact request | Success |
| --- | --- | --- |
| POST H/repayments | `recipientUserId,money,occurredOn`; required Idempotency-Key | 201 PENDING; 200 authorized replay. |
| GET H/repayments | Optional `limit,offset,currency,status,from,to` | Party-scoped page. |
| GET H/repayments/{id} | No query/body | Current party-only resource. |
| POST H/repayments/{id}/decision | `expectedVersion,decision` with CONFIRM/REJECT/CANCEL | Current resource after initial decision. |
| POST H/repayments/{id}/amendment | `expectedVersion,action` with VOID; or additionally `money,occurredOn` with REPLACE | Resource with pending amendment. |
| POST H/repayments/{id}/amendment/decision | `expectedVersion,decision` with CONFIRM/REJECT/CANCEL | Resource after amendment decision. |
| GET H/repayments/{id}/events | Optional `limit,offset` | Party-only immutable event page. |

Versioned POST transitions require CSRF but no creation key; uncertain outcomes require refetch and explicit
review, not a blind retry. Creation fingerprint is normalized recipient/currency/amount/date under
`REPAYMENT_CREATE` actor/household/key scope. Replay remains authorized even if recipient later departs, but
never recreates or reconfirms the payment. Actor departure still denies access until rejoin.

Repayment resource has exactly:
`id,householdId,senderUserId,recipientUserId,money,occurredOn,status,version,createdAt,updatedAt,confirmedAt,voidedAt,pendingAmendment,allowedActions`.
Status is PENDING/CONFIRMED/REJECTED/CANCELLED/VOIDED. Amount/date are the initial assertion until first accepted,
then the current accepted revision. confirmedAt is first-confirmation Instant or null; voidedAt is null except
VOIDED. pendingAmendment is null or exactly
`{action,proposedByUserId,money,occurredOn,createdAt}`; VOID has null money/date, REPLACE has complete proposed
money/date. All instants use the existing server-clock precision.

allowedActions is a server-derived ordered array using this order:
`CONFIRM,REJECT,CANCEL,PROPOSE_REPLACEMENT,PROPOSE_VOID,CONFIRM_AMENDMENT,REJECT_AMENDMENT,CANCEL_AMENDMENT`;
include only actions authorized by current party/membership/state. It helps UI explain controls but is never
write authorization. No endpoint accepts it in a request. After departure allowedActions may permit only
reject/cancel as above; UI uses existing current roster and safe unavailable-counterparty explanation.

List status defaults ALL and accepts the five states or ALL. Optional currency uses the seven-code allowlist;
from/to are both-or-neither half-open dates filtering the resource's current occurredOn, not createdAt.
Keep limit 1-100/default 50, offset 0-10000/default 0 and `{items,limit,offset,hasMore}`; scope to actor party
before filters/paging. Order createdAt DESC,id DESC. Explain the history limit and allow date narrowing; do not
claim a full audit export. Events use ascending version, same page bounds/envelope and exact items
`{version,eventType,actorUserId,recordedAt,status,money,occurredOn,pendingAmendment}`.
Event types are CREATED, CONFIRMED, REJECTED, CANCELLED, AMENDMENT_PROPOSED, AMENDMENT_CONFIRMED,
AMENDMENT_REJECTED, AMENDMENT_CANCELLED. Event fields describe the post-transition resource snapshot (VOID
retains the last accepted amount/date and has no pending amendment); accepted void is AMENDMENT_CONFIRMED
with status VOIDED. No current allowedActions or mutable roster data is stored in events.

Add safe 404 REPAYMENT_NOT_FOUND and 409 REPAYMENT_CONFLICT for an authorized invalid transition or unavailable
counterparty. Existing version, idempotency, shape, CSRF and busy errors apply. A rejected initial proposal or
amendment is a successful recorded user decision, not an HTTP error. No IDs/amounts echoed in unauthorized errors.

### Settlement suggestions

`GET H/settlement-suggestions?currency=USD&limit=50` requires one explicit allowed currency; limit 1-100 default
50; optional `cursor` is the only continuation parameter. Every current member can read this balance-derived
projection. Reject unknown/duplicate query keys. Calculate from the entire authoritative currency balance
vector, never from one page of accounts, expenses or payments.

Partition nonzero CURRENT balances into negative debtors and positive creditors, each ascending canonical UUID.
Greedily pair the first debtor/creditor for min(absolute debt, credit), advance exhausted endpoints, and repeat.
The ordered plan has at most current-nonzero-member-count minus one edges, each positive exact money.
It is deterministic, not promised to minimize payment count or preserve an original payer/debtor pair.
Read-only suggestions never reserve debt, persist payments or assert anything has been paid.

DEPARTED balances remain in the balance vector, but no in-app payment to/from a departed user is suggested.
Return residuals from the **entire suggested plan**, not just its displayed page; never silently omit them or
describe a partially settleable household as settled. Example A +10, B -6, departed C -4 yields B->A 6 plus
current credit residual 4 and departed debt 4. Rejoining changes eligibility and the plan.

Response has exactly `currency,snapshot,items,nextCursor,residuals`. Each item is
`{senderUserId,recipientUserId,money}`. Residuals has exactly nonnegative currency-scale strings
`currentDebtAfterPlan,currentCreditAfterPlan,departedDebt,departedCredit`. These are balance-derived totals
already within household disclosure, never party repayment history totals. Empty debt returns an empty plan
with exact zeros for the explicitly requested currency, not an inferred household default currency.

Snapshot is lowercase SHA-256 of a domain-separated, canonical length-delimited representation of household,
currency, algorithm tag CURRENT_UUID_GREEDY_V1, and all sorted nonzero `{userId,membershipStatus,amount}` rows.
It is a freshness fingerprint, not a credential. Zero-balance roster changes need not invalidate this plan.
Cursor is an opaque base64url encoding of version, snapshot, currency and next edge index; bounded to 1024
characters, strict parse/version/nonnegative-integer-index validation, and no source account/payment identifiers.
Recompute under current membership and household lock on every page. A different current fingerprint yields
409 SETTLEMENT_SNAPSHOT_STALE and restarts from page one. nextCursor=null only at plan exhaustion.
After verifying freshness, reject a cursor index outside the recomputed plan with VALIDATION_FAILED; an
exhausted plan issues no cursor. Malformed/version/currency-mismatched cursors are also validation errors.
Page response size is bounded even for many historical members; never return an unbounded departed-user array.
There is no offset-10000 cliff for this derived plan. Iteration is by members/edges, never currency minor units.

### Persistence and rollout

V20 introduces external repayment headers, immutable events and durable creation keys in one forward
migration. Restrictive household/stable-user foreign keys, distinct sender/recipient constraint,
seven-currency scale/magnitude checks, dates, version/state/nullability checks, and one pending amendment per
header are database invariants. Store amendment fields together or not at all; events are unique by
(repaymentId,version), starting with CREATED/version 0. No membership-row or source-transaction FK.
Index party/date list access and household/currency/confirmed projection. Event deletion/correction is not an API.

No historical repayments are inferred or backfilled. Current accepted amount/date plus state are the balance
projection; event log preserves corrections, not a second balance computation. All transitions append event
and update header atomically. Route existing balances and suggestions through the same combined application
use case. No balance tables, suggestion worker, network calls, AI arithmetic or provider changes.

## 6. Contribution views and integrated household workflow

### Meaning and privacy

Answer two separate questions over a selected period: **Who paid for disclosed purchases?** and **Who bears
the currently assigned cost?** This is not a bank balance, a historical as-of ledger, or the all-time amount
still owed. Current net member balances remain a separate panel and include accepted repayments.

Contribution data comes only from HOUSEHOLD POSTED EXPENSE/REFUND ledger facts and active allocations of those
expenses, including archived accounts and departed users. Income/transfers/pending/unadmitted/private/voided
entries contribute nothing. Do not expose category rules, AI reviews or private bank counts. Household role
does not widen this population. No account grouping/filter, description search or private-data total.

Repayment records and period sent/received totals remain party-only in the repayment activity view. **Do not publish
per-member repaymentSent/repaymentReceived, period net-cash-after-repayments, or repayment counts in contributions.**
That would widen consent beyond the intentionally disclosed net balances. Link to the actor's own repayment
activity separately; household members cannot drill from a balance into somebody else's payment history.

### Exact period equations

Period P=[from,to) uses ledger occurredOn. The household reporting zone determines default dates, not a
reinterpretation of saved calendar dates. Work from one current authorized snapshot:

- `expensePaid_i(P)` = positive magnitudes of i's eligible expenses dated in P.
- `refundReceived_i(P)` = magnitudes of i's eligible posted refunds dated in P.
- `netPaid_i(P) = expensePaid_i(P) - refundReceived_i(P)`.
- For each currently active allocation, let R_<T be the sum of its current posted refunds dated before T.
  Assign `s_i` as cost if the expense occurred in P, and subtract
  `F_i(R_<to) - F_i(R_<from)` for period refunds using the persisted refund policy (§4).
- `allocatedCost_i(P)` is that signed sum across active allocations.
- `unallocatedNet(P)` is expense minus refund magnitudes in P for eligible groups with no active allocation.
  Do not guess that their owner bears the cost. Unallocated does not mean private or undisclosed.

Thus `sum(netPaid_i)=netSpending` and `sum(allocatedCost_i)+unallocatedNet=netSpending`.
Negative period net spending or cost is valid in refund-only periods. Sum refund groups before applying F,
including refunds outside the requested period. Splitting a refund into records within the same boundary
bucket (before from, inside P, or on/after to) must not change the period result; moving amounts across a
period boundary legitimately does. No independent per-refund rounding, roster-derived reallocation, float arithmetic or
double-counting an expense's original amount for each participant.

Example: September exact A7.00/B3.00 expense 10.00 paid by A; October refund 1.00. September paid is A10.00,
assigned costs A7.00/B3.00. October paid is A-1.00, assigned costs A-0.70/B-0.30, with net spending -1.00.
B's accepted October repayment of 2.70 makes all-time balances zero but changes none of those period columns.
After allocation revoke, both periods' costs move to unallocatedNet under the **current** state and repayment
history remains; after unshare both periods exclude those ledger facts. Label this restatement explicitly,
not “what everyone owed as of month end.”

### Contribution API

Add `GET H/contribution-summary` with required `from,to,currency` and optional `limit,offset,snapshot`.
Both dates are valid half-open reporting bounds from the existing contract; currency is explicit and allowed.
Limit 1-100/default 50; offset 0-10000/default 0. Reject unknown/duplicate/null/malformed query values.
All current members can read; membership/lifecycle/visibility checks precede financial computation.

Response has exactly `from,to,reportingTimeZone,currency,snapshot,totals,items,limit,offset,hasMore`.
Totals has exactly currency-scale strings `expenseTotal,refundTotal,netSpending,allocatedCostTotal,unallocatedNet`;
these describe the entire authorized requested population, not the page. Items, ascending canonical user UUID,
have exactly `userId,membershipStatus,expensePaid,refundReceived,netPaid,allocatedCost`, with CURRENT/DEPARTED
and exact strings. Emit only users having at least one nonzero contribution field; do not pad with the current
roster or personal profiles. Explicit currency with no contributing records yields zero totals and empty
items; do not change the existing spending-summary's currency-emission behavior.

Snapshot is SHA-256 over a domain-separated canonical length-delimited encoding of household, from/to,
reporting zone, currency, policy tag CONTRIBUTIONS_V1, totals and the entire sorted authorized item projection.
It excludes private data and repayment history. Offset>0 requires the prior snapshot; any supplied snapshot
that differs from the current projection returns 409 CONTRIBUTION_SNAPSHOT_STALE. First-page request without
snapshot gets a fresh view; repeated page reads never silently combine different totals. Each request still
authorizes and recomputes; fingerprint is not an access token or stored historical snapshot. Changed current
projection invalidates continuation even when total spending happens to match.

Fetch bounded response rows plus hasMore after computing full totals; aggregate queries must not filter to a
UI page before computing refund deltas. Use bulk scoped queries/shared pure allocation policy rather than N+1
refund queries per participant. No new persisted aggregates or background recalculation. At offset cap label
incomplete member rows; totals still cover the full authorized population. Never sum loaded rows as totals.
Current household roster alone does not bound the number of historical contributors.

### Browser integration

Show period/zone/currency, paid-versus-assigned-cost definitions and signed refund effects, plus explicit
unallocatedNet. Keep expense/refund totals reconciled with the existing spending dashboard's expense/refund
components. All-time member balances and suggested repayment actions are separately labeled. No all-currency
grand total or period “amount owed” inferred from these columns.

Refresh contributions after sharing/revocation, relevant ledger correction/void/refund, allocation changes,
membership change and reporting settings. Repayment decisions refresh all-time balances/suggestions and party activity;
they do not change contribution columns. Preserve last good read data only as explicitly stale on a
recoverable error; never render a changed household's old figures. Filters and pagination preserve unrelated
drafts, use request-generation guards, expose loading/empty/retry/incomplete states and reject late responses.
Contribution reads are derived without an additional materialized balance table.

## 7. Migration and cross-layer cutover

The visibility query extends existing authorized transaction paging without a
new grant. V19 tags existing equal allocations and persists the EXACT policy
without rewriting historical economic data. V20 adds retained repayment
headers/events and replay constraints. Contribution views derive current
projections without storing a second balance ledger. Migrations are forward-only;
old binaries cannot interpret new exact allocations/repayment effects after writes.
Use a forward fix or a tested restore, not a claimed binary-only rollback.
Retain creation-key fingerprints and replay authorization. Equal remains a supported
method, not a deprecated shim; backend/client DTOs must move together.
Repayment revisions are retained; logs contain operation/outcome/correlation,
not payment data. No external payment provider or bank-transfer execution is involved.
Database constraints plus locked service checks enforce
positive/scale-bounded money, immutable identity/currency, conservation, one active allocation or pending
amendment, and valid state/version transitions. Production erasure and external-provider review remain
outside this contract, which does not claim public deployment readiness.

## 8. Reproducible behavior matrix

Focused pure-domain, PostgreSQL/HTTP concurrency and web recovery checks
exercise the matrix below. See [testing](../development/testing.md) for commands.
No in-memory database substitutes for persistence/concurrency evidence; local
tests do not prove provider or public-service behavior.

### Per-area matrix

| Area | Observable checks |
| --- | --- |
| Visibility | >100 mixed own entries find an older shared match through SQL filtering; >100 matches page without duplicates; honest offset cap; invalid combinations safe; private/own/household populations and account redaction unchanged; expense/refund-group unshare blocked while allocated; source navigation across pages; drafts, stale callbacks, unknown outcomes and authority loss safe. |
| Allocations | Legacy equal tiny/remainder/partial/full-refund outputs and durable replays identical across migration; exact sum/zero/payer-present/absent/only rules; seven currencies and max input; exact cross-products; small exhaustive priority-prefix oracle, monotonicity, conservation and full reversal; larger bounded-work cases; refunds corrected/voided; revoked replay impact null; preview stale against concurrent refund/create; removal/create/revoke/void/bank replacement races preserve money and privacy. |
| Repayments | Pending contributes zero; recipient confirms once; role swap never authorizes self/third-party confirmation; partial/overpayment and reverse credit exact; same-key replay after restart and changed-payload conflict; simultaneous confirmations/amendments/removal; replacement/void approval applies one delta, rejection/cancel retains accepted fact, immutable events retained; party-only IDs/list/hasMore/events; old shared expense unshare leaks no source link; suggestions use full balances, preserve departed residuals, page >100 edges, reject stale cursor and never create payments. |
| Contributions | Period boundaries/refund-only negative periods; endpoint differences include outside-period refunds; income/transfers/private/voided excluded from contribution fields; unallocated cost not guessed; active-policy changes restate past periods explicitly; row/totals conservation under paging; snapshot rejects stale continuation; departed UUID labels; party repayment totals absent; existing spending-summary unchanged; all-time balances distinct from period contributions. |

Security matrix for every new/widened surface: financial owner, another current member, household OWNER who
is not financial owner/repayment party, outsider, foreign household and removed actor; also same-user rejoin.
Check hidden detail, list filters, hasMore, snapshots, retries, error precedence and combined aggregates.
Joining later reveals only the documented shared transaction/balance projection, never private accounts,
bank reviews, categorization evidence or someone else's repayment history.

Browser matrix for every area: loading/empty/ready/validation/stale/forbidden/success and unknown write outcomes,
CSRF renewal, session expiry, household switch, late responses and membership removal. Preserve safe form
inputs, keep create intent/key after uncertain create, disable duplicate submission, refetch versioned action
outcomes rather than retrying blindly. Exact amount inputs stay strings. Show “record only; no money sent,”
counterparty consent and resulting debt direction in words, not color. Test desktop, 390px and 320px with
200%-text enlargement, keyboard-only navigation, focus return/announcements, 44px targets and axe; record
automated/incomplete findings, distinguish enlarged text from true browser zoom, and do not claim
screen-reader speech or formal WCAG certification.

### Integrated household journeys

1. **Two people, partial personal expense:** A has an unshared sibling entry and shares only USD10.00.
   B receives the existing redacted transaction, no account facts. A creates EXACT A7.00/B3.00, adds/refunds
   1.00 under normal ledger rules, sees balances +2.70/-2.70, and discovers the expense again through A's
   older Shared-by-me pages. Unsharing while allocated fails without changing money.
2. **Real-payment record, no payment execution:** B asserts an external 2.70 payment to A; pending changes
   no balance. A confirms: zero balances. Another member C sees net household balances but cannot list/read
   that repayment or its events. B proposes a mistaken replacement; A rejects and original effect remains.
   An approved correction/void produces exactly one reverse delta. No Plaid call or ledger transfer is made.
3. **Refund/revocation after repayment:** With accepted 2.70 retained, revoke the allocation and explicitly
   unshare the expense/refund group. B loses future transaction reads and contributions exclude the group; A retains
   private records. Payment stays party-readable; balances A-2.70/B+2.70 remain and suggest the reverse
   repayment. A real return is a new payment, not erasure of the old one.
4. **Period and three-member currency cases:** Verify September/October USD example, legacy JPY1000 equal
   334/333/333, and exact KWD0.006 shares 0.004/0.001/0.001 with refund 0.002. Never sum currencies.
   Add an unallocated shared expense and a private one: only the shared amount enters unallocatedNet,
   neither creates debt. Period paid/cost/refund identities hold independently of settlement activity.
5. **Departure, stale decisions and recovery:** Remove a party while a confirmation/amendment is pending;
   no post-removal positive transition commits. Preserve confirmed payment/frozen allocation obligations,
   expose explicit departed residuals, permit only safe remaining-party reject/cancel, and require same-user
   rejoin to consent. Race refund/void/share with read pagination; no stale scope repopulation or private
   disclosure. Restart, replay a creation key and reconcile an unknown decision without double effect.

Together these journeys show two or more members managing routine shared purchases and recording repayments
without an external splitting tool. The preserved limits (no payment execution, departed consent requires
rejoin, finite transaction/history paging, current-state period restatement) are explicit. They do not cover
live bank corrections, paid AI quality, production erasure or deployment.

## Implementation pointers

The [exact refund policy](../../backend/src/main/java/com/housesync/finance/transaction/domain/AllocationSharesPolicy.java)
implements deterministic share outcomes and canonical UUID tie-breaks. The
[allocation service](../../backend/src/main/java/com/housesync/finance/transaction/application/FinancialAllocationService.java)
owns authorization and lock/version ordering. Migrations
[V19](../../backend/src/main/resources/db/migration/V19__allocation_refund_policies.sql)
and [V20](../../backend/src/main/resources/db/migration/V20__external_repayments.sql)
persist policy tags and repayment events. Focused checks include
[policy tests](../../backend/src/test/java/com/housesync/finance/transaction/domain/AllocationSharesPolicyTest.java),
[HTTP allocation tests](../../backend/src/test/java/com/housesync/finance/transaction/FinancialAllocationHttpIT.java),
[balance tests](../../backend/src/test/java/com/housesync/finance/transaction/FinancialAllocationBalanceHttpIT.java)
and [settlement-plan tests](../../backend/src/test/java/com/housesync/finance/settlement/SettlementPlanTest.java).
These source/test pointers are not evidence of live payment execution or hosted operations.
