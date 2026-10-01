# Categorization contract

**Status:** Deterministic categorization, owner-private exact rules, review work and an
optional AI-suggestion adapter are implemented. The AI provider is disabled by default;
live model quality and production erasure remain unverified.

[ADR 0009](../decisions/ADR-0009-deterministic-categorization.md) records the
decisions. The [manual-finance API](manual-finance-api.md) and
[connected-finance contract](connected-finance-contract.md) define transaction/refund
semantics and bank reconciliation.

## 1. Baseline and invariants

The fixed server-owned taxonomy, owner category corrections, whole-refund-group
inheritance, and strict web transaction DTOs remain intact. Assignment provenance,
provider category evidence, owner-private rules and reviews and optional AI work
extend—not replace—those ledger rules.

1. The fixed taxonomy and labels remain server-owned. Category stays descriptive and cannot determine kind,
   visibility, spending inclusion, allocation, balance, or authorization.
2. Explicit user category decisions, including explicit uncategorized, are authoritative and survive every sync,
   reconciliation action, rule/mapping change, and model result.
3. Refunds are never classified independently. They inherit and atomically follow their source expense,
   including retained voided refunds.
4. Only `POSTED` confirmed ledger entries are eligible. Pending, invalid, unadmitted, removed, and dismissed bank
   observations never receive ledger categories or enter reports.
5. Connected-finance provider updates never silently rewrite a confirmed category. `APPLY_BANK` still changes only selected
   amount/date/description fields; replace-ledger remains an explicit owner action.
6. Rule, suggestion, provider evidence, review count, and model data are private to the financial owner. A shared
   transaction discloses only the already-visible effective category.
7. Categorization never calls an external service while holding database or ledger locks.

`H` below means `/api/households/{householdId}`. All browser responses remain `Cache-Control: no-store`; unsafe
methods require the established session CSRF contract. Only delivered method/path combinations enter the security
allowlist.

## 2. Effective assignment

### Assignment state

The effective category remains the transaction's nullable `category`. A one-to-one persisted categorization state
records:

| Field | Contract |
| --- | --- |
| `origin` | `NONE`, `LEGACY`, `USER`, `OWNER_RULE`, `PROVIDER`, or `INHERITED`. |
| `assignedAt` | Server `Instant`; required for every state. Migration time is used for `LEGACY` backfill. |
| `rulesetVersion` | Bounded application version for `OWNER_RULE`/`PROVIDER`; null otherwise. |
| `ruleId` | Internal nullable owner-rule reference; never in a browser projection. |
| `evidenceFingerprint` | Internal nullable digest used to reject stale suggestion work; never browser-supplied. |

Database checks enforce valid origins and structural combinations: `NONE` requires a null category; `OWNER_RULE`
requires a retained rule reference while other origins do not; `INHERITED` requires `kind=REFUND` plus the
existing refund source; non-refunds cannot be `INHERITED`; refunds cannot use another origin. The application
requires the referenced rule to be active when assigning under the established locks; later deactivation keeps
the foreign-key target and historical provenance intact.

A rule may later be deactivated without rewriting prior assignments. A provider mapping version may later change
without rewriting prior assignments. Provenance describes how the current category was assigned, not what the
latest classifier would choose.

### Legacy migration

The first categorization migration (V15) is forward-only and additive:

- existing non-refunds become `LEGACY`, whether category is a token or null;
- existing refunds become `INHERITED` and retain their source's current category;
- no existing transaction category, version, or `updatedAt` changes;
- upgrade from every supported schema through the new version and Hibernate validation must pass; and
- rollback of a failed migration leaves the prior schema/data intact.

This deliberately protects historical values without claiming they were explicit user choices. There is no
automatic backfill classifier or provider refetch.

### New-entry semantics

For a new non-refund manual create, bank-activity confirmation, or replacement:

| Category instruction | Result |
| --- | --- |
| Explicit supported token | Store token with `USER`; do not run automation. |
| Omitted or explicit null | Treat identically for the existing idempotency fingerprint; run the deterministic classifier. |
| Exact owner rule match | Store its token with `OWNER_RULE`. |
| No rule, exact provider mapping | Store mapped token with `PROVIDER`. |
| No auto-applicable match | Store null with `NONE`; a heuristic/AI suggestion may be created later. |

A same-key replay returns the already-created current representation and never reruns classification. A changed
payload remains `IDEMPOTENCY_CONFLICT`. Refund category omission remains `INHERIT`, not classifier eligibility.

### User correction

A successful category field in the existing transaction PATCH, including explicit null, sets `USER`, clears
rule/provider assignment references, resolves or supersedes any open suggestion, and performs the existing
transaction/refund-group version bumps atomically. A no-op that repeats the same category is still a user decision
when the prior origin was automated, `NONE`, or `LEGACY`; it changes provenance and therefore bumps the version.
A repeated same category when origin is already `USER` remains the accepted no-op.

Void, allocation, visibility, refund-cap, authorization, and lock-order rules are unchanged. A direct refund
category patch remains `VALIDATION_FAILED`; source-expense propagation updates refund category while retaining
`INHERITED`.

## 3. Deterministic classifier

The classifier is an application/domain service, not a controller, JPA callback, provider SDK hook, or web
implementation. It receives already-authorized normalized evidence and returns one of:

- an auto-applicable exact assignment (`OWNER_RULE` or `PROVIDER`);
- a review-only deterministic suggestion; or
- no result.

It applies the ADR precedence exactly. User and refund decisions short-circuit classification. Rule lookup is
scoped by household and financial owner in SQL; fetching broadly and filtering in memory is prohibited.

### Provider evidence

The application-owned provider transaction type may add bounded nullable values for:

- stable provider merchant identity;
- merchant display name distinct from statement description; and
- provider personal-finance category primary/detail codes.

Provider implementations validate and normalize these values before returning them. SDK objects and raw payloads
never escape the adapter. Stable merchant identity is stored as a digest bound to provider/environment; browser
APIs and logs never expose it. Display/category strings are bounded and treated as untrusted private data.

Observation persistence stores only the normalized evidence needed for later classification. The connected-finance
`providerRevision` remains the exact money/date/state revision. Categorization evidence has a separate digest, so
a category/name-only provider update does not reopen bank reconciliation or alter a confirmed ledger.

### Provider mapping

The provider mapping is a reviewed application-owned table in code, versioned as one ruleset. It maps explicit
supported provider primary/detail codes to the existing HouseSync tokens. Detail may refine primary; no string
similarity or default `MISCELLANEOUS` catch-all is allowed. An unknown or unsupported code yields no assignment.

Mapping must consider transaction kind only to avoid nonsensical auto-application; it never changes kind. A code
that cannot be mapped safely becomes a review candidate or remains uncategorized.

### Conservative text normalization

Text-derived merchant rules use one documented normalizer:

1. Unicode NFKC normalization;
2. lowercase with locale-independent rules;
3. collapse Unicode whitespace runs to one ASCII space and trim; and
4. preserve punctuation, digits, and token order.

Empty or over-limit results cannot form a rule. No suffix stripping, store-number removal, stemming, substring,
edit-distance, amount/date correlation, or fuzzy matching is permitted. A provider-stable merchant identity takes
precedence over text. The normalizer version participates in the rule ruleset version so behavior cannot drift
silently.

## 4. Owner-private rules

### Rule shape

A categorization rule belongs to one household and one financial owner. It contains a server-derived match type
(`PROVIDER_MERCHANT` or `NORMALIZED_TEXT`), private match key and display label, one taxonomy category, status
`ACTIVE`/`INACTIVE`, integer version, ruleset version, and timestamps. References use stable user IDs, never
membership rows, so departure preserves retained history while current membership gates access.

At most one active rule exists for an owner/match key. Rule queries and uniqueness include household and owner.
A household `OWNER` role has no override over another user's rules.

### Rule API

| Method/path | Request | Success |
| --- | --- | --- |
| `GET H/categorization-rules` | `limit` (default 50, 1-100), `offset` (default 0, 0-10000), optional `status=ACTIVE|INACTIVE` | 200 current actor's private page ordered by `updatedAt DESC, id DESC`. |
| `POST H/transactions/{transactionId}/categorization-rule` | Exact JSON `{"expectedTransactionVersion":0}`; required `Idempotency-Key` | 201 exact rule derived from the actor-owned posted non-refund transaction; 200 same-key replay. |
| `PATCH H/categorization-rules/{ruleId}` | `expectedVersion` plus exactly one of `category` or `status:"INACTIVE"` | 200 updated private rule. |

A rule item has exactly:

```json
{
  "id":"70000000-0000-4000-8000-000000000001",
  "sourceTransactionId":"40000000-0000-4000-8000-000000000001",
  "matchType":"PROVIDER_MERCHANT",
  "matchLabel":"Corner Market",
  "category":"GROCERIES",
  "status":"ACTIVE",
  "version":0,
  "createdAt":"2026-09-22T12:00:00Z",
  "updatedAt":"2026-09-22T12:00:00Z"
}
```

`matchLabel` is a bounded private display label, not the match key. List responses have exactly
`{"items":[...],"limit":50,"offset":0,"hasMore":false}`; there is no total count. The web uses a dedicated
strict parser. A category PATCH is valid only for an active rule. Status accepts only the one-way `INACTIVE`
transition.

Rule creation uses the transaction's current effective category and requires `origin=USER` with a non-null
category. The server derives the strongest available merchant key; it rejects a transaction with no safe key.
The client cannot submit household/owner/match fields. A conflicting active key returns
`409 CATEGORY_RULE_CONFLICT` without exposing another user's rule. Deactivation is retained, not deletion.
Reactivation, bulk apply, import, export, and cross-owner sharing are not supported routes.

Rule updates affect only future classification. Existing `OWNER_RULE` assignments retain their effective category
and provenance until the owner changes them explicitly.

## 5. Suggestions and review

### Review state

A categorization review item is one owner-private suggestion against one posted non-refund transaction. It stores
suggested token, source `HEURISTIC`/`AI`, confidence `HIGH`/`MEDIUM`/`LOW`, bounded safe reason code, ruleset or
model-policy version, evidence fingerprint, evaluated transaction version, status
`OPEN`/`ACCEPTED`/`CHOSEN`/`KEPT`/`SUPERSEDED`, integer version, and timestamps.

A partial unique constraint permits at most one `OPEN` item per transaction. Creating new work coalesces by
evidence fingerprint. Exact replay creates no extra row or version bump. Changed evidence may supersede an open
item only while the transaction remains eligible with origin `NONE`, `OWNER_RULE`, or `PROVIDER`; it never changes
the effective category. Any resolved action records `USER`, after which later work cannot reopen review.

### Review API

| Method/path | Request | Success |
| --- | --- | --- |
| `GET H/categorization-reviews` | `limit` (default 50, 1-100), `offset` (default 0, 0-10000), optional `view=OPEN|HISTORY` (default `OPEN`) | 200 owner-private page ordered by `createdAt DESC, id DESC`. |
| `GET H/categorization-reviews/{reviewId}` | No body or query | 200 owner-private review item. |
| `POST H/categorization-reviews/{reviewId}/resolve` | Exact action body below; required `Idempotency-Key` | 200 resolved review item with the current transaction; same-key replay also returns 200. |

A review item has exactly 11 fields:

```json
{
  "id":"80000000-0000-4000-8000-000000000001",
  "transaction":{
    "id":"40000000-0000-4000-8000-000000000001",
    "householdId":"20000000-0000-4000-8000-000000000001",
    "ownerUserId":"30000000-0000-4000-8000-000000000001",
    "accountId":"10000000-0000-4000-8000-000000000001",
    "kind":"EXPENSE",
    "money":{"amount":"-12.34","currency":"USD"},
    "occurredOn":"2026-09-22",
    "description":"Corner Market",
    "category":null,
    "visibility":"PRIVATE",
    "source":"CONNECTED",
    "status":"POSTED",
    "refundOfTransactionId":null,
    "version":0,
    "createdAt":"2026-09-22T11:00:00Z",
    "updatedAt":"2026-09-22T11:00:00Z"
  },
  "evaluatedTransactionVersion":0,
  "suggestedCategory":"GROCERIES",
  "source":"HEURISTIC",
  "confidence":"HIGH",
  "reasonLabel":"Merchant pattern matched",
  "status":"OPEN",
  "version":0,
  "createdAt":"2026-09-22T12:00:00Z",
  "updatedAt":"2026-09-22T12:00:00Z"
}
```

The nested `transaction` is the unchanged exact 16-field owner transaction DTO. A page has exactly
`{"items":[...],"limit":50,"offset":0,"hasMore":false,"openCount":1}`; `openCount` is the current owner's total
open count in this household, independent of `view`. The web uses separate strict item/page parsers.

Resolve bodies have exactly `expectedVersion`, `expectedTransactionVersion`, and `action`, plus `category` only
for `CHOOSE_CATEGORY`:

- `ACCEPT_SUGGESTION`: use the item category;
- `CHOOSE_CATEGORY`: require a supported explicit token;
- `KEEP_CURRENT`: require a non-null current category, preserve it, and record `USER`; and
- `KEEP_UNCATEGORIZED`: require the current category to be null and record `USER` null.

The current review producer opens heuristic reviews for uncategorized `NONE` entries, so ordinary review
items have no current category and the web disables `KEEP_CURRENT` with an explanation. The backend accepts
the conditional action for a coherent non-null OPEN state, covered by a PostgreSQL HTTP regression; the action
does not authorize suggestions to auto-assign categories.

Examples are `{"expectedVersion":0,"expectedTransactionVersion":0,"action":"ACCEPT_SUGGESTION"}` and
`{"expectedVersion":0,"expectedTransactionVersion":0,"action":"CHOOSE_CATEGORY","category":"GROCERIES"}`.
The two keep actions use the first three-field shape with their respective action token. Unknown fields,
missing conditional fields, and a category on any action except `CHOOSE_CATEGORY` are validation errors.

Resolution returns the exact review-item shape above with resolved status and the committed current transaction.
It locks the transaction and refund group under the established ordering, rechecks ownership/membership, both
versions, posted state, and evidence, then applies one atomic user decision. The current-version conflict is
`RESOURCE_VERSION_CONFLICT`; missing/hidden/private resources use the same privacy-preserving generic 404 policy
as transactions. Same-key replay reauthorizes and returns the current representation without reapplying.

Direct category PATCH and transaction void supersede an open item. Unrelated ledger version bumps (including
visibility, allocation, and refund-source changes) advance the open item's evaluated transaction version and
review version under the same locks when evidence is unchanged; changed description/evidence supersedes it and
may create a new eligible suggestion. A confirmed observation becoming removed or otherwise non-posted
supersedes its open review without changing the confirmed ledger or the bank-reconciliation decision; a later
posted revision with new eligible evidence may open a successor. Exact removal replay adds no review version.
Stale requests conflict, while a refetched eligible item remains actionable. User departure prevents new
work and access; rejoin restores access only to the same retained owner data under existing lifecycle rules.

### Owner-only categorization API

The exact 16-field transaction response remains unchanged. Categorization adds:

| Method/path | Request | Success |
| --- | --- | --- |
| `GET H/transactions/{transactionId}/categorization` | No body or query | 200 current financial owner's safe categorization state. |

The route is financial-owner-only. Another member receives the generic transaction 404 even when the effective
transaction is shared with them. The response has exactly:

```json
{
  "transactionId":"40000000-0000-4000-8000-000000000001",
  "transactionVersion":0,
  "category":"GROCERIES",
  "origin":"PROVIDER",
  "assignedAt":"2026-09-22T12:00:00Z",
  "reviewState":"NONE"
}
```

`category` is nullable, `origin` uses the six assignment origins, and `reviewState` is `NONE` or `OPEN`.
`LEGACY` renders as neutral “Existing category,” never “Chosen by you.” No rule ID,
provider code, merchant key, confidence, reason, model, or evidence digest appears here. The web uses a separate
strict parser and loads provenance when the owner opens transaction details; it does not weaken or widen the
shared transaction parser and does not issue one request per feed row.

The owner-only response has exactly seven fields: `"ruleEligible":true` follows
`reviewState`. The capability is true only when the current posted non-refund has `origin=USER`, a non-null
category, a safe server-derived match key, and no active rule for that key. The browser's strict parser
shows “Use for future matches” only when this capability is true; it never derives or receives the
private key.

Detailed suggestion source/confidence/reason exists only in the owner's categorization-review response. Server
responses return safe display text for user-visible reasons; clients do not expose raw codes as prose.

## 6. AI adapter

The application-owned AI interface accepts one bounded normalized request and returns a structured candidate.
The adapter configuration is off by default and keeps provider/model credentials server-side.

Allowed request fields are normalized merchant/description, transaction kind, and normalized provider category
codes. Forbidden fields include amount, currency, dates, account/institution/connection identifiers, user or
household identifiers, visibility, allocations, other members, cookies, tokens, and raw provider payloads.

The response validator requires exactly one current taxonomy token, confidence band, bounded reason code, and
configured model/policy identity. Unknown fields, prose-only output, invalid tokens, oversized content, timeouts,
rate limits, authentication errors, and provider outages create no assignment. Retry only documented transient
failures with a bounded budget; never retry validation/authentication failures blindly.

AI work runs after commit through the smallest durable mechanism needed to recover from process restart. Work is
idempotent by transaction version plus evidence/policy fingerprint, uses leases/fencing if multiple workers can
run, and rechecks eligibility before storing a suggestion. Raw prompts/responses and financial descriptions are
not logged. Retention and erasure are governed by a project-wide policy that does not exist yet, so a public
deployment cannot claim production readiness.

### Implemented AI work boundary

V18 records committed, owner-scoped work without storing a prompt, description, response, or credential. Eligible
posted non-refund entries with origin `NONE` and no deterministic or built-in merchant suggestion enqueue once
per transaction version, evidence fingerprint, and configured model/policy identity. An old model or changed
evidence becomes stale rather than reusing a prior result: the stored 32-hex-character `policy_version` derives
from both configured model and policy. A short PostgreSQL claim transaction uses `SKIP LOCKED`, a 30-second
lease, and a monotonically increasing fence; HTTP runs outside transactions. Completion takes the existing
household/account/ledger lock order, rechecks membership, current evidence, version, policy, and origin, and
commits only a V17 `source=AI` owner review. The ledger category and shared 16-field transaction response do
not change. A provider call that races an owner decision, removal, or newer claim cannot insert a review.

The application-owned Chat Completions-compatible adapter uses the exact server-configured model and policy;
the provider response must echo both, provide one taxonomy/category-kind-compatible token, one confidence
band, and one of `MERCHANT_CONTEXT`, `PROVIDER_CONTEXT`, or `TRANSACTION_CONTEXT`. Unknown fields, malformed
or oversized content, other tokens, and HTTP authentication errors fail terminally. Timeouts, transport
outages, HTTP 429, and 5xx retry at most twice after the initial call, with bounded backoff. Neither failed
nor stale work assigns a category. A local deterministic HTTP fake is used only for tests and isolated browser
checks; live model quality, provider coverage, production erasure, and public deployment are unverified.

`GET H/categorization-ai-work/status` is authenticated, finance-member-authorized, owner-scoped, and
`no-store`. With no query string it returns exactly
`{\"enabled\":boolean,\"pendingCount\":integer,\"failedCount\":integer}`; an unauthorized household is
indistinguishable from a missing one. Pending covers queued/running/due-retry work; failure covers only the
newest eligible work for each still-uncategorized entry under the current model/policy. A subsequent explicit
`USER` correction removes its old failure from the actionable count while retaining durable history. With AI
disabled, the response is `false/0/0`, no worker/provider request runs, and existing C review items remain
usable. The owner's web queue polls on a five-second timer only while work is pending, rereads after committed
owner actions, converges on the strict review page after settlement, preserves drafts, and offers a safe
message on terminal failure without exposing provider text.

## 7. Web experience

### Transactions and bank activity

- Keep the current server-returned taxonomy labels and explicit Uncategorized option. If taxonomy loading fails,
  show a recoverable “Category unavailable” state rather than exposing raw enum tokens as labels.
- Show a concise provenance label such as “Chosen by you,” “Your merchant rule,” or “Bank category” only after
  the financial owner opens transaction details and the owner-only categorization resource loads. Other household
  viewers see only the effective category.
- Transaction details render the existing ledger source accurately (`Manual` or `Connected`) before adding
  classification provenance; they must not hardcode every transaction as manual.
- A category correction, including Uncategorized, clearly says it becomes the owner's decision and will not be
  replaced by automation. Refund-group previews remain unchanged.
- After a successful correction, offer a separate “Use for future matches” action only when the server says a
  safe rule key is available. Rule failure does not roll back the already-saved category.
- Bank confirmation may preview the deterministic category. Selecting another token is a `USER` decision;
  leaving the existing omitted/null default permits deterministic classification. Refunds still omit category to
  inherit.
- Background updates preserve create/edit/confirm/review drafts. Stale versions force refetch and review rather
  than silently submitting new evidence.
- Before provider suggestions ship, bank confirmation/dismissal gains the same stale-version refetch-and-review
  recovery as resolve/replace; category errors bind to and focus the category control; confirmation drafts survive
  non-material evidence refreshes.

### Review queue

Transactions/Home may expose an owner-private open count and one entry point. The queue must distinguish current
category from suggestion, explain why review is requested, and provide all four resolution actions without
implying that AI confidence is certainty. “Keep uncategorized” is an explicit decision, not a failed save.

Success updates transaction feeds and the owner-private category review count without clearing unrelated
manual-entry drafts. Categorization adds no category analytics or category-summary refresh. Errors preserve the review draft
and focus the affected control. Sign-out, household switch, confirmed session expiry, or access loss clears all
private rule/review state and in-flight results.

Use semantic controls, persistent labels, live-region notices, visible focus, keyboard order, 44px targets,
phone/desktop/200%-text reflow, reduced-motion behavior, and text in addition to color. Restore focus to the
initiating control after cancel and to a stable success heading/notice after resolution.

## 8. Concurrency, idempotency, and failure behavior

- New-entry deterministic classification shares the existing household/account/refund locks and commit. It
  creates one transaction at version 0; classification does not add a second bump.
- Category PATCH changes provenance and category in the same transaction. User decisions win against rule,
  heuristic, AI, sync, and review work.
- Suggestion workers never hold a database transaction during external calls. Final persistence checks current
  membership, owner, posted/non-refund state, transaction version, assignment origin, and evidence fingerprint.
- Rule creation and review resolution have durable operation scopes and canonical fingerprints. Unknown outcomes
  offer same-key retry or refetch; the browser never invents success.
- Version overflow follows existing finance exhaustion errors. Lock contention remains bounded and returns
  `FINANCE_BUSY` with no partial commit.
- Categorization caches and sibling transaction/review views refresh only after committed changes. Category
  changes never refresh or recompute member balances or exact spending totals because those remain
  category-agnostic.
- Safe errors never echo merchant text, provider codes, model content, submitted categories, private IDs, or the
  existence of another owner's rule/review item.

New error codes are limited to `404 CATEGORY_REVIEW_NOT_FOUND`, `404 CATEGORY_RULE_NOT_FOUND`, and
`409 CATEGORY_RULE_CONFLICT`; validation, version, idempotency, authentication, membership, transaction-voided,
and busy errors reuse existing contracts.

## 9. Implemented capabilities

- V15 adds assignment provenance, normalized owner-private provider evidence, an exact
  versioned provider map and deterministic classification on new entries.
- V16 persists owner-bound exact-match rules with future-only precedence, explicit
  learning, versioning and deactivation; rules belong to the financial owner, not
  the household administrator.
- V17 persists owner-private coalesced heuristic reviews and history. Review decisions
  are versioned and never silently replace explicit ledger corrections.
- V18 persists owner-scoped AI work with retry, leases, fencing and evidence/policy
  revalidation. Its adapter is disabled by default; valid responses propose review
  candidates only, never ledger writes. Live provider quality and production erasure
  remain unverified.

See [owner-private query authorization](../../backend/src/main/java/com/housesync/finance/categorization/application/CategorizationQueryService.java)
and [fenced AI work](../../backend/src/main/java/com/housesync/finance/categorization/application/CategorizationAiWorkService.java)
for implementation details. Focused checks include
[AI work integration](../../backend/src/test/java/com/housesync/finance/categorization/CategorizationAiWorkIT.java)
and [owner-rule HTTP behavior](../../backend/src/test/java/com/housesync/finance/transaction/CategorizationRuleHttpIT.java).
These exercised paths do not establish general accessibility or production readiness.

## Behavior matrix

| Concern | Checked behavior |
| --- | --- |
| Migration/provenance | Clean and supported-prior PostgreSQL upgrades; every legacy non-refund preserved as `LEGACY`, every refund `INHERITED`; no category/version/timestamp rewrite; constraints reject incoherent origin/category/rule combinations. |
| Taxonomy/refunds | Exact 16-token response and labels unchanged; unknown tokens rejected; source correction propagates category and `INHERITED` metadata to posted/voided refunds atomically; direct refund edits rejected. |
| Precedence | Explicit category/null beats all automation; exact owner rule beats provider mapping; unknown provider evidence does not default; heuristics/AI only suggest; same-key create replay never reclassifies. |
| Provider isolation | Adapter SDK/raw payload stays isolated; merchant IDs digested; provider category-only changes do not alter the connected-finance revision, ledger, reconciliation, reporting, or another member's response. |
| Rules/privacy | Two members plus outsider; each sees only own rules/counts; household role gives no override; exact matching only; conflict/idempotency/version/deactivation/rejoin behavior; no private merchant/error/cache leakage. |
| Corrections/concurrency | User patch, rule create, suggestion completion, sync, removal, and review resolution races; user decision always wins; stale versions/evidence fail with no partial category/refund/review change. |
| Review | One open item per transaction/evidence, stable bounded paging, all four actions, same-key replay, direct-patch/void supersession, explicit null preserved, effective category distinct from suggestion. |
| AI boundary | Configuration off by default; forbidden fields absent from captured fake request; valid structured result becomes suggestion only; invalid token/shape, timeout, rate limit, auth, outage, duplicate and stale work leave ledger unchanged; no sensitive logs. |
| Reporting | Confirmed-ledger per-currency totals remain exact; private/unadmitted suggestions and rule data never enter reports; category changes never alter overall spending, allocations or balances. Category-group insights are defined separately in [financial insights](financial-insights-contract.md). |
| Web recovery | Existing exact transaction parser unchanged; separate strict owner-only categorization parser, server labels without raw-token fallback, rule opt-in after correction, preserved drafts, unknown outcome/refetch, stale conflict, CSRF/session/access cleanup, and sibling convergence without unrelated draft loss. |
| Accessibility | Browser at phone/desktop and 320px at 200% text; keyboard/focus/live-region behavior, 44px controls, non-color status, accessible names, and automated axe with zero violations/incomplete checks where available. |
| Operations | Deterministic suites require no paid/live AI; live model quality, provider coverage, public deployment and erasure remain separately unverified. |

Use [testing](../development/testing.md) for reproducible checks. Live AI quality,
provider coverage and public deployment are distinct, unverified boundaries.
