# Backend developer map

Java 21 / Spring Boot modular monolith backed by PostgreSQL 17. Flyway manages schema and JDBC session tables; Hibernate validates mappings rather than updating schema. HTTP session cookies and CSRF protect writes. Household membership and financial ownership are checked on the server; account reads are scoped in persistence rather than fetched globally and filtered by the web client. See the [system overview](../docs/architecture/system-overview.md) and [engineering cases](../docs/engineering.md).

## Develop and check

From the repository root, start the local database, then run the API:

```sh
make doctor
make db-up
make backend-dev
```

`make db-up` creates a missing root `.env` from `.env.example` and waits for PostgreSQL. `make backend-dev` sources that local environment, binds to loopback by default, and runs `sh backend/mvnw -f backend/pom.xml ... spring-boot:run`; default API port is 8080. This is a development database/credential, **not** a hosting recipe. Standalone Maven does not load `.env`: supply `DB_PASSWORD` and matching database variables yourself; for local plain HTTP set `SESSION_COOKIE_SECURE=false`. For container-only use the isolated instructions in [root README](../README.md) or [local setup](../docs/development/local-setup.md).

```sh
make backend-check
```

This calls wrapper `verify`: format validation, Docker-free unit tests, packaging and Docker-backed PostgreSQL/Testcontainers integration tests. Docker must be available; `package` alone does not execute the PostgreSQL integration suite. For a fast scoped Docker-free check use `sh backend/mvnw -f backend/pom.xml test`. See [testing](../docs/development/testing.md); passing health alone does not demonstrate tenant privacy or money invariants.

## Code and contracts

| Area | Responsibility and entry point |
| --- | --- |
| `src/main/java/com/housesync/identity/` and household packages | Session identity, operator-issued grants, membership, invitations and roles; [identity API](../docs/architecture/identity-api.md), [household API](../docs/architecture/household-api.md). |
| `src/main/java/com/housesync/finance/account/` | Owner-private accounts, household-and-owner-scoped lookup, create replay; [manual finance API](../docs/architecture/manual-finance-api.md). |
| `src/main/java/com/housesync/finance/transaction/` | Exact money, corrections, refunds, disclosure, allocations, derived balances, repayment records. Review [allocation source](src/main/java/com/housesync/finance/transaction/domain/AllocationSharesPolicy.java) and [shared-finance decision](../docs/decisions/ADR-0010-shared-finance.md). |
| `src/main/java/com/housesync/finance/connection/`, `activity/`, `categorization/` | Optional private provider connection/sync/admission and deterministic-first category rules/reviews; [connected-finance contract](../docs/architecture/connected-finance-contract.md), [categorization contract](../docs/architecture/categorization-contract.md). |
| `src/main/resources/db/migration/` | Forward-only versioned schema, ownership constraints, uniqueness, durable work and replay records. |
| `src/test/` | Rule tests and PostgreSQL-backed HTTP/concurrency tests, including [allocation](src/test/java/com/housesync/finance/transaction/FinancialAllocationHttpIT.java) and [sync races](src/test/java/com/housesync/finance/connection/ConnectedFinanceSyncRaceIT.java). |

The backend also serves Insights, budgets and recurring evidence under authorized household context; [financial-insights contract](../docs/architecture/financial-insights-contract.md). Controllers and some web-facing components are large: prefer extracting along concrete use cases when changing them instead of adding speculative infrastructure. Avoid direct JPA entity exposure, cross-household repository access, or browser-authoritative money calculations.

## Local enrollment and boundaries

No sample user or public registration bypass is seeded. An operator issues a recipient-bound, one-time enrollment code through a **separate one-shot process**, then privately hands an `/enroll#code=...` URL to the intended local user. Registration does not sign the person in; they sign in afterward. For the exact local Compose invocation and safe CSRF/cookie flow, use [local setup](../docs/development/local-setup.md); [identity API](../docs/architecture/identity-api.md#operator-cli-boundary) describes the CLI and its hosted-overlay variant. Never expose the operator action through HTTP, log grants or use a real person's data in fixtures.

Connected finance and AI are off by default, require explicitly configured server-side credentials/keys, and are not required for manual/Insights workflows. Fake adapter and sandbox checks are not equivalent to production live-provider approval or complete reconciliation validation. This service records obligations and asserted external repayments; it does not process payments or convert currencies.
