# ADR 0010 - Shared finance, flexible allocations and agreed repayments

- **Status:** Accepted and implemented; record-only repayments do not move money.
- **Scope:** Shared-finance visibility, exact allocations, external repayment records and contributions.
- **Related:** [Shared-finance contract](../architecture/shared-finance-contract.md),
  [known limits](../product/known-limits.md), [manual-finance API](../architecture/manual-finance-api.md),
  [ADR 0006](ADR-0006-manual-finance-contracts.md), [ADR 0007](ADR-0007-categories-sharing-allocations.md),
  [connected finance](../architecture/connected-finance-contract.md) and
  [categorization](../architecture/categorization-contract.md).

## Context

Manual finance already provides private accounts, explicit whole-transaction sharing, equal allocations, cumulative refund
handling, exact balances and spending reports. Connected finance adds reviewed bank imports without silently rewriting the
ledger. Categorization adds owner-private classification and review. Shared finance must mature multi-member use
rather than rebuild that baseline or expose personal banking data as a convenience.

The decision specifies visibility filters, exact refund allocation, repayment consent
and period contributions as additions to the original equal-share baseline.

## Decision

### 1. Four areas under one contract

1. **Visibility management:** owner-scoped All/Private/Shared-by-me filters and bounded paging; reuse explicit
   disclosure, refund-group propagation and allocation safeguards.
2. **Flexible allocations:** preserve equal splits, add exact unequal full-expense shares and explain
   cumulative refund impact, including payer-retained cost.
3. **Settlement coordination:** deterministic suggestions and two-party attested external repayments with
   consensual corrections, no money movement.
4. **Contribution views:** coherent period paid-versus-assigned-cost reporting and integrated multi-member
   workflows across the other three.

Each area includes backend, web, privacy/money tests and documentation. New schemas (V19 for allocation
policies, V20 for repayments) ship with the area that owns them.

### 2. Preserve selected sharing; do not invent account grants

Accounts, sibling transactions, provider facts and categorization evidence remain owner-private. Household
OWNER is not a financial override. A selected shared entry still discloses its full amount/description and
established fields to current and future members; non-owner accountId stays null. The owner can find and manage
older disclosures without an account-wide grant, automatic future sharing or private-data aggregate.

A payer's personal portion is an explicit payer participant share, not a hidden piece of the purchase. Shares
cover the entire expense. Full-account, totals-only and partial/redacted disclosure are excluded; they would
need a separate consent/projection design.

### 3. Keep equal history exact; tag unequal refund policy

Existing and new EQUAL allocations retain the original equal cumulative-refund rule byte-for-byte. Add EXACT
creation via explicit nonnegative participant amounts summing to the expense magnitude, including zero shares
and an optional payer share. No percentage/weight inputs or implicit leftovers.

Persist immutable method/refund-policy tags. Backfill every existing active/revoked allocation as EQUAL/EQUAL_V1
without changing amounts, versions, timestamps or idempotency fingerprints. EXACT uses EXACT_JEFFERSON_V1:
highest-averages cumulative refund apportionment over frozen original shares, exact rational comparison and
canonical UUID ties. Initialize floor quotas, then allocate fewer than n residual minor units with a heap;
BigInteger products avoid overflow and work does not grow with monetary magnitude.

The chosen rule conserves each currency, never exceeds a share, is monotone as cumulative refunds grow and
reverses every original share at a full refund. It can favor larger shares in intermediate rounding; the UI
must explain that tradeoff and show exact impact. Do not apply this new algorithm to legacy equal allocations.
Use one pure policy implementation for balances, active allocation impact and period contribution deltas.

Original shares remain immutable. Correct by revoke/recreate under a fresh key. Existing active-allocation
blocks on expense money/unshare, source-version concurrency and void/bank-replacement safeguards remain.
A server preview reads the full current refund group; a browser page is not a sufficient accounting source.
Revoked creation replay has null current impact rather than applying later refund facts to its old magnitude.

### 4. Record agreed external repayments, never execute payments

Sender creates an assertion of an already-completed external payment; recipient confirms or rejects; sender
can cancel pending assertions. Both must currently belong to the household for a positive confirmation.
Neither an administrator nor the sender can self-confirm receipt. Facts remain separate from transactions,
accounts and allocations, with no source FK, bank attachment or free-text evidence.

Confirmed payment amount P from sender S to recipient T adds +P to S's positive-is-owed balance and -P to T's.
It changes neither spending nor split cost. Keep payments when later expense refunds/revocations change debt;
actual overpayments can legitimately reverse who owes whom. Do not clamp, infer, automatically match transfers
or silently erase money already asserted and agreed.

Corrections require a proposed full replacement or void and the other party's confirmation. Original effect
remains until the other party confirms; immutable events retain all transitions. A real return transfer is a new opposite
payment, not voiding a valid original. Same-key creation, one parent version and household-first locking
prevent retry/race double effects. No accepted-money edit without the second party.

Details, pending assertions and event history are party-only. Agreed repayments deliberately affect
household-visible net balances and suggestions; consent copy must explain that aggregate disclosure.
Contribution views must not widen it to per-member payment totals/history. Departure removes access, not
recorded facts or obligations. Outstanding positive consent requires the same counterpart to rejoin; remaining
parties may safely reject/cancel pending proposals, and no owner takeover is allowed.

### 5. Suggestions are an advisory current-member plan

Compute a deterministic per-currency greedy plan from the authoritative combined balances, ordering current
debtors/creditors by UUID. Do not promise minimal transfer count or preserve original debtor/creditor pairs.
No suggestion reserves debt or records payment. Keep departed balances explicit through residual totals rather
than discarding them or proposing an action an absent person cannot confirm.

Bound response pages with a snapshot cursor; recompute authorization and the complete balance projection on
every request. A stale projection restarts the plan. Fingerprints are freshness guards, not authority. No new
suggestion worker, persisted balances, provider API or AI arithmetic.

### 6. Explain period contributions without private repayment inference

Use current shared POSTED expense/refund facts. Net paid is expense magnitude minus refunds on their own dates.
Allocated period cost is original share for an in-period expense minus the difference between cumulative
refund shares at the period endpoints. A refund-only period can be negative. Unallocated shared cost stays an
explicit unallocated bucket, not an inferred debt owed to the payer.

Per currency, total net paid equals net spending, and assigned cost plus unallocated net equals net spending.
The new required-currency response carries totals and paged member rows from one coherent snapshot; continuation
requires the same projection fingerprint. Do not combine independently fetched rows and totals as if atomic.
Current-state corrections/revocations restate prior periods; this is not an as-of audit ledger.

Show existing all-time net balances separately. Do not expose party repayment history, sent/received period
totals, net-cash-after-payments, private account aggregates, AI status or source evidence in contribution views.
No cross-currency sum. Departed labels reflect current membership, with stable UUIDs and no email/profile leak.

## Alternatives rejected and consequences

- **Design only visibility management first:** leaves money, repayment consent and cross-area reporting
  decisions to be guessed during implementation. The full contract fixes all four before code.
- **Client filter over the first 100 rows:** misses old disclosed entries. SQL filtering and explicit paging
  are required; finite transaction/history bounds must be honest, not marketed as complete export.
- **Largest remainders independently per refund total:** can make a participant's cumulative refund decrease.
  Per-refund rounding also drifts. Tagged cumulative policies avoid both; highest-averages rounding bias is explicit.
- **Explicit manual allocation of every refund:** adds decisions and changes both manual and bank-confirmation
  workflows for routine refunds. The chosen cumulative rule preserves those APIs; item-specific refund allocation
  is not claimed.
- **Unilateral or administrator repayment approval:** permits financial changes without the counterpart's
  agreement. Two-party consent costs an extra step and means departed counterpart consent waits for rejoin.
- **Treat a bank transfer or suggestion as settlement:** risks duplicate accounting and implies verified money
  movement. Explicit records and consent remain separate from both.
- **Erase a payment when its expense is unshared or refunded:** falsifies external-money history. Preserve it
  and explain resulting reverse credit; no source reference can leak the now-private expense.
- **Expose repayments through household contribution totals:** widens party privacy without agreement. Only
  already-shared spending/allocation facts feed contributions; net obligations are an explicitly separate disclosure.
- **Historical as-of reporting / stored balances:** unnecessary new state. Current-state
  reconstruction is labeled; the event history is limited to repayment consent/correction facts.

Allocations and repayments require separate forward migrations and coordinated strict backend/web DTO cutovers.
Once exact allocations or repayments exist, older binaries cannot safely interpret the financial state; use a
forward fix or a tested recovery rather than promising binary-only rollback. Production erasure is out of scope.

## Authority

The [full contract](../architecture/shared-finance-contract.md) owns exact APIs,
calculations, state transitions, privacy matrix and migration implications.
ADRs 0006–0009 remain authoritative for unchanged behavior. ADR 0007's
equal-only/no-settlement language describes the earlier baseline; exact shares
and record-only repayments are implemented extensions. Live bank-initiated
correction, paid AI quality, erasure and public deployment remain separate claims.
