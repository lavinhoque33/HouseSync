# Engineering documentation

Start with the [project overview](../README.md) and [engineering decisions](engineering.md). The documents below explain implemented behavior and consequential tradeoffs; [known limits](product/known-limits.md) lists what is deliberately out of scope or not yet validated.

## Run and change the application

- [Local setup](development/local-setup.md): Docker-first startup, operator-issued enrollment and native development.
- [Testing](development/testing.md): unit, real-PostgreSQL integration, browser and failure-path verification, with recorded results.
- [Backend](../backend/README.md) and [web](../web/README.md): developer maps and commands.
- [Dependency advisory review](development/dependency-review.md): affected versions, applicability and maintenance recommendations.
- [Synthetic walkthrough](development/synthetic-walkthrough.md): reproduce the screenshot data without private records.
- [Contributing](../CONTRIBUTING.md): correctness, privacy and review expectations.
- [Security](../SECURITY.md): reporting concerns, known dependency advisories and the security model.
- [Third-party notices](../THIRD_PARTY_NOTICES.md): dependency and wrapper licensing.

## Architecture and API contracts

| Document | Questions it answers |
| --- | --- |
| [System overview](architecture/system-overview.md) | Why a modular monolith, and where do the browser, database and workers draw their boundaries? |
| [Identity](architecture/identity-api.md) | How do enrollment, sessions, CSRF, assisted recovery and revocation work? |
| [Households](architecture/household-api.md) | How do membership, roles and last-owner protection interact? |
| [Invitations](architecture/invitation-api.md) | How are single-use capabilities accepted, expired and revoked? |
| [Manual finance](architecture/manual-finance-api.md) | How are money, accounts, transactions, refunds and allocations represented and authorized? |
| [Shared finance](architecture/shared-finance-contract.md) | How do disclosure, exact shares, external repayments and contribution reports differ? |
| [Connected finance](architecture/connected-finance-contract.md) | How does optional provider synchronization remain separate from admitted ledger data? |
| [Categorization](architecture/categorization-contract.md) | How do explicit decisions, rules, provider evidence and optional AI suggestions interact? |
| [Financial Insights](architecture/financial-insights-contract.md) | What do comparisons, recurring evidence, plans and budgets actually mean? |

## Decisions worth reading

1. [Foundation stack](decisions/ADR-0001-foundation-stack.md): boring infrastructure, explicit tradeoffs.
2. [Identity and sessions](decisions/ADR-0002-identity-sessions.md): server-side sessions rather than browser-held bearer tokens.
3. [Household context](decisions/ADR-0003-household-membership-context.md): membership is necessary, not blanket financial access.
4. [Capability invitations](decisions/ADR-0004-capability-household-invitations.md): ownership of a link is a narrowly scoped capability.
5. [Membership lifecycle](decisions/ADR-0005-household-membership-lifecycle.md): concurrency and last-owner safety.
6. [Manual finance](decisions/ADR-0006-manual-finance-contracts.md): exact money and private financial ownership.
7. [Categories and allocations](decisions/ADR-0007-categories-sharing-allocations.md): conservation, deterministic remainders and refund policies.
8. [Connected finance](decisions/ADR-0008-connected-finance.md): durable work and explicit provider uncertainty.
9. [Deterministic categorization](decisions/ADR-0009-deterministic-categorization.md): user authority before automation.
10. [Shared finance](decisions/ADR-0010-shared-finance.md): consented repayment records, not payment execution.
11. [Financial Insights](decisions/ADR-0011-financial-insights.md): current disclosed facts, not forecasts or bank coverage claims.

## Product and operations

- [Terminology](product/terminology.md) and [design direction](product/design-direction.md).
- [Known limits](product/known-limits.md).
- [Deployment boundaries](development/deployment.md), [generic hosted reference](../deploy/README.md) and [backup/recovery reference](../deploy/backup/README.md).

Source, manifests and executable tests are authoritative for exact behavior and versions. A command or reference configuration is not evidence that an operator has safely deployed or restored their own service.
