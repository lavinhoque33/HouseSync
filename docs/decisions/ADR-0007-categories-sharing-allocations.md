# ADR 0007 - Categories, selected sharing, and basic allocations

- **Status:** Accepted and implemented; equal allocations are retained alongside later exact allocations.
- **Scope:** Categories and selected transaction sharing, then basic allocations and member balances: the
  initial taxonomy, allocation API and concurrency, refund/balance mathematics, mutation interactions,
  errors, browser behavior, and persistence sequencing.
- **Related:** [Manual-finance API contract](../architecture/manual-finance-api.md),
  [manual-finance decision](ADR-0006-manual-finance-contracts.md),
  [household lifecycle](ADR-0005-household-membership-lifecycle.md),
  [shared-finance extension](ADR-0010-shared-finance.md) and
  [testing](../development/testing.md).

This ADR records the original equal allocation policy. [ADR 0010](ADR-0010-shared-finance.md)
and the [shared-finance contract](../architecture/shared-finance-contract.md) add tagged
EXACT allocations and external repayment effects without rewriting historical equal results.
Equal-only/no-settlement statements below describe the earlier decision boundary, not the
current full feature set.

## Context

[ADR 0006](ADR-0006-manual-finance-contracts.md) established exact money, private
accounts, linked refunds, selected disclosure and durable retries while deferring
split/refund-group economics. This decision specifies categories/disclosure first
and equal allocations/balances next. Household reporting settings and exact summaries are a separate,
later part of manual finance and outside this decision.

## Decision

### 1. Naming

"Allocation" is the API name; "split" remains informal product vocabulary. No route
becomes allowed just because this document names it.

### 2. Server-owned flat category taxonomy

- Categories are a **stable, server-owned, flat taxonomy** of 16 tokens:
  `HOUSING`, `GROCERIES`, `DINING`, `UTILITIES`, `TRANSPORTATION`, `SHOPPING`, `ENTERTAINMENT`,
  `HEALTHCARE`, `TRAVEL`, `EDUCATION`, `PERSONAL`, `HOUSEHOLD_SUPPLIES`, `SUBSCRIPTIONS`, `INCOME`,
  `TRANSFERS`, `MISCELLANEOUS`. The token list is closed; only the server defines it.
- Human-readable labels (for example `Housing`, `Household Supplies`) are **returned by the server**;
  clients must not derive, translate, or invent labels. Tokens are case-sensitive.
- There is no customization, hierarchy, household-specific category, or automatic/AI classification in this
  decision; [ADR 0009](ADR-0009-deterministic-categorization.md) later adds provenance, rules and suggestions.
- A transaction's `category` is **nullable**: null means uncategorized. Omission on creation means null;
  explicit null is specifically permitted to set or clear uncategorized. The API contract is the single
  exception to its own "explicit null is invalid" default for this field.
- Category is a **descriptive field, distinct from `kind` and `visibility`**. Any kind may carry any
  category token; neither a category named `TRANSFERS` nor `PERSONAL` substitutes for kind or visibility.
- `GET /api/households/{householdId}/transaction-categories` returns the fixed taxonomy to current members;
  it is a bounded fixed list, not a paginated collection.

### 3. Category and refund groups

- A refund's category **inherits its source expense**. Omitted on creation means inherit; an explicit
  token must equal the source's current category; an explicit value that differs fails validation, and an
  explicit null is a mismatch unless the source is itself uncategorized. Refunds never carry an
  independently chosen category.
- A **direct refund category patch is rejected**, mirroring the refund visibility rule.
- Patching the source expense's category **propagates atomically to every linked refund, including
  retained voided refunds**, in one transaction under the group lock; each refund whose category changed
  bumps its version and `updatedAt` exactly like a group visibility update. The expense patch itself bumps
  the expense version.
- A **direct category change on a voided entry is rejected** (`TRANSACTION_VOIDED`). Server-side
  propagation to retained voided refunds is not a direct edit and is required for group consistency.
  The existing visibility-only behavior on voided non-refund entries is unchanged.
- Category is part of the **transaction-create idempotency fingerprint**. For non-refunds, omission and
  explicit null normalize to uncategorized; for refunds the fingerprint records the inherit instruction
  rather than the source's mutable value, mirroring refund visibility.
- Category changes never affect allocations or derived balances; only money and visibility do.

### 4. Selected sharing is unchanged

Categories ship alongside the ADR-0006/manual-finance sharing rules with no revision: private by
default; SQL-scoped household feed; non-owner `accountId` redaction to null; financial-owner-only mutation;
joined-later and departed-owner history; whole-refund-group visibility; the source-expense version as the
refund-group concurrency token; safe revocation; and the exact-disclosure preview. Visibility still never
creates debt; allocations are the only debt source.

### 5. Allocation eligibility and participants

- Allocations apply only to a **`POSTED` `HOUSEHOLD` `EXPENSE` created by the acting financial owner**;
  the actor must currently be a household member, checked under the household lifecycle lock. Income,
  transfers, refunds, private entries, and other members' entries are never eligible.
- Exactly **one active allocation per expense** at a time. An allocation covers **100% of the expense's
  positive magnitude** — never a partial percentage — divided equally across a **nonempty explicit subset
  of current household users**. The payer (the expense owner) may be included or omitted. Duplicate,
  unknown, or non-member participant IDs are validation errors; the roster bounds the set.
- Participants are **sorted ascending by canonical user UUID** (lowercase hyphenated string order),
  **frozen into the allocation at creation**, and may later depart; their shares and obligations survive
  departure. Remainder minor units after equal division go to participants in ascending UUID order:
  USD 10.00 across three participants is 3.34, 3.33, 3.33.
- The participant set is **immutable**: changing it means revoke, then recreate with a fresh key.
- Sharing (`HOUSEHOLD` visibility) alone never creates debt; only an active allocation does.

### 6. Allocation API and concurrency

- Singular nested routes on the expense:
  - `POST /api/households/{householdId}/transactions/{transactionId}/allocation` creates; required
    `Idempotency-Key` header; body exactly `expectedVersion` plus `participantUserIds`.
  - `GET` the same path returns the active allocation.
  - `PATCH` the same path with `expectedVersion` and `status: "REVOKED"` revokes.
- Creation idempotency is durable and scoped `(actor user UUID, household UUID, ALLOCATION_CREATE, key)`;
  the fingerprint covers transaction ID, `expectedVersion`, and the sorted participant set. First commit
  returns 201; same-key replay returns 200 with the **current** authorized representation (possibly now
  revoked) after reauthorization, without reapplying create preconditions. A different payload under the
  same key is `IDEMPOTENCY_CONFLICT`; recreation after revoke needs a **fresh key**.
- The **expense transaction version is the concurrency token**: create and revoke each require the caller's
  `expectedVersion` to equal it and **bump it** once on success, so stale expense forms, stale revoke
  calls, and concurrent allocation changes conflict with `RESOURCE_VERSION_CONFLICT`. PATCH is
  version-guarded and carries no idempotency key.
- The allocation response exposes exactly: allocation ID, expense transaction ID, household ID, payer user
  ID, currency, the positive original magnitude as a money object, the **ordered participant shares**
  (ascending UUID, exact currency-scale strings summing to the magnitude), `status` (`ACTIVE`/`REVOKED`),
  `createdAt`, `revokedAt`, and the current expense `transactionVersion` as an informational snapshot —
  mutations must always read the expense's live version.
- When the magnitude has fewer minor units than participants, canonical-earliest participants receive the
  available units and later participants have an exact zero share. Zero shares remain frozen allocation history,
  participate in full-refund conservation, and do not create zero-valued member-balance rows.
- **All current members may read the active allocation** of an expense they are authorized to see
  (household-visible, or their own); **only the financial owner mutates**. Non-owners never receive
  account metadata; the allocation response contains no account fields.
- **Revoked allocations are never returned**: `GET`/`PATCH` without an active allocation answer
  `ALLOCATION_NOT_FOUND`. Revocation history is retained server-side only; after a later visibility
  revocation nothing about the old allocation leaks through any route.

### 7. Refund and balance mathematics

- **Persist the original participant shares** on the allocation as immutable exact minor units. Never
  derive shares from the current roster, and never persist independently rounded per-refund shares.
- Let `M` be the expense magnitude and `R` the cumulative magnitude of its **current `POSTED` refunds**.
  Refund shares are computed by applying the **same equal-division/ascending-UUID-remainder algorithm to
  `R` across the frozen ordered participants**. This is monotonic — each participant's cumulative refund
  share never decreases as refunds grow — and at a full refund (`R = M`) it **exactly reverses the
  original shares**.
- Participant remaining obligation = original share − cumulative refund share, never negative.
  Payer credit = `M − R`. Per currency, obligations sum to `M − R`, so payer credit minus total
  obligations is exactly zero. Refund create/correct/void changes only `R`, so derived balances stay
  exact without new persisted state.

| State (USD 10.00, participants A/B/C ascending) | R | Refund shares A/B/C | Obligations A/B/C | Payer credit |
| --- | --- | --- | --- | --- |
| Allocated, no refund | 0.00 | — | 3.34 / 3.33 / 3.33 | 10.00 |
| Refund 1.00 posted | 1.00 | 0.34 / 0.33 / 0.33 | 3.00 / 3.00 / 3.00 | 9.00 |
| Second refund 2.00 posted (R = 3.00) | 3.00 | 1.00 / 1.00 / 1.00 | 2.34 / 2.33 / 2.33 | 7.00 |
| Full refund 10.00 (R = 10.00) | 10.00 | 3.34 / 3.33 / 3.33 | 0.00 / 0.00 / 0.00 | 0.00 |

- Balances are **derived obligations per currency** from a coherent authorized snapshot: positive means
  "is owed", negative means "owes". There is no FX conversion, grand total, or settlement in this decision.

### 8. Mutation interactions and lifecycle serialization

While an allocation is active:

- Expense **money correction is blocked** and **`HOUSEHOLD` → `PRIVATE` visibility revocation is blocked**,
  each with `409 ALLOCATION_CONFLICT`.
- Expense **description, `occurredOn`, and category may change** provided the existing transaction/refund
  constraints pass (refund date ordering, group propagation, voided-entry rules). These changes do not
  affect shares or balances.
- **Revoke the allocation explicitly before** privacy revocation or amount correction.
- **Voiding the expense** — permitted only after its live refunds are voided under the existing rule —
  **atomically deactivates the allocation** (`REVOKED` with `revokedAt`) in the same transaction as the
  void. Voided expenses contribute nothing.
- Refund **create/correct/void remain allowed** and change derived balances under the existing group
  locks and expense-version bump. No refund-level share rows exist to migrate or correct.
- Deterministic lock order: household lifecycle lock, then the expense's account lock, then the source
  expense row, then linked refund UUIDs ascending, then allocation rows. Membership removal takes the
  lifecycle lock first, so no finance mutation commits after removal. Member-balance reads use the
  lifecycle lock and one consistent authorized snapshot.

### 9. Member balances API

- `GET /api/households/{householdId}/member-balances` — every current member may read it.
- Response is grouped **by currency** (ordered by code), each currency holding balances **ordered by
  ascending user UUID** with exact currency-scale amount strings, `CURRENT`/`DEPARTED` membership state,
  and **no email or profile leakage**.
- Every user with a nonzero derived obligation appears, including departed payers and departed
  participants; zero balances are omitted, as are currencies with no nonzero balances; per-currency sums
  are exactly zero. Private, unallocated, voided, and revoked-allocation entries contribute nothing.
- No foreign exchange, grand total, or settlement suggestion exists in this decision.

### 10. Errors and transport

Add `404 ALLOCATION_NOT_FOUND` (authorized expense without an active allocation) and
`409 ALLOCATION_CONFLICT` (allocation eligibility or a mutation blocked by an active allocation) to the
existing safe-error family. All transport conventions are preserved: no-store, strict request/response
shapes, CSRF on unsafe methods, membership-before-resource resolution, privacy precedence in error
disclosure, and bounded-lock `FINANCE_BUSY`.

### 11. Browser behavior

- Category selection on create and correction with server-returned labels and an explicit
  uncategorized/null option; category propagation previews for refund groups.
- Own and household feeds with disclosure and revocation previews of the exact visible fields, including
  whole-refund-group effects for both visibility and category.
- Allocation creation with roster-based participant selection, payer shown, and an **exact share preview**
  computed with checked minor-unit arithmetic using the same documented remainder rule; revoke action;
  recreate-after-revoke guidance.
- Balance views labeled per currency with "is owed"/"owes" wording and `CURRENT`/`DEPARTED` labels, never
  color alone; refresh after every relevant mutation.
- Recovery for idempotency, version conflicts, CSRF, and timeout/`FINANCE_BUSY` follows the established
  transaction patterns; accessibility, focus, touch targets, and reflow standards are unchanged.

### 12. Persistence sequence

- Categories and sharing ship in one forward migration (transaction category column plus taxonomy
  constraint and the `HOUSEHOLD` visibility widening); allocations ship in a separate, later forward
  migration (allocation and allocation-participant tables plus their idempotency table). There is **no
  combined schema migration**. Existing migrations and data are preserved.
- Allocation rows reference transactions, households, and **stable users with restrictive foreign keys —
  never membership rows** — so departure preserves history and revokes access only.

## Alternatives and tradeoffs

- Persisting per-refund rounded shares would avoid recomputation but creates drift between refunds and
  expenses after corrections; deriving refund shares from cumulative refunded magnitude keeps one rule,
  guarantees monotonic nonnegative obligations, and exactly reverses original shares at full refund.
- Roster-derived dynamic shares would auto-adjust on joins but rewrite history and leak roster changes
  into recorded obligations; frozen participants plus explicit recreation preserve recorded history.
- Embedding allocation data in transaction DTOs would save a request but couples redaction rules and
  versioning; the singular nested resource keeps the expense version as the single concurrency token.
- Mandatory payer inclusion would simplify sums, but omitting the payer legitimately models household
  expenses nobody personally owes shares of; the credit formula already covers both.
- Exposing revoked-allocation history would aid audits but risks leaks after visibility revocation;
  retention without any read route is the minimal safe behavior.

## Verification

The [manual-finance API behavior matrix](../architecture/manual-finance-api.md#behavior-matrix)
records executable examples and behavioral checks for this decision. See the
[shared-finance contract](../architecture/shared-finance-contract.md) for the later exact-allocation extension.
