# Financial insights contract

**Status:** implemented in the backend and web. [ADR 0011](../decisions/ADR-0011-financial-insights.md)
records the design. These are views of the authorized, disclosed ledger plus separately stored planning
intent; they do not process payments.

Insights has four parts that compose in one household view:

- **Comparisons** (§3) use three read routes over the current disclosed posted ledger only; merchant groups use
  the source expense's public description for linked refunds.
- **Recurring** (§4) adds V21 review/plan/replay tables, current-evidence/projection routes and a management
  section. Plan intent is retained explicitly; inferred evidence is never stored in a plan.
- **Budgets** (§5) adds V22 target/replay tables and scoped CRUD/progress routes. Target intent is retained
  separately from restatable shared spending.
- **Summary** (§6) is a single household-authorized read that reuses comparisons, recurring evidence/plans and
  budget projections in one database transaction. Its web card links to that evidence and to the separate
  shared-finance balance/settlement view. It adds no table, migration, provider call, payment or internal
  HTTP fan-out.

The presentation uses a concise metric-card overview, independent change-driver
lists and separate trend, comparison/evidence, budget and recurring panels.
Supporting amounts and methodology remain available in native disclosures and
exact keyboard-scrollable tables. A zero-net chart state never implies no
expenses/refunds or no separate income. A failed summary read has a visible retry
notice and can leave an independently available comparison/trend usable; access,
authentication and stale-read failures retain scope reconciliation. This is a
web presentation change, not a new reporting policy, endpoint or planning action.

## 1. Outcome and scope

A household can answer **what changed, which disclosed purchases explain it, which expenses appear recurring,
what bills/subscriptions it chooses to track, and how actual spending compares with explicit budget targets**.
These capabilities are implemented as four backend/web areas:

| Area | Capability | Observable outcome |
| --- | --- | --- |
| Comparisons | Monthly comparisons, category/merchant trends and spend-change indicators | Exact month series and comparison, ranked explainable differences, authorized transaction evidence. |
| Recurring | Recurring transaction detection, subscription and bill recognition/management | Deterministic suggestions with evidence; explicit tracked household plans, correction/archive and honest expected-date states. |
| Budgets | Budget targets and progress | Explicit monthly overall/category targets, exact signed progress, safe owner-managed lifecycle. |
| Summary | Household financial summary and integrated experience | Coherent deterministic highlights linking to the other three areas and to shared-finance views. |

The capabilities compose without turning inferred recurring evidence, plan intent or
budget targets into booked transactions or paid bills.

Implementation entry points: [spending insights](../../backend/src/main/java/com/housesync/finance/report/application/SpendingInsightsService.java),
[recurring insights](../../backend/src/main/java/com/housesync/finance/report/application/RecurringInsightsService.java)
and [single-read summary](../../backend/src/main/java/com/housesync/finance/report/application/InsightsSummaryService.java);
focused [spending policy](../../backend/src/test/java/com/housesync/finance/report/SpendingInsightsPolicyTest.java),
[budget policy](../../backend/src/test/java/com/housesync/finance/report/BudgetTargetPolicyTest.java)
and [summary service](../../backend/src/test/java/com/housesync/finance/report/application/InsightsSummaryServiceTest.java)
tests cover selected arithmetic and projection boundaries.

### Reused building blocks

- `FinanceReportService` supplies household-first authorization/locking, owner-only reporting-zone updates and
  SQL-scoped HOUSEHOLD POSTED sums with exact arbitrary-precision decimal strings.
- The existing spending summary reports expense/refund/net/income by currency; contributions report period
  paid-versus-assigned cost. These endpoints retain their schemas and currency-emission policies.
  Shared-finance changes refresh reports, including a disclosed row disappearing on refresh.
- Public ledger descriptions are bounded user text. Provider merchant identities/display labels, private
  categorization rules and review evidence are **not** a shared merchant directory.
- `RuleTextNormalizer` already defines conservative NFKC/lowercase/whitespace normalization, rejecting empty,
  control-bearing or over-200-code-point output. Reuse its pure semantics, not private rule/repository access.

Insights adds no provider write, automatic ledger admission, bank balance, cash-flow forecast, savings goal,
anomaly/fraud claim, FX, payment execution, automatic subscription cancellation, notification delivery, new AI
use, personal/account-level analytics, account-wide sharing, historical as-of reporting or erasure/export API.

## 2. Shared financial, privacy and transport rules

### Authorized facts and current-state semantics

All actual spending uses current `HOUSEHOLD` + `POSTED` ledger expenses/refunds in the requested household
and currency. Include disclosed facts of departed owners and archived accounts. Exclude private/voided entries,
unadmitted/pending bank observations, transfers, repayment records/events, allocation shares, categorization
review/rule/AI facts and account metadata. Income is a separate total in comparisons and the summary, never
spending or a budget numerator.
A category named Income or Transfers does not override the transaction's kind.

For period P=[from,to), using the existing `occurredOn` calendar date:

- `expenseTotal(P) = sum(abs(amount))` for eligible expenses dated in P.
- `refundTotal(P) = sum(amount)` for eligible refunds dated in P.
- `netSpending(P) = expenseTotal(P) - refundTotal(P)`; it may be negative.
- `incomeTotal(P)` separately sums eligible HOUSEHOLD POSTED income in P.
- A refund belongs to its source expense's **current category and description-derived merchant group**, but
  contributes on the **refund's own date**. Fetch that authorized source even if it is outside P; never use
  the refund's free-text description as a different merchant. Existing group category/visibility inheritance
  remains authoritative. No orphan/unshared-source fallback that reveals hidden data.

A category/description correction can move earlier facts between groups. Unsharing removes a group from
subsequent derived reads; voiding removes its monetary/evidence contribution. Source replacements follow the
connected-finance replacement workflow. Allocation/repayment-only changes cannot change Insights spending. No saved query result,
fingerprint, recurring evidence or budget numerator is an as-of snapshot. Label **current shared records** and
state that corrections/disclosure changes restate past periods. Already-delivered bytes cannot be recalled.

Never widen household reports with the viewer's own private entries. Role OWNER is not a financial-data override.
Read authorization applies to totals, group keys/labels, empty states, count fields, cursors, errors, evidence
and retained objects, not just transaction details. Use SQL scope before grouping/ordering/paging. Reuse the
household application's public finance-lock use case; do not reach into its repository or check membership
outside the transaction. Reauthorize each request/continuation/replay and serialize with membership/role changes.

### Money, months and ratios

- Existing currencies: BRL/USD/EUR/GBP/CAD scale 2, JPY scale 0, KWD scale 3. Every derived Insights response names its
  currency explicitly; requests require currency except plan observations, which use the plan's immutable currency.
  All money is exact plain decimal text, canonical currency scale; never JSON numbers,
  floats, inferred currency, currency conversion or an all-currency grand total. Aggregates may exceed the
  12-integral-digit per-record bound. Input targets/expected amounts retain that bound.
- Month syntax is exactly `YYYY-MM`. Reportable full months are `1900-01` through `9999-11`; `9999-12` is permitted
  **only as the exclusive series boundary**. A full December 9999 would need an unsupported year-10000 boundary;
  reject it instead of calling a truncated month complete. Existing arbitrary-date ledger and shared-finance APIs remain unchanged.
- Expand month M to `[firstDay(M),firstDay(M+1))`. A series uses inclusive `fromMonth`, exclusive `toMonth`,
  with 1-24 complete calendar buckets. Comparison selects distinct explicit `month` and `baselineMonth`;
  either chronological order is legal and visibly labeled. Each month must be reportable.
- Read `asOfDate` once from the injected server clock in the household's current IANA reporting zone. Period
  state is `FUTURE` if asOfDate < from, `IN_PROGRESS` if from <= asOfDate < to, else `COMPLETED`. Completed means
  a calendar period ended, **not** that all bank activity has synced, been reviewed or been shared.
- Defaults: current month vs preceding calendar month; last 12 months ending at selected month, clipped at
  the lower bound. If a default comparison is outside supported bounds, require valid explicit selection;
  do not fabricate a baseline. Keep full-month values, not month-to-date extrapolations. Future-dated POSTED
  facts count if selected, even in future periods. Zone changes alter defaults/today, never saved dates or targets.
- For current net C and baseline net B, `delta = C-B` exactly. `direction=INCREASE|DECREASE|UNCHANGED` by its sign.
  When B>0, `percentChange = 100*(C-B)/B`, rounded to exactly two decimal places with `HALF_UP`, decimal string.
  Otherwise return null plus `percentUnavailableReason=BASELINE_ZERO|BASELINE_NEGATIVE`; when valid, reason null.
  No absolute-denominator trick, infinity, binary rounding or claim of percentage improvement from a negative base.
- Percentage rounding is presentation only; direction/status use unrounded exact values. Canonicalize rounded
  zero to `"0.00"`. For example B=3,C=4 gives delta `"1.00"`, percent `"33.33"`; B=100,C=-20 gives `"-120.00"`%.
  B=0,C=10 has delta `"10.00"` and no percentage; B=-10,C=-5 has delta `"5.00"` and no percentage.
  HALF_UP ties round away from zero, including negative ratios (for example -25.005 -> -25.01).

### Common types and strictness

Here `H=/api/households/{householdId}`. Every field set below is exact; nullable response fields are present as
null, not omitted. IDs are canonical UUID strings unless explicitly a group key/snapshot. Existing session,
CSRF, JSON/content-type, safe error and `Cache-Control: no-store` rules apply. Reject unknown/duplicate JSON or
query keys, wrong scalar types, malformed/oversized tokens and unsupported enums. Syntax validation must not
reveal resource state. Authorize before evaluating existence, version, semantic conflict or retry-key state.

| Type | Exact fields / meaning |
| --- | --- |
| `Period` | `month,from,to,state` using rules above. |
| `Spend` | `expenseTotal,refundTotal,netSpending,expenseCount,refundCount`; counts are nonnegative canonical base-10 integer **strings** over the full authorized population, not a page. |
| `Totals` | All `Spend` fields plus `incomeTotal`. |
| `Change` | `delta,direction,percentChange,percentUnavailableReason`; net spending comparison as above. |
| `GroupComparison` | `key,label,current,baseline,change`; current/baseline are `Spend`, change is `Change`. |
| `Metadata` | `reportingTimeZone,asOfDate,currency,policyVersion,snapshot`; this shorthand means those top-level fields, not a nested object. |

Every explicit currency with no eligible facts yields exact zero amounts and count strings `"0"`; no synthetic
transactions, merchants or recurring evidence. Income-only/transfer-only months have zero spending. The old
spending-summary's empty currency-array behavior does not change.

For new derived paged reads, `limit` is decimal integer 1-100 (default 50); optional `cursor` is opaque base64url,
max 2048 characters, strict version/type validation, bound to endpoint + household + normalized filters + policy
+ complete projection snapshot + next row index. No offset parameter and no arbitrary 10000-row truncation of
these new derived reports. `nextCursor=null` only at exhaustion. Recompute the complete authorized projection
under one coherent lifecycle-locked read before slicing; full totals never come from loaded pages. Cursor
indices are nonnegative JSON-safe integers; invalid/out-of-range/filter-mismatched indices are 400. Paginate
by group/evidence row, never by currency minor unit. SQL aggregation/streaming should avoid unbounded entity
hydration and N+1 account/refund lookups.

Snapshots are lowercase SHA-256 freshness fingerprints, not capabilities or retained historical data. Canonical
input uses UTF-8 strings framed by four-byte big-endian byte length, tagged nullable values, fixed field order
as documented, sorted complete projections and explicit list lengths. Include domain `HouseSync:M6:<route>` (a fixed digest domain string),
policy tag, household, normalized filters (not page size/index), zone/asOfDate, complete authorized response
values/evidence versions and applicable plan/target versions. Omit snapshot/cursor themselves and response
transport timestamps. Never hash private/excluded inputs or household-wide mutation counters that private
writes can change. Cursor continuation with a snapshot differing from the current projection returns 409
`INSIGHT_SNAPSHOT_STALE`; clear accumulated rows and restart. There is no separate snapshot query selector.
Hidden transaction detail returns its existing generic 404 before any stale diagnosis. No cursor/query token
or financial payload in logs.

All Insights read DTOs are separate from the existing strict ledger and shared-finance DTOs. Only new routes allow the new selectors; do not
quietly add fields to existing responses. Reuse a single authoritative projection/calculation per meaning.

## 3. Monthly comparisons, categories and merchants

### Group identity and conservation

- Categories: the existing 16 API category tokens, plus `UNCATEGORIZED` for null, with fixed label
  “Uncategorized”. Use existing API labels for the 16 categories. Emit a group if there is at least one eligible
  expense/refund in either compared period, even when its net is zero. Budget OVERALL has fixed label “Overall”;
  these two new bucket labels are presentation constants, not additions to the 16-item category endpoint.
- Merchants: apply existing `RuleTextNormalizer` semantics to an expense's public description. Version tag
  `PUBLIC_DESCRIPTION_V1`: NFKC; `Locale.ROOT` lowercase; collapse `Character.isWhitespace` or SPACE_SEPARATOR
  runs to ASCII space and trim; preserve punctuation, digits and token order. Reject empty, control-bearing or
  >200-code-point results. No store-number removal, amount/date matching, provider IDs or fuzzy aliases.
- Valid merchant group key is lowercase SHA-256 over length-framed domain `HouseSync:M6:merchant`, normalizer
  tag, household UUID, currency and normalized text. Label is that normalized text (plain text, not HTML).
  Invalid normalizations go to literal key `UNGROUPED`, label “Ungrouped descriptions”; they still count.
  Key lookup always reauthorizes the source population; guessing a digest grants nothing.
- Label these **merchant / description groups**, not verified businesses. Similar descriptions can name different
  businesses; differing descriptions may name the same one. Groups never expose account IDs/names, provider
  merchant metadata, private rule matches, profiles or another party's repayment details.
- Category sums and merchant sums each equal period spending, including uncategorized/ungrouped and refund-only
  groups. They are alternative breakdowns of the same spending, never additive components of each other.

### Read APIs

| Method/path | Query | Exact response fields |
| --- | --- | --- |
| `GET H/insights/spending-series` | required `fromMonth,toMonth,currency`; optional `dimension,groupKey` supplied together (`CATEGORY|MERCHANT`) | Metadata, `fromMonth,toMonth,dimension,groupKey,items` |
| `GET H/insights/spending-comparison` | required `month,baselineMonth,currency,dimension` (`CATEGORY|MERCHANT`); optional `limit,cursor` | Metadata, `period,baselinePeriod,dimension,current,baseline,change,items,nextCursor` |
| `GET H/insights/spending-evidence` | required `month,currency,dimension,groupKey`; optional `limit,cursor` | Metadata, `period,dimension,groupKey,totals,items,nextCursor` |

A policy tag is `SPENDING_V1` plus `PUBLIC_DESCRIPTION_V1` where grouping applies. The server returns one fixed
combined string `SPENDING_V1/PUBLIC_DESCRIPTION_V1` on all comparison reads so normalizer drift invalidates projections.

Series `items` are ascending `{period,totals}` for every requested month, including explicit zero buckets.
Unfiltered totals use `Totals`; filtered totals use the same type with `incomeTotal` exactly zero (this is a
spending-only drill-down). With no group filter, `dimension` and `groupKey` responses are null; with a filter,
they echo it. A valid group absent throughout the series returns zeros, never proof that hidden records exist.
No per-group array inside every month: drill-down selects one group and remains bounded to 24 rows.

Comparison `current`/`baseline` are complete `Totals` independent of row pagination; `change` compares their net.
`items` are `GroupComparison`, sorted by **absolute exact net delta descending**, then `key` ascending bytewise;
all items, including zero-delta groups, are reachable. Limit applies to groups only. The comparison fingerprint
covers both periods' full group projections; moving money between groups invalidates a cursor even if overall
spending stays constant. Selecting a group opens its monthly series and both months' evidence.

Evidence `totals` is `Spend` for that group/month and all matching records. Items are exactly
`id,version,kind,occurredOn,money,description,category,refundOfTransactionId`; money is existing `{amount,currency}`
with ledger sign, kind EXPENSE/REFUND, category nullable. Account/profile/provider/repayment data is absent even
for the transaction owner on this shared route. Sort `occurredOn DESC,createdAt DESC,id DESC` using stored values;
createdAt is a sorting input, not an exposed field. Link to the existing authorized transaction detail for actions;
nonowners remain read-only. Category keys must be valid category tokens or UNCATEGORIZED; merchant keys must be
64 lowercase hex or UNGROUPED. An absent valid key yields zero/empty, not an existence leak. Recompute full
projection fingerprints including evidence versions, not just aggregate amounts, for continuation.

### Browser behavior

Add a reachable **Insights** destination within the selected household, not another hidden report below an
unbounded transaction feed. Retain existing Home/dashboard and shared-finance contribution/balance meanings; no unrelated
navigation rewrite. Show selected currency, actual period bounds, zone, current-state scope and calendar state.
A selector switches category vs merchant descriptions. A chart has an equivalent accessible table with exact
values, non-hover controls and explicit refunds/signs; use backend rounded ratios or bounded visual geometry,
never float-converted money as authority. Do not silently drop “other” money in charts: full table pages and
whole-population totals remain available and partial lists are labeled.

Explain the delta as expense growth minus refund growth, not a causal claim. Empty/no-baseline/negative-baseline,
unchanged, refund-heavy, future/in-progress and stale states are distinct. No extrapolation or claim of complete
bank coverage. Tests cover exact series/group conservation, refund-source-outside-month attribution,
normalizer boundaries, distinct descriptions, >100 merchants/evidence rows, coherent stale paging, private
independence, member departure/rejoin and mobile/keyboard/error flows.

## 4. Recurring expenses, subscriptions and bills

### Detection population and bounded evidence

Policy tag `RECURRENCE_V1/PUBLIC_DESCRIPTION_V1`. Detection is read-only and deterministic; it creates no
subscription, bill, ledger row, category, split, payment or budget. Only currently disclosed POSTED EXPENSE
records in the selected currency participate. Refunds are not another recurrence occurrence and do not cancel
one; link to the comparison evidence for their spending effect. Private facts are excluded even for their owner on this household
surface. No `/mine` population, personal plans or private provider evidence is introduced.

At the request's zone-derived `asOfDate`, evidence bounds are `[max(1900-01-01,asOfDate.minusMonths(36)),to)`,
where `to=min(asOfDate+1 day,9999-12-31)`. Month subtraction clamps day-of-month to target-month length,
as in Java LocalDate.minusMonths. Include today, exclude future-dated expenses; no asOf query override.
For a server date beyond supported ledger dates, cap the effective evidence end at 9999-12-31 and derive
the 36-month start from its preceding day. Before 1900-01-01 return evidenceFrom=evidenceTo=1900-01-01,
an empty window. Return actual bounds, never silently call it full history. Comparisons may include selected future
posted facts; recurring detection covers **observed through today** only. This window covers three annual observations
without an unbounded all-history scan.

Group by the comparison merchant key plus currency, excluding UNGROUPED from automatic candidates (comparisons still count it).
For each group sort **every** expense by occurredOn ASC then canonical UUID ASC. No date/amount deduplication,
suffix removal, subset mining, outlier removal, same-day collapsing or choosing a convenient three-row suffix.
At least three records are required. Conservative grouping can miss two separate same-description subscriptions;
state that limitation, not a false negative guarantee. Manual tracking remains available.

### Cadence and amount algorithm

For each group let d0 be its first observed date; compare every row i=0..n-1 with an anchored expected date:

| Cadence | Expected date i | Allowed absolute day deviation |
| --- | --- | --- |
| `WEEKLY` | d0 + 7*i days | 1 |
| `BIWEEKLY` | d0 + 14*i days | 1 |
| `MONTHLY` | month(d0) + i months, anchored day rule below | 3 |
| `QUARTERLY` | month(d0) + 3*i months, anchored day rule below | 3 |
| `ANNUAL` | month(d0) + 12*i months, anchored day rule below | 3 |

Calendar anchor: if d0 is the last day of its month, use the last day of each target month; otherwise use
min(dayOfMonth(d0),lengthOfTargetMonth). Compute each expected date from the **original** anchor, not repeated
clamped additions. A group qualifies only if exactly one cadence fits **all** rows; zero/multiple matches yield
no candidate. Equal-date duplicates or skipped cycles therefore disqualify, not silently merge or bridge gaps.
This avoids accumulated drift: Jan1/Feb4/Mar8 is not monthly. Jan31/Feb28/Mar31 is; Jan30/Feb28/Mar30 retains
day30. For Feb29 annual anchoring, later February dates use month end. An out-of-supported-range expected
slot cannot qualify an observation. The next expected slot beyond supported ledger dates is null with
`DATE_LIMIT`, never overflow/wrap. Calendar calculations operate on dates/integers only.

Amount magnitudes in minor units are exact arbitrary-precision integers. For n rows sorted by magnitude, choose
lower median index floor((n-1)/2). `amountPattern=STABLE` iff `10*(max-min) <= median`, else VARIABLE; no decimal
division or floating threshold. Variable utility bills are still candidates. This is a disclosed heuristic,
not an assertion that a tariff is fixed. Report min/median/max; never suggest the median is an agreed next charge.
`suggestedKind=SUBSCRIPTION` only if every evidence expense's current category is SUBSCRIPTIONS; `BILL` only
if all are UTILITIES or all HOUSING; otherwise `RECURRING_EXPENSE`. User review chooses the actual plan kind;
category heuristics never establish a legal subscription or bill.

Next candidate expectation is anchored slot n, not last observed date + cadence. `expectationState` is
`UPCOMING` before expected date minus tolerance; `DUE_WINDOW` through expected date plus tolerance inclusive;
`NOT_OBSERVED` after the window; `DATE_LIMIT` when next date cannot be represented. NOT_OBSERVED means only no
matching disclosed continuation in this evidence window, never unpaid/late/canceled. An old regular sequence
can remain a lapsed-looking candidate while its evidence remains in the 36-month window.
Candidate states describe the **next unobserved slot** after a qualifying sequence; plan states below describe
the **latest scheduled slot on/before today**. They intentionally are not the same state machine: candidate
states never contain OBSERVED/AMBIGUOUS, since all observed rows already occupy earlier qualifying slots.

### Candidate and review APIs

| Method/path | Query/body | Exact response fields |
| --- | --- | --- |
| `GET H/insights/recurring-candidates` | required `currency`; optional `review=OPEN`(default)/DISMISSED/ALL, `limit,cursor` | Metadata, `evidenceFrom,evidenceTo,items,nextCursor` |
| `GET H/insights/recurring-evidence` | required `currency,merchantKey`; optional `limit,cursor` | Metadata, `evidenceFrom,evidenceTo,merchantKey,candidate,items,nextCursor` |
| `PUT H/insights/recurring-review` | exactly `currency,merchantKey,candidateFingerprint,expectedVersion,status` with status OPEN/DISMISSED | `merchantKey,currency,reviewStatus,reviewVersion` |

Candidate fields are exactly `merchantKey,label,cadence,anchorOn,calendarAnchor,occurrenceCount,firstOccurredOn,
lastOccurredOn,minAmount,medianAmount,maxAmount,amountPattern,suggestedKind,nextExpectedOn,expectationState,
candidateFingerprint,reviewStatus,reviewVersion,activePlanId`. Label is current normalized shared description.
`calendarAnchor=DAY_OF_MONTH|END_OF_MONTH` for calendar cadences, null for weekly/biweekly; `anchorOn=d0`.
Count is a decimal string. Amounts have the request currency scale; nextExpectedOn nullable. activePlanId
is the current active household plan whose independently entered match key/currency equals the candidate,
otherwise null. It is not a source transaction relationship.

Order candidates by merchantKey bytewise; status filter applies after intersecting current eligible candidates
with the actor's own review preference. All group evidence is evaluated before paging, never the first 100 rows.
The list snapshot includes the full filtered candidate projection, actor review versions, relevant activePlanIds
and those plans' current versions; create/archive changes the link and invalidates continuation.
`candidateFingerprint` is a separate SHA-256 using the same framing with domain `HouseSync:M6:candidate`, policy,
household/currency, evidence bounds, merchant key, complete sorted eligible expense IDs/versions/dates/amounts/
categories and computed cadence/amount fields; it excludes review preference and plans. Consequently another
member dismissing a suggestion cannot change this actor's preference, candidate facts or candidate fingerprint.

Evidence items have the comparison evidence field set, EXPENSE only, descending occurredOn/createdAt/id; no account data.
Return all current matching expense rows within the detection window even if the group no longer fits a cadence, with
candidate null in that case. A syntactically valid absent merchant key yields empty rows/candidate null and no
hidden-resource signal. Returned candidate, when present, has current actor preference and plan link.
Continuations are snapshot-bound. Invalid key (including UNGROUPED) is 400, not an automatic recognition path.
Candidate qualification and review preferences are not authorization gates for shared evidence: one or two
currently disclosed expenses remain readable here and via comparisons/the ledger. No formerly shared/private row returns
merely because its digest, an old candidate or a retained preference is known.

Each current member can dismiss/restore **their own** review preference only; no household owner overrides it.
No inference becomes an accepted plan merely because it was dismissed. Persist only household/stable actor ID,
currency, merchant-key digest, OPEN/DISMISSED, version and server updatedAt; no transaction-derived label, amount,
source IDs, counts or dates. No enumeration/read route for detached preferences. They are visible only through a currently
qualifying authorized candidate, so unsharing cannot leave a readable ghost suggestion or leaked label/count.
Rejoin restores the same actor preference if the candidate qualifies again; changed evidence at the same key
keeps DISMISSED until explicit restore. No irreversible “not recurring” claim or model training.
A detached preference can be restored only after its key qualifies again, from the then-current DISMISSED list;
until then it is inert, not individually discoverable or mutable. Explain this and bounded eviction in review UI.

Review version is0 when no preference exists; first real state change persists version1, subsequent transitions
increment once. Missing+OPEN and current-version same-state are no-ops. Require the current candidate fingerprint
and expected review version under the household lock; if it no longer qualifies or changed, return
INSIGHT_SNAPSHOT_STALE before storing anything; stale preference version uses RESOURCE_VERSION_CONFLICT.
PUT is an explicit versioned action, not a create-key operation. A lost response requires re-read before retry,
never automatic replay of edited input. Bound stored preferences to 1000 per actor/household: when another key
is needed, evict the least recently changed preference (timestamp then key tie); no-op reads/writes do not
refresh age. UI explains that old dismissals may reappear after this bound; no eviction exposes stored evidence.
Version check, optional one-row eviction and mutation are atomic under the same household lifecycle lock.
Order eviction by updatedAt ascending then merchantKey bytewise; reads/no-ops never refresh that timestamp.

### Explicit household bill/subscription plans

Plans are **independently entered and explicitly shared household intent**, not saved inferred evidence.
All current members can read; current household OWNER can create/edit/archive, matching reporting settings
and budget authority. Any member can inspect candidates or dismiss for themselves; nonowners are told that an
owner manages household plans. This new planning permission grants no transaction/account mutation authority.
Current owners can manage a plan after its author leaves; no uneditable departed-creator artifact.

Create shows a disclosure preview of every retained field and requires `acknowledgeHouseholdDisclosure:true`.
Explain that current/future members can read retained plan information even after supporting transactions are
unshared; archiving does not erase this independently published intent. Candidate-assisted forms may prefill
only from the current shared candidate, visibly editable, never from private bank/rule/own-only detail.
Server requires and validates candidate freshness on a candidate-assisted creation before first commit.
Manual creation does not accept a source transaction/merchant ID; matching text is explicitly entered intent.
No plan stores ledger evidence or a source-transaction FK. Existing privacy revocation does not claim to retract
an independently authored household record; users who do not accept that must not create the shared plan.

| Method/path | Query/body | Success |
| --- | --- | --- |
| `POST H/recurring-plans` | `label,kind,currency,matchDescription,cadence,anchorOn,calendarAnchor,expectedAmount,acknowledgeHouseholdDisclosure`; optional `candidate` object below; Idempotency-Key required | 201 new /200 replay; `RecurringPlan` |
| `GET H/recurring-plans` | required `currency`; optional status ACTIVE(default)/ARCHIVED/ALL,limit,offset | Existing bounded `{items,limit,offset,hasMore}` of `RecurringPlan` |
| `GET H/recurring-plans/{id}` | no query/body | 200 `RecurringPlan` |
| `PATCH H/recurring-plans/{id}` | expectedVersion + one or more mutable fields below, or status ARCHIVED alone | 200 `RecurringPlan` |
| `GET H/insights/recurring-plans` | required currency; optional limit,cursor | Metadata, `evidenceFrom,evidenceTo,items,nextCursor`; all active plan projections |
| `GET H/recurring-plans/{id}/observations` | optional limit,cursor | Metadata, `evidenceFrom,evidenceTo,plan,expectation,items,nextCursor` |

`RecurringPlan` fields exactly `id,householdId,label,kind,currency,matchDescription,merchantKey,cadence,anchorOn,
calendarAnchor,expectedAmount,status,version,createdAt,updatedAt`. Kind BILL/SUBSCRIPTION/RECURRING_EXPENSE;
label1-100 code points with existing trimmed/no-control policy; matchDescription is1-200 and must produce a
valid normalizer key. Retain the explicitly entered trimmed matchDescription; merchantKey derives from it by
the comparison policy. Currency explicit/immutable. Cadence is one of the five tokens above. anchorOn is a supported ledger
date, not necessarily an observation or a past date. calendarAnchor must be null for day cadences; for calendar
cadences it is DAY_OF_MONTH or END_OF_MONTH (end-of-month requires anchorOn actually be a month end).
expectedAmount is required nullable decimal text: null means unknown/variable with no explicit estimate;
otherwise strictly positive, currency-scale/input-bound amount. Zero is not a known charge; no fake default.
There is no nullable/missing cadence: manual plans must specify a schedule to be actionable.

One active plan per `(household,currency,merchantKey)` enforced transactionally and in the database. Two charges
with identical normalized text cannot be separately auto-matched: explain the conservative limitation; do not
invent account joins. Different user-entered matching text permits genuinely distinct plans. Active identity
conflict is RECURRING_PLAN_CONFLICT, not duplicate transaction detection. Plan count is not assumed bounded by
household member count.

Optional candidate is exactly `{merchantKey,candidateFingerprint}`; key must equal the normalized submitted
matchDescription and a currently qualifying shared candidate under the same currency. A valid-but-absent or
changed candidate is INSIGHT_SNAPSHOT_STALE. User may override suggested kind/cadence/anchor/amount deliberately;
fresh evidence is not an arithmetic approval. Nonowners cannot create by replaying someone else's candidate.

Creation operation RECURRING_PLAN_CREATE uses actor/household/key durable uniqueness. Fingerprint all canonical
submitted intent, including explicit null, disclosure acknowledgement, and optional candidate key/fingerprint.
Same key/body after success returns the current authorized plan even if archived, evidence disappeared or
actor's original candidate is stale; current OWNER authorization still required. Check key replay before
rerunning first-create evidence/uniqueness checks. Changed intent under same key conflicts. Store only the
fingerprint digest, not copied candidate evidence, with the key/result association; rollback reserves nothing.

Mutable fields: label,kind,matchDescription,cadence,anchorOn,calendarAnchor,expectedAmount. PATCH must submit the
complete `cadence,anchorOn,calendarAnchor` trio if changing any one, and validate uniqueness after text change.
Reapply all create-time field/trio validation to the resulting PATCH state, including month-end anchoring.
Any retained-content edit also requires acknowledgement true and previews changed disclosure. Identity/currency,
household and creation fields immutable; no writable source/owner field. Archive is terminal, no deletion/
unarchive or content edit of archived plans. Status ARCHIVED cannot be combined with content fields; current-version
archive no-op returns unchanged. Standard version/exhaustion/lock/retry rules apply.
After authority and expected-version checks, any content edit of an archived plan returns
RECURRING_PLAN_CONFLICT even for equal input; lifecycle conflicts precede active-key uniqueness checks.
List order createdAt DESC,id DESC with existing offset bounds and explicit incomplete history at the cap.
Use the derived active-plan cursor route, not this history page, for complete Insights/summary traversal.

### Live observations and expected-date states

All dynamic observations use current disclosed expense matches within the 36-month window and through today;
no three-occurrence/cadence qualification is required for an explicitly tracked plan. Nothing is auto-admitted
or marked paid. Correcting plan matchDescription changes its current observed matches without rewriting ledger
records. Archive hides it from active dashboards but authorized archived detail/observations remain reachable,
explicitly current data rather than “observed when archived”.

An active plan projection is exactly `{plan,expectation}`. Expectation fields exactly `latestExpectedOn,
latestState,nextExpectedOn,windowFrom,windowTo,matchedCount,observedAmount`. Schedule slots n>=0 use plan
anchor/cadence and the same anchored calendar arithmetic. latestExpectedOn is greatest representable slot <=today
or null when not started; nextExpectedOn is least slot >today, nullable at DATE_LIMIT. Find slots arithmetically,
not by looping each day since 1900. A calendar month-end anchor remains anchored after short/leap months.

For latest slot date d with tolerance t, observation window is [d-t,d+t+1day), clipped to supported ledger bounds.
Return those **slot** bounds in windowFrom/windowTo (null if no latest slot), not clipped to today's evidence end.
Count matches only in the intersection with the36-month evidence window and <=today. Under the five permitted
cadences, a latest slot is at most one year before the effective supported today, so its ledger-clipped past
window fits within36 months; no arbitrary historical-slot query or unreachable OUTSIDE_WINDOW state is exposed.
One match -> OBSERVED and positive exact observedAmount; more than one -> AMBIGUOUS and observedAmount null;
zero -> AWAITING while today <=d+t, else NOT_OBSERVED. matchedCount is an exact decimal string, zero allowed.
No latest slot -> NOT_STARTED, matchedCount/observedAmount null. nextExpectedOn null at the upper limit does not
erase a latest observation; the UI labels the schedule date limit separately. Bound arithmetic before converting
to date objects so tolerance windows cannot overflow at the supported extremes.

OBSERVED means one matching disclosed ledger expense, **not verified payment or contractual satisfaction**.
AMBIGUOUS never sums duplicate-looking rows into one charge or chooses a payer. The observations endpoint returns
all current matching expense evidence within the window, in the comparison evidence shape/order; refunds remain in comparisons only.
No in-window matches yields empty evidence, not cached last-seen amount/date. On unshare/void/source correction,
observations and expectation recompute; user-entered plan fields do not become secret bank evidence.

Derived active-plan list orders nextExpectedOn ascending nulls last, then plan ID ascending; snapshot covers all
plans/versions/expectations and current authorized observation evidence. Plan detail observations fingerprint
also covers evidence IDs/versions, even if matchedCount/amount stay unchanged. No per-plan N+1 scan: use one
scoped bounded-date query/stream and shared normalizer. Recurring detection introduces no persisted merchant-key column/backfill;
consider an index only with actual query evidence and unchanged categorization/privacy outputs.

The summary's `recurring` object is exactly `evidenceFrom,evidenceTo,openCandidateCount,activePlanCount,items,hasMore`.
Counts are decimal strings; openCandidateCount is current qualifying OPEN candidates for this viewer **without**
an active plan, never detached preference count. Items are the first five active plan projections in the ordering above;
hasMore reports additional active plans, and links to the cursor-paged recurring view. Selection uses today's zone/date,
not the summary's selected historical month. Expected amounts are neither summed into actuals nor advertised as a cash-flow
forecast; no nominal monthly conversion of annual/weekly plans.

### Retention and browser behavior

The recurring migration adds plans, actor-scoped bounded review preferences and durable plan creation keys. Constrain
household/stable-user references, money/currency scale, kind/cadence/anchor combination, name bounds, state/version
and active-key uniqueness. Preferences retain only digests/state and are not an enumerable historical API;
plans retain explicit household intent under existing no-hard-delete policy. No series/evidence persistence,
private-derived fingerprint or automatic historical plan backfill. No binary downgrade promise bypasses §7.

UI separates “Possible recurring expenses”, “Tracked household bills/subscriptions”, and observed ledger evidence.
Show36-month/today scope, exact min/median/max, cadence tolerance, category suggestion and uncertainty; no certainty
score or paid badge. Candidate review is available to members; retained plan management is owner-only and requires
the disclosure preview. All states, keyboard/focus, unknown outcomes, stale confirmation and cursor restart
follow §6. Archive/dismiss/missing evidence must not strand focus or expose stale text as newly authorized data.
If a previously loaded candidate disappears, explain that current shared evidence changed or no longer qualifies;
do not invent which hidden correction or private transaction caused it.

Tests cover fixed/variable examples (15.99 monthly; 80.12/95.40/210.00 utility), 2 vs 3 records, annual three-year
evidence, leap/month-end/original-anchor drift, duplicates/missing cycles, lower-even median/exact10% threshold,
window cutoff/future exclusion, evidence disappearing after unshare, no detached preference read,1001-preference
bound, conflicting plans/durable replay/role-change/rejoin, manual plans without evidence, ambiguity and time-window
states, and real member-review/owner-create/edit/archive bill and subscription journeys.
The preference-cap check identifies the exact evicted key under timestamp/key ordering and verifies concurrent
PUT serialization, not just a row count. Lower/upper date clamps and latest-slot coverage are explicit checks.

## 5. Explicit monthly budget targets

### Intent, authority and lifecycle

A target is household-authored planning intent for one reportable month and currency, not a ledger mutation,
allocation, recurring expense, bank balance or promise of affordability. Bucket is `OVERALL`, an existing category
token, or `UNCATEGORIZED`. All category tokens are legal because ledger kinds, not category names, determine
spending. Overall overlaps category targets; do not sum them, require their sum to equal overall, or distribute
an unspecified remainder. Categories without a target still contribute to overall spending and remain unbudgeted.

Every current member reads targets/progress; **only a current household OWNER writes**, including replay of a
create. Ownership belongs to the household, not the original creator. An owner departure preserves intent and
other current owners may manage it; joining grants the disclosed read scope, not finance-account authority.
No profile/email joins. Archived target history is explicit user intent, not retained private transaction data.

- One ACTIVE target per `(household,month,currency,bucket)`; separate keys cannot bypass uniqueness.
- Amount is nonnegative, exact currency-scale input within the existing per-record magnitude bound. **Zero is
  valid** intentional “no spending”; reject negative/negative-zero. No target is distinct from a zero target.
- Immutable: ID, household, month, currency, bucket and creation timestamp. Correct identity by archive/create.
- ACTIVE amount can be edited, including for past/future months. Current progress immediately uses the edited
  target; no “target as originally agreed” claim and no retroactive event log is invented.
- ACTIVE -> ARCHIVED is terminal. Retain detail/history, exclude from active progress; no unarchive or hard delete.
  Archive then create a replacement uses a fresh key. Archived amounts are frozen; archive-current-version no-op
  returns unchanged. Combined amount edit + archive is rejected to avoid an invisible last-minute target change.
  After authorization and expected-version validation, any amount edit of an archived target returns 409
  BUDGET_TARGET_CONFLICT, even if the submitted amount equals the old amount.
- No recurring templates, rollover, prorating, automatic future targets or bulk partial writes. “Copy to another
  month” pre-fills one reviewed create form; submission is a new resource/key, never a background side effect.

### Target APIs

| Method/path | Request | Success |
| --- | --- | --- |
| `POST H/budget-targets` | exactly `month,bucket,money`; required UUID Idempotency-Key | 201 created / 200 same-key replay; `BudgetTarget` |
| `GET H/budget-targets` | required `month,currency`; optional `status` ACTIVE(default)/ARCHIVED/ALL, `limit,offset` | Existing `{items,limit,offset,hasMore}` envelope of `BudgetTarget` |
| `GET H/budget-targets/{id}` | no query/body | 200 `BudgetTarget` |
| `PATCH H/budget-targets/{id}` | `expectedVersion` plus exactly one of `amount` string or `status:"ARCHIVED"` | 200 `BudgetTarget` |
| `GET H/insights/budget-progress` | required `month,currency` | Metadata, `period,totals,overall,categories,untargeted` |

`BudgetTarget` has exactly `id,householdId,month,bucket,money,status,version,createdAt,updatedAt`. Money contains
amount/currency once; request has no redundant currency or writable creator field. Month syntax/range follows §2.
List uses existing limit 1-100/default50, offset 0-10000/default0; order bucket bytewise then createdAt DESC,id DESC;
label cap-incomplete archived history. Active month/currency rows are intrinsically bounded by 18 possible buckets
(overall + 16 categories + uncategorized); active progress never computes from that history page.
Browsing another month's history deliberately requires another month-scoped request. Resource CRUD remains
under H/budget-targets; derived current progress alone lives under H/insights/budget-progress.

Creation operation `BUDGET_TARGET_CREATE` reuses durable `(actor,household,operation,key)` uniqueness. Fingerprint
canonical month, bucket, currency and normalized-scale amount. Reauthorize OWNER on replay, then return current
resource, including archived; do not rerun active uniqueness as if creating again. A same key/different input is
`IDEMPOTENCY_CONFLICT`; a different key/occupied active bucket is `BUDGET_TARGET_CONFLICT`. All key/resource writes
commit together or neither; persist retry association for resource retention lifetime. Versions and lifecycle
lock follow existing finance rules, including stale/no-op/exhaustion and five-second lock timeout.

### Exact progress

Budget `Metadata.policyVersion=BUDGETS_V1`; progress snapshot covers current target versions
and current scoped category amounts/counts under one authorized read, not description-normalizer policy.
`totals` is complete `Spend` for the month.
`overall` is null without an active overall target, otherwise `BudgetProgress`. `categories` contains every active
category/uncategorized target in bucket-key order **even with zero spending**. `untargeted` is one `Spend` for all
category buckets without an active category target (regardless of whether overall exists); no invented target.

`BudgetProgress` has exactly `target,actual,remaining,overBy,percentUsed,status`; target is `BudgetTarget`, actual
is `Spend`, remaining/overBy are exact amount strings, percentUsed nullable two-decimal string, status
`UNDER|AT|OVER`. For target T>=0, actual net S:

- `remaining = T-S` signed, not clamped. `overBy=max(S-T,0)`; status compares S with T exactly.
- `percentUsed=round_HALF_UP(100*S/T,2)` if T>0, otherwise null **even when S=0**. Negative or >100 values are valid.
  No division by zero, “infinite percent”, or data clamp. An optional visual meter may clip geometry to 0-100%
  only alongside the unclipped exact figures and explicit signed labels.
- `sum(category actuals)+untargeted = totals` componentwise. Overall actual equals totals if target exists,
  not another component to add. Counts also conserve. Category membership follows the current source category.

Examples (USD): T200,S130 -> remaining70, overBy0, 65.00%, UNDER; T100,S120 -> remaining-20, overBy20,
120.00%, OVER; T200,S-50 -> remaining250, overBy0, -25.00%, UNDER. T0,S0 -> remaining0, percent null, AT;
T0,S5 -> remaining-5, overBy5, percent null, OVER. JPY7500/10000 is 75.00%; KWD0.020/0.050 is 40.00%.
A future month containing a posted shared expense has nonzero progress; it is not forced to zero.

The budget UI shows no-target versus zero-target, overlapping overall/category scopes, unbudgeted spending, signed
refund effects, immutable identity and explicit disclosure/owner authority. Editing a past month warns that
this changes today's view of that month's target. Version conflict reloads authoritative target before retry;
unknown create outcome retains the same key/body. Progress and target cards refresh together after a mutation.
Tests cover exact equations/zero/negative/large values/all seven scales, unique concurrent creates, role
change/removal races, restart replays, immutable archive, cross-period refunds/current category restatement,
full month/zone/future cases, and accessible real owner/member mobile management/recovery.

## 6. Deterministic household summary and integrated experience

### One coherent summary, not a stitched causal narrative

`GET H/insights/summary?month=2026-09&baselineMonth=2026-08&currency=USD` requires the same distinct reportable
months/currency as comparisons. Response has exactly Metadata, `period,baselinePeriod,current,baseline,change,
categoryDrivers,merchantDrivers,budget,recurring`. The exact policyVersion string is
`SUMMARY_V1/SPENDING_V1/RECURRENCE_V1/BUDGETS_V1/PUBLIC_DESCRIPTION_V1`.
Compute all sections within one authorized household lifecycle-locked read; invoke shared
application/pure projections, not internal HTTP or repeated unlocked endpoint reads. Fingerprint the complete
returned summary plus underlying ordered driver/evidence/plan/target versions that determine it. No persisted
summary, bank/private-data completeness score or natural-language model call.

- `current`/`baseline` are `Totals`; `change` is the comparison `Change`. Always show expense/refund components so a refund
  increase is not called fewer purchases. Income is separate; no “disposable income” or net cash inference.
- Each driver object (`categoryDrivers` / `merchantDrivers`) has `increases,decreases,otherDelta`. Take at most
  five strictly positive and five strictly negative net-delta groups separately; sort each by absolute delta
  descending then key bytewise. Elements are comparison `GroupComparison`s. `otherDelta=overall delta - sum(shown deltas)`
  exactly, including all omitted groups. No positive delta means empty increases, not manufactured insight.
  Categories and merchants each reconcile to the same change and must never be added together. No “caused by”
  assertion beyond these arithmetic contributions. Links open the matching comparison/filter/evidence.
- `budget` has exactly `totals,overall,categories,untargeted`, the budget projection for selected month, including null
  when no overall target and zero-spend explicit targets. No misleading sum of category and overall headroom.
- `recurring` is a bounded **current** recurring overview, explicitly marked with its own evidence/expectation dates,
  not as-of selected month. It shows review/tracked-plan state and a paged-view link; expected amounts never
  enter actual spending, income, budgets or shared-finance balances. Its exact fields and ordering are specified in §4.

Render concise template-based statements from these structured exact fields: net changed by amount; expense
and refund changes; largest category/description-group changes; budget under/at/over; tracked upcoming or
unobserved expectations. Do not infer affordability, intent, fraud, subscription cancellation or provider data
coverage. No direction adjective (“better/worse”) substitutes for positive/negative numerical meaning.

### Cross-surface browser lifecycle

- Every Insights area is reachable from the active household. Existing shared-finance contribution/settlement views
  are linked and labeled separately, not copied into a new aggregate with different privacy or calculation semantics.
- Multiple household cards can be mounted together; summary links and keyboard focus must stay inside
  the originating household and page-wide IDs must remain unique, including recurring, budget and shared-finance destinations.
- Required states per view: loading, ready, empty, no baseline/no target, future/in-progress, validation,
  stale/conflict, forbidden/lost membership, recoverable network/server failure and successful action.
- Maintain applied selections separately from drafts. Refresh uses applied month/currency/group, preserving
  unrelated drafts. After ledger/share/unshare/refund/category/description/status or an admitted bank replacement,
  invalidate relevant evidence/actuals; after plan or target mutations refresh their cards and summary. Repayment
  or allocation-only changes do not change Insights actuals. Reporting-zone changes re-evaluate default periods and
  current expected-date labels, not explicitly applied months or saved plan anchors/targets.
- Refresh on entry, explicit refresh and return to a visible Insights view. Authorized feed refresh detecting
  changed/disappeared shared rows also invalidates Insights; do not rely only on versions of rows still present.
  No polling, push or instant cross-device guarantee is introduced. Explain refresh/current data; test that
  remote unshare followed by refresh removes evidence and converges all relevant displayed figures.
- Snapshot 409 clears accumulated pages and offers/requires fresh first-page load; do not merge old groups
  with new totals. Known hidden-detail 404 clears that detail and triggers report refresh. Confirmed household
  access loss/logout/expiry/switch clears all scoped values/drafts/keys/cursors and cancels or ignores late callbacks.
  A mere network failure is not membership loss. During known disclosure invalidation hide affected old evidence;
  on an unrelated recoverable read error last good data may remain only visibly stale.
- Financial data, labels, fingerprints and retry bodies stay memory-only; no local/session storage, query-string
  financial descriptions, telemetry payloads or console logging. Error correlation is safe existing metadata.
- Charts require exact accessible tables/summary text; no color-only status, hover-only facts or truncated sole
  amount. Keyboard paging/actions keep predictable focus; 44px targets, visible focus, reduced motion, long
  Unicode labels, large signed amounts and 200% text reflow are requirements, not afterthoughts. A scrollable table
  may have a labeled keyboard-focusable region; page-level horizontal overflow is not an acceptable substitute.

## 7. Persistence, errors and rollout

### Persistence by area

| Area | Integration / persistent changes |
| --- | --- |
| Comparisons | Report application/controller/strict DTO/client/Insights UI over the current ledger; reuses money, settings, membership and text policy. No merchant entity, stored aggregate or ledger backfill. |
| Recurring | Forward migration (V21) for explicit plans, bounded review decisions and durable creation keys, with constraints/retention in §4. No saved shared evidence, auto-created charges or inferred historical plans. |
| Budgets | Separate forward migration (V22) for budget targets and creation keys. Restrictive household FK, month/bucket/currency/scale/range/state/version constraints, partial active uniqueness and read indexes. No backfilled targets or progress table. |
| Summary | Reuses the other projections under one transaction, typed summary and linked UI; no summary store/queue and no schema change. |

Migrations are forward-only; applied migrations are never rewritten. Use restrictive household/stable-user
references, never membership rows that leave/removal deletes. PostgreSQL `NUMERIC(15,3)` for bounded persistent
money with explicit scale/range constraints **before driver coercion**; arbitrary-precision aggregates may exceed
that storage precision. Database uniqueness complements locked service rules. Lock order household -> Insights
resource -> source transactions in canonical ID order when needed, consistent with existing finance locks; no
network calls under locks.

Reuse typed strict parsers, request-generation, CSRF/error/idempotency conventions
rather than a second framework. Only delivered paths enter the security
allowlist. No compatibility aliases, duplicate policy implementations
or silent older-policy fallbacks. The shared pure normalizer preserves categorization
outputs/fingerprints and callers migrate together without broadening visibility.

### Safe errors

Existing `{code,message,correlationId,fieldErrors?}` applies; field errors name known inputs, never echo values.
Unauthenticated is 401; CSRF/action denial 403; removed/nonmember/missing household is generic household 404.
A current member forbidden from editing a known household plan/target receives 403, not private-data detail.

| Status/code | Meaning |
| --- | --- |
| 400 `VALIDATION_FAILED` / 415 same code | Strict shape/query/date/currency/money/cursor/body-media failure. |
| 404 `RECURRING_PLAN_NOT_FOUND` / `BUDGET_TARGET_NOT_FOUND` | Missing or foreign retained resource after household authorization, same safe response. |
| 409 `INSIGHT_SNAPSHOT_STALE` | Authorized derived projection changed; fresh read required. |
| 409 `RECURRING_PLAN_CONFLICT` / `BUDGET_TARGET_CONFLICT` | Authorized invalid lifecycle / conflicting active intent; no private values in error. |
| 409 `RESOURCE_VERSION_CONFLICT` / `RESOURCE_VERSION_EXHAUSTED` | Existing version policy, including settings/plan/target writes. |
| 409 `IDEMPOTENCY_CONFLICT` | Same scoped creation key, different normalized input. |
| 503 `FINANCE_BUSY` | Bounded lock/query capacity failure, transaction rolled back; no partial totals or mutation. |
| 500 `INTERNAL_ERROR` | Existing safe unexpected failure. |

Do not invent different forbidden messages based on hidden accounts/evidence. Query/log diagnostics contain
operation/outcome/correlation only, no financial filters, labels, tokens, bodies or source records.

### Migration and recovery

A clean install and an upgrade of a populated database preserve users, sessions, ledger amounts/categories/visibility,
allocation policy tags, refunds, repayment events and durable retries. New plan and target tables start empty. Tests
exercise constraints, concurrent writes, rollback and restart persistence with synthetic isolated PostgreSQL data.
Comparison, budget and summary reads agree before/after schema changes. Persisted plan/target intent survives restart
and actor leave under its documented authority, but no departed member retains access.

Release backend and strict web DTOs together, refresh/reload clients at cutover and preserve uncertain create
outcome guidance. No binary-only rollback is possible after new intent is written; use a forward fix or a
tested backup restore in an isolated recovery environment. Production erasure, retention law, backup
infrastructure and hosting are outside what local migrations solve. See
[deployment](../development/deployment.md) for operational boundaries.

## 8. Behavior matrix

The following matrix records the behavior the test suites check for this contract. Live-provider, production and
human accessibility evaluation are outside it.

### Per-area checks

| Area | Observable checks |
| --- | --- |
| Comparisons | Month/year/leap/DST/default-zone boundaries; 1/24-month bounds and final supported month; exact seven-currency sums beyond input magnitude; category/merchant/ungrouped conservation; refund-only and source-outside-window attribution; zero/negative baseline ratios and unrounded direction; deterministic ties; >100 rows, stale grouping/evidence even with unchanged totals; SQL privacy/role/removal tests; series/comparison/drill-down/mobile recovery. |
| Recurring | Deterministic cadence and amount-policy examples, ambiguity/duplicates/missing-cycle rejection, calendar anchor/leap/end-of-month behavior, snapshot-bound confirmation, explicit household-plan disclosure and lifecycle, current evidence revocation, private-input independence, review preferences, no automatic payment/ledger effect, expected vs observed labeling, concurrent/replayed writes and restart, multi-member bill/subscription review/edit/archive UI. |
| Budgets | Zero/missing/negative-net targets/progress, all scales/max money, signed remaining and exact status vs rounded ratio, overlapping target conservation and unbudgeted bucket; unique concurrent creates, key/body replay/restart, versions/terminal archive/role and removal races; past/future/zone/current-category/refund restatement; owner/member mobile target management/retry. |
| Summary | Comparison/budget totals equal ledger and contribution net spending for identical scope; one-snapshot summary consistency during edits; each driver list plus otherDelta reconciles; current recurring section clearly distinct from selected-month actuals; empty/nonpositive-baseline/future/untargeted states; linked evidence, remote-unshare convergence and the integrated scenarios below. |

All surfaces cover financial owner, ordinary current member, household OWNER who does not own source
accounts, outsider, another household, removed/departed user, and same-user rejoin. Responses before/after
private-only changes are compared: shared totals, labels, counts, fingerprints and candidate order must be unchanged.
Role gain must not reveal private provider/rule/repayment/account data. Expired sessions, malformed inputs,
CSRF, version/duplicate/concurrent writes, snapshot freshness, SQL bounds and safe logs/errors are checked.

### Integrated household scenarios

1. Three members A/B/C in one household and outsider X; another household has similar descriptions. Include
   private and shared manual/confirmed-connected records, archived accounts, departed owners and private
   categorization merchant evidence. Only the authorized disclosed ledger contributes; X/removed access is denied.
2. September USD groceries expense 100 and October refund 20 against it, plus October groceries expense 120:
   September net 100, October expense 120/refund 20/net 100, delta 0; correction moves both expense/refund groups
   consistently. An October target 90 shows remaining -10, overBy 10, 111.11%, OVER. Repayments/allocations leave
   all those amounts unchanged. Income 50 and transfer 500 add no spending; income remains separately 50.
3. Three same-description monthly observed expenses form a conservative candidate; explicitly review and track
   a subscription. Add a bill plan with variable/unknown amount. Observe expected vs matched/no-observation states,
   correct/archive, dismiss/restore candidate review, and prove no transaction, allocation, balance, debt or
   budget target is created or paid by any plan action. Review cannot smuggle a hidden source into a shared label.
4. Member B unshares or corrects candidate evidence while member A has paged evidence open. Old cursor/confirmation fails
   stale or hidden safely; refreshed inference drops/regroups the facts. Independently authored plan text remains
   only under its explicit disclosed-intent contract, never as a retained source-evidence cache. Removing the
   last observation yields no fake prior amount, date or verified payment.
5. JPY and KWD reproduce scales and ratios without USD mixing; maximum-magnitude aggregates remain exact.
   Refund-heavy months remain negative; baseline 0/-10 never divides; zero target stays distinct from missing.
6. More than 100 merchant/evidence/recurring rows page with full totals and no silent truncation; concurrent
   category changes with unchanged net invalidate continuations. Budget/category targets conserve with untargeted
   actuals and never double-count overall. Summary drivers reconcile independently by category and merchant.
7. Member vs owner editing, demotion/removal/rejoin, terminal archive, same-key restart replay, lost create
   response, CSRF refresh and explicit retry preserve user intent and prohibit stale unauthorized commits.
8. Desktop/320/390px and intermediate 421-570px layouts, 200% text, keyboard paging/forms/chart alternatives,
   reduced motion, contrast and axe checks; focus after empty/final-page/error transitions.
   Automated checks alone are not full WCAG conformance; screen-reader and real-zoom review are separate.

Tests use fixed clocks and synthetic data; no live provider credentials, paid AI or production data are required.
Queries aggregate before paging, avoid N+1 and per-minor-unit loops, never hydrate unbounded history, and fail
with a safe timeout rather than silently partial totals.
