# ADR 0009 - Deterministic categorization, corrections, and review

- **Status:** Accepted and implemented. Optional AI suggestion provider remains disabled by default.
- **Scope:** Smart categorization: assignment provenance, deterministic precedence, private merchant rules,
  provider-category normalization, suggestion review, and the AI boundary.
- **Related:** [Categorization contract](../architecture/categorization-contract.md),
  [categories and allocations](ADR-0007-categories-sharing-allocations.md),
  [connected finance](ADR-0008-connected-finance.md),
  [manual-finance API](../architecture/manual-finance-api.md),
  [connected-finance contract](../architecture/connected-finance-contract.md)
  and [known limits](../product/known-limits.md).

## Context

Manual finance established a closed, server-owned taxonomy of 16 category tokens. A category is nullable, descriptive,
independent of transaction kind and visibility, and inherited by every refund from its source expense. Connected
finance admits provider observations only after owner review and never lets later synchronization silently rewrite
confirmed ledger money, descriptions, categories, sharing, or allocations.

Before this decision, the ledger stored only the effective category. It could not explain whether a value
came from a user, automation, or inheritance; preserve an explicit uncategorized decision; represent a reusable
merchant rule; or surface a suggestion without changing the ledger. The Plaid adapter carried exact
money/date facts and a safe description/merchant fallback, but no application-owned category or stable merchant
evidence.

Categorization must make ordinary transactions easier to categorize without weakening the established rules:

- explicit user decisions survive synchronization and later classification;
- private transactions, merchant evidence, rules, and review counts stay private to the financial owner;
- category automation never changes money, transaction kind, visibility, allocations, balances, or provider
  reconciliation state;
- deterministic knowledge is used before AI; and
- uncertainty is visible and recoverable rather than hidden behind a guessed category.

## Decision

### 1. Keep the existing taxonomy and ledger meaning

Categorization keeps the exact 16-token taxonomy, server-returned labels, nullable `financial_transactions.category`, and all
ADR 0007 refund-group rules. It adds assignment metadata and review resources; it does not create customizable
categories or reinterpret category tokens as transaction kind, visibility, arithmetic, or authorization.

`financial_transactions.category` remains the effective category consumed by transaction feeds. Existing exact
spending totals remain category-agnostic; categorization does not add category analytics or a second value that could change
report inclusion. Provenance explains the displayed category; it does not compete with it.

### 2. Persist the effective assignment and its provenance

Every transaction gains current categorization metadata with one assignment origin:

| Origin | Meaning |
| --- | --- |
| `NONE` | No effective category and no explicit user decision. Automation may evaluate the transaction. |
| `LEGACY` | A category or null that predates provenance and whose intent cannot be reconstructed. Automation cannot overwrite it. |
| `USER` | The owner explicitly selected a category or explicitly kept it uncategorized. Automation cannot overwrite it. |
| `OWNER_RULE` | An exact active rule owned by this financial owner assigned the category. |
| `PROVIDER` | A versioned application mapping from normalized provider category evidence assigned the category. |
| `INHERITED` | A refund follows its source expense; it is never classified independently. |

Current metadata records the assignment time and the applicable rule or mapping version. The existing exact
transaction response remains unchanged: another member reading a shared transaction receives only its effective
category, never classification metadata. A separate owner-only categorization resource exposes safe provenance;
raw provider codes, merchant identifiers, model payloads, rule keys, and private explanations stay server-side.

All pre-existing non-refund rows, including rows whose category is null, are backfilled as `LEGACY`. The migration
cannot know whether a historical value was chosen, defaulted, or intentionally cleared, so it must preserve the value without
falsely attributing a user decision. Existing refunds are backfilled as `INHERITED`. Migrations do not rewrite
any existing category.

For new non-refund creation or connected-ledger admission:

- an explicit category token records `USER`;
- omitted and explicit-null category retain their existing idempotency equivalence and are eligible for the
  deterministic classifier;
- no match records `NONE`; and
- a later category PATCH, including explicit null, records `USER` and closes any open categorization suggestion.

Refund omission continues to mean inheritance, and a direct refund category patch remains invalid. When the
source expense changes, its effective category still propagates atomically to every refund; refund metadata stays
`INHERITED` and carries no independent rule or suggestion.

### 3. Use a strict precedence order

For an eligible new posted non-refund ledger entry, classification uses this order:

1. explicit user category instruction;
2. exact active owner rule;
3. versioned provider-category mapping;
4. deterministic heuristic suggestion;
5. AI suggestion; then
6. uncategorized.

Only owner rules and reviewed provider mappings auto-apply. Heuristics and AI produce suggestions for review;
they do not change the effective category. An accepted suggestion becomes a `USER` decision while retaining the
suggestion source in review history.

Classification is not fuzzy reconciliation. It never matches transactions, creates refunds, changes kind, or
infers sharing. It runs against confirmed ledger entries, not pending or unadmitted bank observations.

Automation does not reclassify an existing effective assignment merely because rules, mappings, descriptions,
or provider metadata later change. Provider synchronization and `APPLY_BANK` therefore continue to preserve the
confirmed ledger category exactly as connected finance requires. A new evidence version may open or refresh an owner-private
categorization suggestion, but it cannot mutate the ledger.

### 4. Make learned rules explicit and owner-private

A correction does not silently teach the system. After choosing a category, the owner may explicitly create an
exact rule from that transaction for future matches. The server derives the match key from authorized stored
evidence; clients cannot submit an arbitrary merchant key or another owner's private description.

Rules are scoped to `(household, financial owner)`, not to every member of the household. This is the narrowest
scope that permits the same person to reuse knowledge within a household without revealing one member's private
merchant activity to another. Cross-member rules or rule sharing would require a separate privacy decision.

Connected entries prefer a provider-stable merchant identity when the adapter supplies one. Otherwise, and for
manual entries, a deliberately conservative normalized merchant/description key may be used. Matching is exact:
no edit distance, substring, token removal, amount/date pattern, or probabilistic duplicate logic. Provider IDs
remain application-internal and are stored only in scoped digested form.

Rule creation is explicit and idempotent. Rules are versioned and can be deactivated; they are not hard-deleted
while assignments still reference them. A rule affects only future eligible entries. Retroactive bulk rewriting
is out of scope.

### 5. Keep provider mapping application-owned

The provider adapter may be widened with bounded, nullable application-owned merchant and category evidence. SDK
types and raw payloads remain inside the provider implementation. A static reviewed mapping translates supported
provider category codes to the 16 HouseSync tokens and carries an application ruleset version. Unknown, malformed,
or newly introduced provider codes produce no assignment.

Provider category and merchant metadata are categorization evidence, not material transaction facts. They do
not enter the money/date provider revision, reopen a bank-reconciliation decision, or authorize ledger admission.
They have a separate evidence fingerprint for categorization review and stale-work rejection.

### 6. Separate suggestions from assignments

At most one open categorization review item exists for a transaction. A review item is owner-private and records:

- the transaction and transaction version it evaluated;
- suggested category;
- source (`HEURISTIC` or `AI`);
- a bounded confidence band, safe reason code, evidence fingerprint, and ruleset/model policy version; and
- open/resolved state and its own version.

The owner may accept the suggestion, choose another category, keep the current category, or explicitly keep the
transaction uncategorized. Resolution checks both review and transaction versions and commits the user decision
atomically. A direct category PATCH also supersedes any open review. Changed evidence may supersede an existing
open item before the owner decides, but stale or later work cannot reopen or overwrite a resolved `USER`
decision.

Review lists, counts, errors, caches, and notifications are scoped to the financial owner. Household roles confer
no access. Other members may continue to see the effective category of a transaction explicitly shared with
them, but never its rule, suggestion, confidence, provider evidence, or review state.

### 7. Keep AI last, optional, and suggestion-only

The AI integration is behind an application-owned adapter and is disabled by default. It runs outside ledger
transactions after deterministic classification cannot assign a category. Core tests use a deterministic fake;
live paid calls are never required.

The request contains only the minimum authorized evidence needed for categorization: a bounded normalized
merchant/description, transaction kind, and normalized provider category when present. It excludes money,
currency, dates, account/institution identifiers, household/user identifiers, connection data, raw provider
payloads, allocation data, and shared-member data.

The adapter must validate a structured allowlisted category, confidence band, bounded reason code, and exact
configured model/policy identity. Invalid, unknown, timed-out, rate-limited, or unavailable results leave the
ledger unchanged. V17 reviews retain the validated result and a bounded digest of the configured model plus
policy, not raw model output; V18 work retains version/evidence/policy identity but never prompts, responses,
financial descriptions, or credentials. AI never performs money math, authorization, transaction
reconciliation, visibility decisions, or automatic ledger assignment.

The implemented V18 worker claims committed work with a 30-second lease and fencing token, calls the provider
outside database transactions, and rechecks membership, transaction version, eligible origin, evidence, and
current model/policy before inserting a review. Timeouts, transport failures, HTTP 429, and 5xx receive at
most three total attempts; malformed output and authentication failures stop without a blind retry. Only the
current owner's eligible pending/failed counts appear in a no-store status resource; failures leave manual
category correction available. The backend and web default to AI disabled, so review remains useful without any
provider credentials. Public deployment awaits a project-wide retention/erasure policy and live-provider
quality evidence.

### 8. Preserve versioning and lock order

Classification during new-entry creation occurs inside the existing authorized transaction and produces no extra
post-create version bump. User category changes keep the transaction version as the concurrency token and retain
the established household/account/expense/refund/allocation lock order.

Background suggestion work captures the transaction version and categorization evidence fingerprint, then
rechecks both plus current membership and assignment origin before commit. User decisions win every race. Rule
mutations are independently versioned and use durable idempotency for creates; review resolution is both
version-guarded and idempotent because a lost response must be recoverable without applying a second decision.
No network call occurs while holding ledger locks.

### 9. Build in coherent increments

1. **Provenance and deterministic provider mapping (V15):** additive persistence/backfill; normalized provider
   category/merchant evidence; versioned mapping; classification of new eligible entries; a separate owner-only
   provenance resource; correction/refund/reconciliation preservation.
2. **Explicit owner rules (V16):** owner-private exact rules derived from an authorized transaction; future-only
   application; versioning, idempotency, deactivation, and rule management UI.
3. **Deterministic suggestions and categorization review (V17):** conservative heuristics, an owner-private bounded
   review queue/count, atomic resolution, draft/conflict recovery, Home/Transactions entry points, and accessible
   explanation of effective versus suggested category.
4. **Optional AI-assisted fallback (V18):** disabled-by-default adapter, minimum-data
   policy, structured validation, leased/fenced suggestion-only work,
   deterministic fake coverage, owner-scoped status and manual fallback.

The AI adapter does not change deterministic precedence, user authority or
confirmed ledger facts.

## Alternatives and tradeoffs

- **Treat every correction as a learned household rule:** faster apparent learning, but it leaks private merchant
  behavior and can amplify one mistaken correction. Explicit owner-private opt-in is safer and explainable.
- **Automatically reclassify existing rows:** produces immediate coverage, but historical null intent and prior
  corrections cannot be reconstructed. Conservative backfill preserves user control.
- **Let high-confidence AI auto-apply:** reduces review volume, but a model score is not a correctness guarantee.
  Suggestion-only AI keeps deterministic assignments and user review authoritative.
- **Use fuzzy description matching:** improves match rate but merges unrelated merchants and descriptions without
  a stable identity. Exact keys plus provider identity are less surprising.
- **Put provider category changes in the connected-finance revision hash:** would reopen bank reconciliation for cosmetic
  metadata and couple two review domains. A separate categorization evidence fingerprint preserves both models.
- **Create a generic event bus or queue first:** unnecessary for deterministic in-transaction classification.
  AI work uses the smallest durable mechanism justified by external latency; no platform was selected
  in advance.

## Verification

The [categorization contract behavior matrix](../architecture/categorization-contract.md#behavior-matrix)
records the checks for this decision, consistent with ADRs 0006-0008 and the category/refund/reconciliation
contracts. Optional AI work is exercised against a local fake; it is not certified for live model quality,
production retention/erasure, human screen-reader use or public deployment.
