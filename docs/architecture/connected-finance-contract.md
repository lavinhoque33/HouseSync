# Connected-finance contract

**Status:** Application-owned connection, sync, review and reconciliation paths are implemented.
[ADR 0008](../decisions/ADR-0008-connected-finance.md) records the provider choice.
This extends the [manual-finance contract](manual-finance-api.md). Fake-provider and
Sandbox evidence do not establish live institution coverage or a live bank-initiated
change/removal journey.

## 1. Product boundary and reporting basis

- Link one private financial connection to one household and its authenticated stable user UUID. One connection
  supplies several private accounts. Both household roles can link; neither can inspect another owner's connection.
- Eligible account types are checking, savings and credit cards denominated in USD/CAD with immutable
  currencies. Loans, investments, cash and unsupported subtypes/currencies are ineligible and
  exclusions are owner-private.
- Bank activity is fetched automatically into a private inbox. Pending entries are informational only. Posted
  entries require explicit confirmation before ledger admission. No provider transaction contributes merely
  because it was fetched; balances/available credit are not part of this product contract.
- Dashboard totals and member obligations mean **confirmed ledger**, not a real-time bank statement. Preserve
  the current HOUSEHOLD-only reporting population. Show owner-only unreviewed/change counts and last successful
  sync separately; never include these counts in household aggregates or another member's shared DTO.
- Imported ledger entries begin PRIVATE except linked refunds, which inherit the source expense's visibility
  and category. Confirming a refund against a shared expense requires an explicit disclosure acknowledgement;
  otherwise reject confirmation without creating an entry. Sharing/allocations otherwise use existing actions.
- No matching by amount/date/description, including against manual entries. Warn that manually recording the
  same bank activity can double-count. An owner can dismiss an inbox item as already recorded without changing
  the manual entry; automatic merge and reassignment of manual provenance are deferred.

## 2. Persistence identities and invariants

Names below describe required records and constraints, not final Java classes or migration numbering.

| Record | Required identity and behavior |
| --- | --- |
| Connection | Local UUID, household UUID, owner user UUID, provider, environment, encrypted credential reference, remote Item identity, state, generation, version, sync timestamps, committed opaque cursor. Unique `(provider, environment, remoteItemId)`; never reference a membership row. |
| Connected account mapping | Connection + remote account ID unique; local account UUID and immutable currency; account source `CONNECTED`, private metadata and supported kind. Same remote account IDs in different Items do not merge. |
| Observation | Unique `(connectionId, remoteTransactionId)`; provider revision/hash, account mapping, pending/posted/removed state, exact normalized facts or validation reason, optional pending predecessor. Private, versioned, durable. |
| Ledger association | Observation-to-ledger provenance with at most one current ledger association per posted observation. Retain earlier voided/replaced associations; unique current association enforced in PostgreSQL. Existing ledger source widens to `CONNECTED`. |
| Sync round / stage | Round ID, connection generation, lease fence, original cursor, page cursor and staged deltas. Incomplete rounds cannot become visible activity or advance committed progress. |
| Durable work | Connection-scoped coalescing sync demand, lease deadline/fence, attempt count, retry time and safe error class. Independent durable revocation work survives removal of membership. |
| Link attempt / mutation replay | Owner/household-bound, expiring attempt, state, canonical fingerprint and durable result; records ambiguous exchange outcomes rather than claiming failure. |

Use composite foreign keys to maintain household/owner/account/currency relationships as in manual finance. Provider
identifiers are case-sensitive opaque strings. Never expose them as browser resource IDs. One bank account linked
through two distinct Items is not reliably identifiable as the same account: warn against relinking, recommend
update mode, and do not claim cross-Item deduplication. Do not change existing account or transaction currency
when provider metadata changes: quarantine the conflicting observation and require review.

Ledger mutations and imports share a consistent lock order: household lifecycle, connection (when applicable),
account, expense, refunds in ascending UUID order, then allocations. Workers recheck current membership and
connection generation at commit. Use the existing five-second finance lock timeout and safe rollback semantics.
Existing ledger writes need not lock connections unless touching provider reconciliation state; no path may
acquire a connection lock after an account lock. Expected-version counters must never wrap.

Confirmation, resolution, replacement and account-selection always take the connection lock in this order;
pure manual writes do not. All observation changes and version comparisons participate in that serialization.
Forward migrations following V10 widen `MANUAL` account/transaction source constraints
to include `CONNECTED` and add CAD across backend, web and account/transaction/
allocation/participant database checks. Earlier six-currency manual data and strict
user-entered amount validation remain valid.

## 3. Application-owned adapter

The provider adapter supplies the following capabilities using application DTOs; SDK types stay inside it:

| Capability | Input / output |
| --- | --- |
| Start linking | Opaque local attempt reference, allowed countries `US/CA`, Transactions only, fixed configured redirect/webhook URLs → short-lived browser Link token + expiry. |
| Exchange new link | Short-lived public token → server-only Item identity and credential; never a browser-supplied account list. |
| Read account metadata | Credential → remote identities, type/subtype, currency, safe name; derive admission from authoritative provider response. |
| Start reconnect | Existing credential → update-mode Link token; success does not require a second public-token exchange. |
| Fetch changes | Credential, opaque cursor, fixed page size → account metadata, added/modified/removed observations, next cursor, has-more and readiness flags. |
| Verify event | Exact raw body bytes + signature header → verified event class/remote Item identity or typed rejection; no domain write before verification. |
| Revoke | Credential → confirmed remote removal, retryable failure or unknown outcome requiring reconciliation. |

Normalize failures to `NOT_READY`, `REAUTH_REQUIRED`, `CONSENT_REVOKED`, `RATE_LIMITED`, `TRANSIENT`,
`PAGINATION_RESTART`, `PERMANENT`, or `INVALID_DATA`. Provider codes are diagnostic mappings, never raw REST
errors. No provider request occurs while a domain write transaction is held. Fixed allowlisted provider hosts,
API environment/version and redirect URLs come from deployment configuration, never request-body URLs.

### Money and dates

Parse provider JSON decimal numeric tokens directly to `BigDecimal`, never through binary `double` or JavaScript
numbers; verify any SDK serialization behavior with fixtures before using it. Plaid's positive debit/negative
credit amount convention must be inverted into HouseSync's signed account-holder direction. Validate that
convention against checking and credit-card fixtures. Preserve exact numeric value; harmless provider decimal
padding can be stripped before scale validation, unlike strict user-entered decimal text. Reject rounding,
unsupported currency, unofficial-only currency, zero, excessive magnitude or fractional precision.

Use the posted transaction's provider calendar `date` as the initial `occurredOn`. Retain authorized/pending
dates only as private evidence, not a UTC-derived spending date. Apply ledger date bounds. A normalized signed
amount does not determine kind: incoming credits can be refunds or transfers; outgoing debits can be transfers.
The owner chooses `EXPENSE`, `INCOME`, `REFUND` or `TRANSFER` with existing sign, date and refund-group validation.
Descriptions obey existing length/validation limits; overlong or invalid provider descriptions require a
valid owner-supplied description at confirmation, rather than silently discarding the observation.

Provider padding normalization means removing only trailing zero fractional digits in excess of the declared
currency scale: USD `1.2300` becomes `1.23`, JPY `1.000` becomes `1`, but USD `1.2301` and JPY `1.001` are
quarantined. Do not strip meaningful digits, round or weaken strict manual request validation. Currency, zero,
magnitude and sign checks follow normalization; negative zero is zero and is rejected.

## 4. Linking, credentials and lifecycle

All browser mutations use existing session, CSRF, membership, owner authorization and durable idempotency rules.
Link attempts expire after 30 minutes or the provider token expiry, whichever is earlier. Their nonce is bound
to actor, household, environment and flow; a callback alone is not proof that linking or reauthentication succeeded.
For new links, exchange and verify accounts server-side, then reauthorize membership before committing.

An external exchange cannot be atomically committed with PostgreSQL. Persist intent before calling it; encrypt
any short-lived public token needed by the job. If exchange returns a credential, durably store it before further
network calls. If membership vanished, schedule revocation instead of admitting accounts. If the remote exchange
succeeded but its response/credential was lost, mark `OUTCOME_UNKNOWN`; do not blindly repeat a consumed-token
exchange or claim remote cleanup. Show recovery instructions to revoke via Plaid/bank tools and restart linking.
Retain a safe correlation ID for support. This gap requires an explicit fault-injection test and UI state.

Only browser Link tokens and transient public tokens cross the browser boundary, held in memory, never local
storage, URLs or logs. Server access credentials and queued exchange tokens are encrypted with authenticated
encryption, a key ID and rotation support; keys are separate from database/backups and absent from git. Bind
ciphertext to connection/attempt and environment. Production startup fails closed without valid key configuration;
missing/decryption-failed credentials block the job without erasing its reference. Scrub request/response logs,
traces and exception payloads. Provider webhooks and user financial data must not enter general diagnostics.

Connection states are `LINKING`, `ACTIVE`, `REAUTH_REQUIRED`, `SUSPENDED`, `DISCONNECTING`, `DISCONNECTED`,
and `ERROR`; sync state separately records `IDLE`, `QUEUED`, `RUNNING`, `RETRY_WAIT`, or `FAILED`.
`ACTIVE` does not mean fresh. Display `lastSuccessfulSyncAt`, initial/historical readiness and a stale indicator
after 24 hours without successful sync (an application UX threshold, not a provider freshness guarantee).

- `ITEM_LOGIN_REQUIRED` → REAUTH_REQUIRED, stop ordinary fetch retries; owner launches update mode. Verify
  recovery through a server-side provider call before ACTIVE; resume from the retained cursor.
  Beginning reconnect increments generation and invalidates pre-reconnect workers; its successful completion
  uses that same generation and retains the committed cursor. A late completion cannot defeat a subsequent
  disconnect or membership removal. Only ACTIVE/REAUTH_REQUIRED connections are eligible for update mode;
  SUSPENDED/DISCONNECTING/DISCONNECTED require cleanup and a fresh link, not token reuse.
  Start bumps connection version as well as generation. Completion bumps version for its state change but
  does not increment generation again. While REAUTH_REQUIRED or a reconnect attempt is in flight, coalesce
  sync demands without fetching except the explicit recovery verification call; resume normal fetch only
  after ACTIVE with no reconnect attempt in flight. Every effective connection mutation increments version.
- Revoked consent → stop imports immediately, increment generation and schedule remote removal; do not resume
  on an old webhook. Explicitly disconnected connections never reactivate; a new link has a new local identity.
- Membership leave/removal → increment generation and suspend connection in the lifecycle transaction, cancel
  import eligibility and queue revocation. Revocation workers are allowed to clean up without membership.
  Rejoining restores access to retained ledger, not bank consent or a revoked connection.
- Owner disconnect → DISCONNECTING and invalidate workers immediately; remote failure stays visible and retryable.
  Confirmed remote removal → DISCONNECTED and erase access credentials/cursor, retaining local history.
- Missing accounts or reduced account consent stop admission for that account and flag it for the owner;
  absence in account metadata is not a transaction removal. New accounts require explicit local selection.
- Archiving blocks new ledger admission for that account; retained observation changes can still be reviewed.
  Renames are local labels; subsequent provider names never overwrite them.

Retain latest normalized observations and minimal revision/provenance while the connection exists; no wholesale
raw payload archive. Staged page data expires within 24 hours after completion/abandonment. Exchange/public tokens
are erased immediately on terminal outcome or expiry; Link tokens are not persisted in plaintext. On confirmed
disconnect erase unadmitted observations and pending data, but retain minimal imported revisions/associations
needed to explain ledger corrections. A separate erasure flow and operational retention policy must be settled
before public production release; disconnect is not data deletion.

## 5. Durable synchronization and webhooks

1. Persist a new sync demand after linking and invoke `/transactions/sync` at least once even when no webhook
   has arrived. An empty first response is valid asynchronous initialization, not proof of completed history.
2. Claim a database lease with a monotonically increasing fence. Start from the committed Item-wide cursor
   (omitted initially); fetch/stage pages outside long-held domain locks. Use `count=100`, no per-account cursor.
3. On pagination mutation or restartable pagination failure, discard the unfinished round and restart from its
   original committed cursor. Never expose partial pages or commit an intermediate page cursor.
4. On the final page, atomically apply the staged observations, durable review changes and final cursor after
   checking fence, generation, membership and current account eligibility. Ledger entries are not mutated by
   this operation. A crash commits all or none; a superseded worker cannot commit. Bound a round to 50,000
   deltas / 50 MiB staged data; exceeding the bound preserves the original cursor and surfaces a resumable
   operator-visible capacity failure rather than skipping records. These are initial application limits.
5. Invalid domain observations with usable remote identities are durably quarantined with safe reason codes;
   their page may commit because the unresolved work is persisted. Corrupt envelope/identity or staging failure
   aborts the round. Removed unknown IDs become tombstones so replay cannot resurrect stale staged data.
6. Persist/observe a demand sequence so a webhook during a running round causes another round rather than
   being lost when work is marked complete. Periodic eligible-connection polling every six hours with jitter
   recovers missed webhooks; this reads cached provider changes, not the paid refresh endpoint.

Initial operational defaults: 5-second connection and 20-second overall provider request timeouts, 2-minute
renewable leases, five retries with full jitter over exponential 5-second base capped at 15 minutes; honor a
longer provider Retry-After. Then persist FAILED, retain cursor and wait for an owner retry or next scheduled
cycle. Pagination restarts share this attempt budget. Auth/permanent errors wait for corrective action.
Worker concurrency initially two globally and one per connection; tune only with evidence. Apply a per-owner
minimum 60-second manual sync interval and coalesce concurrent requests; UI never promises immediate new bank data.

### Webhook trust boundary

`POST /api/provider-webhooks/plaid` is the only session/CSRF-exempt provider endpoint. Enforce a 1 MiB raw-body
limit, JSON content type and rate limiting. Verify `Plaid-Verification`: ES256 only, supported EC/P-256 JWK
obtained from Plaid using `kid`, valid signature, `iat` no older than five minutes and no more than 30 seconds
in the future, and constant-time SHA-256 comparison of the **original bytes** with `request_body_sha256`.
Do not trust a header-provided key URL or fetch arbitrary hosts. Cache valid non-expired keys for at most one
hour, refresh on expiry/unknown key, reject expired keys; bound unknown-key fetches to resist amplification.
Temporary verification-key infrastructure failure returns 503 with no admission, not success.

The security filter explicitly permits only this exact POST route and exempts only it from CSRF; other provider
paths/methods retain deny-by-default behavior. Verification-key lookup uses the adapter's fixed allowlisted Plaid
host, never JWT `jku`/`x5u` URLs. Use an injected clock for signature age, leases, retries and expiry tests.

After verification, atomically store a replay fingerprint `(provider, environment, signed-JWT hash, body hash)`
and coalesced job demand; retain the fingerprint at least 24 hours. Return 200 only after commit (including
already committed replay); database failure returns 503. Invalid signature/body/age returns generic 401, bad
format 400, oversized body 413. Never echo Item IDs or payloads. Unknown Items and recognized-but-irrelevant
events return 200 after verification without revealing existence. Map `SYNC_UPDATES_AVAILABLE` to sync demand,
Item auth/consent events to connection health work; legacy transaction webhooks do not apply ledger deltas.
Out-of-order signed events cannot reactivate disconnected or newer-generation state: confirm recoverable health
with the provider, and use the cursor as transaction truth. A wake-up need not be delivered exactly once.

## 6. Reconciliation and user corrections

| Provider change | Required local result |
| --- | --- |
| Added pending | Private informational activity; cannot confirm, share, allocate, or contribute to reports. |
| Pending removed + posted added | Link using explicit predecessor ID when present; retain one posted candidate. No heuristic matching if absent. Pending entries have no ledger edits to migrate. |
| New posted | Private unreviewed candidate; valid owner confirmation admits once under unique association + durable key. |
| Exact replay | No duplicate candidate, ledger entry, review task or version increment. |
| Modified unadmitted posted | Update candidate revision; stale confirmation fails version check. Dismissed items reopen on a materially changed money/date/status revision, not cosmetic metadata. |
| Modified admitted | Persist newest bank revision and one coalesced review item; preserve confirmed ledger, visibility, category and allocations. Cosmetic provider-only metadata needs no ledger review. |
| Removed unadmitted | Retained tombstone, no confirm action. |
| Removed admitted | Private removal review; do not hard-delete, automatically void or silently alter totals/obligations. |
| Reversal / credit | Separate candidate, not automatic void or refund; require economic kind and valid expense reference for a refund. |

Confirmation accepts the current observation version, chosen kind, valid description, optional category and
refund source. Initial amount/currency/date come from the selected bank revision; user corrections follow existing
ledger actions. Posting is atomic with association and idempotent result; a second different key cannot admit
the same observation again. `CONNECTED` account entries may only be created through this confirmation service,
not by manual POST; existing MANUAL accounts remain unchanged.

Reject submitted `accountId`, `money`, `occurredOn`, `owner`, `source` or `visibility` in confirm/replace bodies;
account and initial money/date derive from the current observation. Initial admission requires ACTIVE connection,
selected eligible account, current membership and non-archived account. Retained admitted entries may be resolved
after disconnect; resolution does not restart sync or admit a new unselected account. Replacement requires a
retained valid posted revision and the same local account as the old entry; it cannot bypass an archived account's
new-entry restriction. Provider data needed for outstanding admitted reviews survives disconnect as minimal
provenance, including their removed status.

Post-disconnect resolve/replace still locks the connection in order and checks both versions/current membership,
but does not require ACTIVE or current selection. It never changes connection generation/state, restarts sync
or admits new bank history. Existing ledger account/refund/archival restrictions still apply to replacement.

A CONNECTED refund must reference a POSTED CONNECTED expense in the exact same local account, household,
owner and currency; cross-account, cross-Item and MANUAL/CONNECTED refund linking is not supported. Keep the
existing composite refund foreign key and locked date/cumulative-cap checks. Category omission inherits the
source; an explicit value must match (including null only if the source is uncategorized). All refund-group
visibility/category and source-version propagation rules remain unchanged.

Resolution uses both current observation and ledger versions, locks the existing refund/allocation group, and
offers `KEEP_LEDGER`, `APPLY_BANK`, or `VOID_LEDGER`. KEEP_LEDGER records an explicit decision against that exact
revision; a later material revision reopens review. APPLY_BANK changes only selected amount/date/description
fields with existing constraints, never kind/currency/account/category/visibility/refund links. It is unavailable
for removed observations. VOID_LEDGER obeys the existing requirement to void live refunds first and atomically
deactivates allocations; explain the effect on household balances before confirmation. An active allocation
blocks money changes with ALLOCATION_CONFLICT; never bypass it or drop frozen participants to force an update.

A kind/account/refund-link correction uses an explicit atomic replacement workflow: void the old entry under
manual-finance constraints, create the replacement from the current posted observation, and move the current association
while retaining history. Do not allow a second ordinary confirmation to achieve replacement. Currency/account
mismatches require a separately reviewed mapping correction and remain blocked. A directly voided imported
entry stays associated and excluded; a later sync must not recreate it. Manual owner patches to imported ledger
fields retain their values across all syncs and update the ledger version normally.

Replacement may atomically deactivate an active allocation through the old entry's void operation; it never
copies or recreates that allocation. Require `acknowledgeAllocationRemoval:true` when one is active, otherwise
return ALLOCATION_CONFLICT. Show the removed obligations before submission. The replacement is PRIVATE except
for a linked refund's inherited disclosure; creating a new allocation is a separate explicit action. The old
entry cannot be replaced while live refunds remain. APPLY_BANK money edits remain blocked by active allocation.

## 7. Browser API surface

Prefix `H` means `/api/households/{householdId}`. Existing transport, UUID, paging, error-envelope and privacy rules
apply. Collections use bounded `limit`/`offset` as in manual finance and deterministic created-at/UUID ordering; detail GETs
expose the current versions needed for actions. No client supplies owner, provider credential, remote Item identity,
arbitrary callback URL or cursor. Every POST requires Idempotency-Key scoped to actor/household/operation plus
canonical payload; replay reauthorizes and returns current local state. Versioned POSTs require expected versions.

Sync and admission routes: `POST H/financial-connections/{id}/sync`, `GET H/bank-activity` and
`GET H/bank-activity/{id}` (owner-only, optional local connection/account, state, and review filters),
`POST H/bank-activity/{id}/confirm`, and `POST H/bank-activity/{id}/dismiss`, plus the only session/CSRF-exempt
provider endpoint `POST /api/provider-webhooks/plaid`. Reconciliation routes:
`POST H/bank-activity/{id}/resolve` and `POST H/bank-activity/{id}/replace-ledger`.

| Method / path | Body / purpose | Result |
| --- | --- | --- |
| POST H`/connection-link-attempts` | `{}`; initial linking | 201 attempt ID, flow, Link token, expiresAt; 200 replay while token valid; expired attempt → 409 LINK_ATTEMPT_EXPIRED. |
| POST H`/connection-link-attempts/{id}/complete` | `publicToken` for new flow; `{}` for reconnect | 202 durable operation ID/status URL; never assume browser metadata proves success. |
| GET H`/connection-operations/{id}` | Owner-only recovery/status | 200 state, safe error, connectionId when known; unknown exchange outcome is explicit. |
| GET H`/financial-connections` or `/{id}` | Owner-only list/detail | 200 local identity, safe label, lifecycle/version, sync state/timestamps/readiness; no credentials or provider IDs. |
| GET H`/financial-connections/{id}/accounts` | Owner-only bounded page of discovered mappings | 200 local mapping ID, local accountId if admitted, safe name/kind/currency, selected/eligible flags and exclusion reason. |
| POST H`/financial-connections/{id}/account-selection` | `expectedVersion`, selected local account-mapping IDs | 200 selected eligible accounts; new mappings default unselected; deselection stops admission and preserves history. |
| POST H`/financial-connections/{id}/reconnect` | `expectedVersion` | 201 bound update-mode attempt + Link token; completion through the attempt endpoint. |
| POST H`/financial-connections/{id}/sync` | `expectedVersion` | 202 coalesced operation; safe 429 if manual rate limit exceeded. |
| POST H`/financial-connections/{id}/disconnect` | `expectedVersion` | 202 disconnect operation after local generation change; remote confirmation polled through operation GET. |
| GET H`/bank-activity` or `/{id}` | Optional local connection/account ID and state filters | 200 owner-only normalized observations, versions, safe validation reason, ledger association, review status. |
| POST H`/bank-activity/{id}/confirm` | `expectedVersion`, `kind`, `description`, optional `category`, `refundOfTransactionId`, shared-refund `acknowledgeDisclosure:true` | 201 ledger DTO; 200 replay; manual-finance category/refund constraints apply. |
| POST H`/bank-activity/{id}/dismiss` | `expectedVersion`, reason `ALREADY_RECORDED` or `NOT_NEEDED` | 200 retained dismissal, no ledger effect; only unadmitted observations. |
| POST H`/bank-activity/{id}/resolve` | `expectedVersion`, `expectedLedgerVersion`, action; APPLY_BANK `fields` subset of amount/occurredOn/description | 200 current review + ledger; constraint failure leaves both unchanged. |
| POST H`/bank-activity/{id}/replace-ledger` | Both versions, new `kind`, `description`, optional category/refund source/disclosure and allocation-removal acknowledgements | 201 replacement + retained association history; current posted observation required, existing refund/allocation constraints apply atomically. |

Provider account names and inbox details are private even if a resulting transaction is shared. Existing ledger
DTO adds only source enum `CONNECTED`; provider evidence/connection references live in owner-only activity APIs.
Existing ledger PATCH/share/allocation/report paths remain authoritative, with source-aware creation validation.
The frontend must handle the additive source value without disabling legitimate correction/share actions.

Foreign, former-member, other-owner and missing resources produce indistinguishable 404s. Reuse
VALIDATION_FAILED, RESOURCE_VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, FINANCE_BUSY and allocation/refund errors.
New safe 409 codes include CONNECTION_NOT_READY, CONNECTION_DISCONNECTED, LINK_ATTEMPT_EXPIRED,
OBSERVATION_NOT_POSTED, OBSERVATION_ALREADY_CONFIRMED, OBSERVATION_INVALID and RECONCILIATION_REQUIRED;
transient remote errors are operation state, not leaked provider messages. Credentials are never returned by
operation replay. Replaying token-bearing attempt creation after expiry requires a new attempt, not hidden
external regeneration under the same key. Store any replayable Link token encrypted until expiry.

### Durable operation identity

Fingerprints include the operation's target local ID, normalized body and expected versions. Actor and household
are scope keys, not trusted body fields. Same key with differing fingerprint returns IDEMPOTENCY_CONFLICT before
any external call; authorization always runs before replay. Persist outcomes and domain changes atomically.
New operations extend or introduce constrained replay storage through forward migrations, not edits to existing keys.

| Operation token | Additional canonical input |
| --- | --- |
| CONNECTION_LINK_START | Environment, provider, flow NEW, fixed country/product configuration; empty body. |
| CONNECTION_LINK_COMPLETE | Attempt ID, attempt flow, keyed HMAC of public token for NEW; empty body for UPDATE. |
| CONNECTION_ACCOUNTS_SELECT | Connection ID, expectedVersion, sorted unique local mapping IDs; empty selection allowed. |
| CONNECTION_RECONNECT | Connection ID, expectedVersion, environment/provider and flow UPDATE. |
| CONNECTION_SYNC | Connection ID and expectedVersion. |
| CONNECTION_DISCONNECT | Connection ID and expectedVersion. |
| BANK_ACTIVITY_CONFIRM | Observation ID/version, kind, description, category instruction, refund source, disclosure acknowledgement. |
| BANK_ACTIVITY_DISMISS | Observation ID/version and reason. |
| BANK_ACTIVITY_RESOLVE | Observation ID/version, ledger version, action and sorted field set. |
| BANK_ACTIVITY_REPLACE | Observation ID/version, ledger version, kind/description/category/refund instructions and both acknowledgements. |

Missing acknowledgements canonicalize to false. Non-refund omitted/null category canonicalize to null;
refund omission means INHERIT and remains distinct from an explicit value, following the manual-finance API. Reject duplicate
selection IDs and unknown fields before canonicalization; normalize strings using the existing finance rules.
Do not include changing provider responses in a request fingerprint. Token HMAC keys are server-side/versioned;
never persist a raw public token in a fingerprint or error. Store the short-lived token encrypted only for the
in-flight exchange; erase on terminal outcome/expiry. Link token replay uses separate encrypted expiring storage.

Completion retries with the same key return the persisted operation, never exchange the consumed token twice.
The attempt itself has a unique completion so another key cannot trigger a second exchange. A timed-out worker
does not automatically re-exchange an attempt marked EXCHANGING; it becomes OUTCOME_UNKNOWN unless a durable
credential/result proves completion. Disconnect retries may call remote removal only through its durable job;
ambiguous outcomes retain cleanup credentials and a visible retry state until confirmed or manually reconciled.

Selection creates local CONNECTED accounts only for eligible mappings, idempotently; selection changes preserve
existing account identity and labels. Deselecting retains already fetched private history but blocks admission
until selected again. Item-wide Sync can return unselected account data: consume it only to advance the Item cursor,
do not retain its transaction payload. Selecting a previously unselected account starts a fenced full Item replay
from the initial cursor, retaining existing deduplication/associations; never reuse a cursor that skipped its
history. Atomically reset committed progress and readiness with the selection change, invalidate old workers,
and explain that available historical coverage may differ from the original import.
The advanced cursor remains valid for still-selected mappings; only adding a selection that lacks imported
history forces the Item-wide reset. Preserve all existing deduplication, associations and confirmed ledger
through that reset. Account selection requires ACTIVE and no reconnect attempt in flight.

UI must preserve drafts on background updates, show explicit selection/consent, distinguish pending/unreviewed/
confirmed/needs-review, and support keyboard/mobile interaction. Stale forms require refetch and review rather
than silently changing submitted financial facts. A popup/callback failure leaves a resumable local attempt;
connection failure must not disable manual finance. Sign-out/household switch clears all private provider UI state.
Inbox reads are driven by household/filter changes and explicit refresh signals, not
by changing parent callback identities. Unrelated form typing must neither reload the
inbox nor move focus to its previous error notice; authorization failures still invoke
the current session/access handlers.

Connections and bank activity have separate household URL destinations. Previously
visited controllers may retain scoped memory while inactive, but render no DOM and
pause reads/polling. Before a mutation is sent, retain its exact body and idempotency
key, including memory-only link completion material. If navigation interrupts the
response, return to an explicit same-request retry; never replace its payload/key
with an edited draft or a fresh provider callback. Competing mutation controls remain
locked until the retained outcome is reconciled. Identity, household and authority
scope teardown still clears private state.

## 8. Implemented boundary and reproducible checks

The application implements private link/selection/disconnect, durable staged sync
with verified webhook wake-ups, explicit posted-admission review and owner-mediated
reconciliation of changed or removed observations. The provider adapter is exercised
through deterministic fake-provider/PostgreSQL/browser scenarios and available
Sandbox flows, including signed webhook admission and pending-to-posted transitions.
The available live-provider exercise does **not** establish a bank-initiated
modification/removal of an already posted admitted transaction; neither live
institution coverage nor production provider configuration is claimed.

The following matrix identifies the behavior the tests reproduce.

For focused evidence, see [sync and cursor integration tests](../../backend/src/test/java/com/housesync/finance/connection/ConnectedFinanceSyncIT.java),
[sync races](../../backend/src/test/java/com/housesync/finance/connection/ConnectedFinanceSyncRaceIT.java),
[reconciliation](../../backend/src/test/java/com/housesync/finance/connection/ConnectedFinanceReconciliationIT.java),
[adapter mapping](../../backend/src/test/java/com/housesync/finance/connection/PlaidAdapterMappingTest.java)
and [HTTP adapter tests](../../backend/src/test/java/com/housesync/finance/connection/PlaidHttpAdapterTest.java).

- Exact debit/credit/credit-card signs, CAD and existing zero/two/three-decimal currencies; no binary-float
  parsing; unsupported/zero/overscale/unofficial values quarantined; no USD/CAD aggregation or implicit FX.
- Duplicate-shaped legitimate transactions survive; duplicate IDs/events/requests create one association;
  same external ID in different Items remains isolated. Private/pending/unreviewed activity never enters totals.
- First sync empty then ready, multi-page history, mutation restart, duplicate/out-of-order wake-ups, unknown
  removal, page corruption, quarantine, over-limit round, crash before/after commit and expired lease fencing.
- Known pending predecessor → posted; missing predecessor never heuristic merge; manual duplicate dismissal.
- Posted amount/date/name changes, removal and positive reversal preserve owner corrections and shared amounts
  until explicit resolution. Refund date/cap, active allocations, frozen participants and void/replacement rules
  hold; zero-sum balances survive every resolution, and stale versions fail without partial writes.
- Cross-household/same-household other owner, leave/removal/rejoin, shared redaction, generation invalidation,
  account deselection/archive, revoked consent and disconnect during sync prevent private reads/new imports.
- Wrong algorithm/key/signature, expired/future JWT, byte-level body mismatch, replay, key-fetch outage, unknown
  Item and database outage; respond only after durable admission. No credentials or financial payloads in logs.
- Provider timeout/rate limit/auth failure, reconnect unchanged-token behavior, missed-webhook polling,
  interrupted exchange and ambiguous removal; no success/billing-stop claim until remote confirmation.
- Forward-only PostgreSQL migrations from V10, constraint/lease/idempotency concurrency, rollback and
  restart persistence. No in-memory DB substitution.
- The deterministic fake-provider suite needs neither live accounts nor paid calls and covers admitted
  modification/removal resolution. Plaid Sandbox exercises cover what the public provider API can trigger:
  fresh link/selection/sync, signed webhook delivery, custom posted confirmation, pending removal/posted
  replacement, reconnect/disconnect, and keyboard/mobile/error recovery. A pending replacement is not proof of
  an already-posted modification/removal. Live institution coverage is separate.

Provider credentials, specific bank coverage, production account approval/pricing and deployable public webhook/
redirect URLs are external prerequisites for live operation; fakes do not substitute for them.
