# Known limits

HouseSync is a working household-finance application. This page lists what it deliberately does not do, what has not been validated, and the tradeoffs a reader or operator should know before relying on it.

## What is implemented

- Operator-approved enrollment, assisted password recovery, server-side sessions, CSRF, password changes and account-wide session revocation.
- Household invitations, membership/role changes and last-owner protection.
- Private financial accounts and signed, dated transactions; explicit sharing, linked refunds, transfers, corrections and void history.
- Exact equal/explicit allocations, persisted refund policies, per-currency derived obligations, consented external repayment records and read-only settlement suggestions.
- Owner-private category rules, provenance and review workflows; explicit decisions remain authoritative.
- Selected/baseline spending, exact trends and evidence, monthly targets, conservative recurring suggestions and authored household plans.
- Responsive React navigation, filter sheets, request cancellation/ownership and recoverable uncertain-write flows.
- Optional provider adapters, durable synchronization and owner-reviewed ledger admission; optional suggestion-only AI. Both integrations are disabled by default.
- Docker/native development workflows, real-PostgreSQL integration tests, CI and generic hosting/backup references.

See [engineering decisions](../engineering.md) and the [documentation map](../index.md) for the implementation and tradeoffs.

## Not capabilities

- **No payment execution.** Repayment records attest to a payment made outside HouseSync; the application never moves money.
- **No currency conversion.** Amounts in different currencies are never converted or summed.
- **No public self-service signup.** Accounts require an operator-issued, recipient-bound enrollment code.
- **No account-wide sharing.** A household member sees only transactions the owner explicitly shared; household owners have no financial override.
- **No forecasts.** Plans and budget targets are intent, not payments, reserved funds or disposable income.
- **No native mobile client.** The web client is responsive; an Android client would be another consumer of the same API, not a second financial implementation.

## Not yet validated

These are open questions, not promises implied by publishing source:

1. **Operational recovery:** reconciling a populated restore, measuring whole-service recovery objectives, and validating off-host retention, key custody, alerts and operator response in a chosen environment. Backup scripts alone do not establish recovery readiness.
2. **Hosted privacy and failure journeys:** approved-member/outsider, membership change, session expiry and connectivity/retry checks against an actual deployment rather than a local stack.
3. **Human/device accessibility:** real phone keyboards, actual browser zoom and human screen-reader journeys. Automated axe checks and simulated text scaling are useful evidence, not WCAG certification.
4. **Provider readiness:** commercial approval, costs, real bank-originated posted changes/removals, production data handling and erasure/retention decisions. Fake and sandbox coverage does not replace these checks.
5. **Public-service security:** abuse controls, lifecycle/erasure policy, operational dependency review and capacity evidence. No high-scale or production-service guarantee is made.

## Known behavior and tradeoffs

- Uncertain financial-write intent is retained in browser memory, not durable browser storage. A full reload can lose the retry key; the client does not invent a replacement and risk duplicating the write.
- A narrowly scoped comparison-endpoint 404 can clear Insights data while leaving its loading state until **Refresh current records**. This is a recovery-state issue, not unauthorized data access.
- Financial controllers and the typed web API client are substantial. Smaller workflow boundaries are a maintenance direction; any extraction must preserve request ownership, authorization, drafts and immutable retries rather than merely reducing file length.
- The web production bundle has a size advisory. No measured performance or scale claim is made.
- The dependency baseline includes known Tomcat/Jackson advisory matches; see [SECURITY.md](../../SECURITY.md#known-dependency-advisories) and the [applicability review](../development/dependency-review.md).
