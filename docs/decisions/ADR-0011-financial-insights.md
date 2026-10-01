# ADR 0011 - Explainable household financial insights

- **Status:** Accepted and implemented.
- **Scope:** Financial insights: spending comparisons/trends, recurring bills/subscriptions,
  explicit monthly budgets and deterministic household summaries.
- **Related:** [Financial-insights contract](../architecture/financial-insights-contract.md),
  [known limits](../product/known-limits.md),
  [manual finance](../architecture/manual-finance-api.md),
  [shared finance](../architecture/shared-finance-contract.md),
  [categorization](../architecture/categorization-contract.md).

## Context

Manual finance supplies exact household spending and reporting settings. Connected finance admits bank facts to
the ledger only after owner review. Categorization's provider merchant evidence, rules and review queues are
private. Shared finance supplies selected sharing, exact allocations, party-only repayment history, net balances
and current-state period contributions. Insights must explain what changed and why without creating a second
ledger or widening these privacy boundaries.

The public ledger has descriptions and effective categories, not a household-visible verified merchant identity.
An analytics feature cannot join private provider evidence merely because that makes grouping easier.
Nor can a saved recurring suggestion become a permanent copy of a subsequently unshared transaction.

## Decision

### 1. Define all four areas together

- **Comparisons and trends:** monthly totals, category and conservative description-based merchant
  groups, exact changes and authorized drill-down.
- **Recurring spending:** deterministic evidence-backed candidates, review and user-managed household bill /
  subscription plans with explicit disclosure, lifecycle and live evidence separation.
- **Monthly budgets:** optional overall and category targets, exact progress and owner-managed corrections.
- **Explainable summaries:** one coherent summary with actionable evidence links into the other three.

The [contract](../architecture/financial-insights-contract.md) records exact rules,
privacy limits and reproducible behavior checks.

### 2. One disclosed reporting population and one money convention

All Insights household actuals derive from current HOUSEHOLD POSTED ledger facts, never private accounts, unadmitted
provider observations, categorization evidence or repayment history. Expenses contribute positive magnitudes, refunds
negative spending on their own dates, and transfers contribute no spending. Income is separately labeled.
Current categories and source-expense merchant groups attribute refunds without moving their reporting dates.
Archived accounts and departed owners do not erase disclosed facts. Current corrections/unsharing restate old
periods; neither these reports nor their freshness fingerprints are historical as-of records.

Use existing seven currencies and exact decimal strings; never add currencies together. Net spending is not
cash flow, an account balance, assigned cost or debt. Shared-finance balances/contributions keep their separate meaning.
Percentages are backend-derived, explicitly rounded presentation values; all underlying money stays exact.
A zero/nonpositive comparison denominator yields an explained absent percentage, not infinity or an invented
rate. Negative refund-heavy net spending remains negative.

### 3. Calendar reporting and conservative merchant identity

Insights uses explicit calendar months and a bounded monthly series; the household IANA zone determines today and
default selections only. Existing occurredOn dates are not converted to timestamps. Full-month totals include
future-dated posted facts when selected; an in-progress/future month and incomplete bank coverage are labeled.
No extrapolated end-of-month spend or normalized-per-day comparison is implied.

Reuse the existing NFKC, locale-independent lowercase and Unicode-whitespace text normalization semantics;
preserve punctuation and digits. Merchant groups are exact normalized public descriptions, not inferred
business entities. Invalid normalized keys remain an explicit ungrouped bucket rather than disappearing.
No fuzzy merges, private merchant ID joins, external enrichment or cross-household learning.

### 4. Evidence is revocable; explicit household plans are separate intent

Recurring candidates are suggestions computed from currently authorized expenses with deterministic calendar
rules. The detector does not assert a contract exists or that a bill was paid. Evidence, amounts and derived
labels must be recomputed and reauthorized after correction/unshare/void; never serve a persisted evidence
snapshot as current disclosure.

A household bill/subscription plan is independently user-authored, explicitly shared planning information,
not a new ledger entry or an automatic copy of private banking data. Its disclosure and retention are explained
before creation. A matching ledger observation is not bank verification, payment execution or settlement.
No plan changes a transaction, category, allocation, balance or budget target. No scheduled charge/import,
notification worker or external provider is required.

### 5. Budgets are explicit monthly household intent

Use one active target per household/month/currency/bucket, where the bucket is overall or one existing category
(including an explicit uncategorized bucket). All current members may read; only current household owners may
create/change/archive targets, reusing reporting-settings authority rather than granting ledger privileges.
Zero is a valid intentional target; missing means no target, not zero. Overall and category targets overlap
and are never summed or automatically balanced against each other.

Targets bind to an explicit month, not a recurring template. Copy-forward is a reviewed new creation; no
rollover, automatic future targets, prorating, per-person obligations or forecast. Progress is signed net
spending against the target; refunds can make remaining headroom exceed the target. Editing an older target
restates current progress and is not presented as the target originally agreed at month end.

### 6. Deterministic explanations, not causal or AI claims

Summaries identify exact spending/refund deltas, largest category/merchant contributors, budget status and
current recurring-plan information from one authorized snapshot. Category and merchant breakdowns are
alternative explanations of the same money, not additive causes. Templates explain numerical contributions;
they do not infer household intent, inflation, fraud, affordability or bank-history completeness.
No paid AI, model prompt, new secret, queue, cache or stored aggregate is justified.

### 7. Reuse lifecycle, snapshot and recovery guarantees

Authorize current membership inside the finance transaction, serialize with membership changes, and scope SQL
before aggregation/paging. User-authored resources use strict bodies, durable creation keys, optimistic versions,
restrictive household/stable-user references and forward migrations (V21 plans, V22 budgets). Fingerprints
and cursors grant no access and contain no private-derived material. Every continuation reauthorizes and rejects
changed projections rather than mixing old rows with new totals.

Ship no speculative future tables or automatic backfills of budgets/bills. Existing endpoints keep their schemas
and policy tags; new clients and new endpoints cut over together, with no compatibility aliases.

## Alternatives and consequences

- **Private data added to household totals:** easier coverage, unacceptable disclosure. Household analytics may
  be incomplete by design; say so rather than silently widening the population.
- **Provider IDs / fuzzy merchant merging:** more attractive grouping, but crosses privacy or misidentifies
  merchants. Exact public text is explainable, at the cost of separate groups for differently labeled charges.
- **Recurrence equals payment or subscription certainty:** creates false financial facts. Deterministic suggestions
  plus explicit planning intent preserve uncertainty and permit correction.
- **Saved inferred evidence as a permanent shared record:** defeats unsharing. Only independent disclosed plan
  fields persist for household reads; derived evidence is always current and revocable.
- **Recurring budget templates / automatic rollover:** introduce historical and future-target ambiguity. Explicit
  month targets are useful without silently creating household commitments.
- **Clamp negative spending / average currencies / divide by zero:** makes charts easier but distorts financial
  meaning. Exact signed values and explicit absent ratios take precedence over presentation convenience.
- **AI-generated explanations:** unnecessary for deterministic numerical changes; would add privacy, cost and
  quality risk. Optional categorization AI remains separate and disabled by default.
- **Materialized reports / workers:** add invalidation and disclosure-retention risk before query evidence warrants
  them. Bounded derived reads are the starting point.

## Authority

The [full contract](../architecture/financial-insights-contract.md) owns endpoints,
schemas, equations, lifecycle, migration and browser behavior. Existing finance
contracts remain authoritative for unchanged behavior. Live bank-change
verification, AI quality, production erasure/security/hosting and Android
remain separate claims.
