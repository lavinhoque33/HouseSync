# HouseSync

[![HouseSync checks](https://github.com/lavinhoque33/HouseSync/actions/workflows/ci.yml/badge.svg)](https://github.com/lavinhoque33/HouseSync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Understand shared spending without making every account shared.** HouseSync is a mobile-first household finance application. Members record private financial activity, deliberately disclose selected transactions, split shared expenses exactly, and explore source-linked spending insights. A household owner does not automatically see another member's accounts. HouseSync records external repayments and suggests settlements; it does **not** move money or infer bank balances.

![Insights on desktop: month-over-month overview with category and merchant drivers](docs/images/insights-desktop.png)

<img src="docs/images/transactions-mobile.png" alt="Mobile ledger showing explicit household sharing and a private synthetic expense" width="320" align="right">

The screenshots come from a local instance populated with synthetic records through the normal UI and API; the [walkthrough](docs/development/synthetic-walkthrough.md) reproduces them.

**Stack:** Java 21 · Spring Boot 4.1 · PostgreSQL 17 · Flyway · React 19 · TypeScript · Vite · Vitest · Testcontainers · Docker Compose.

<br clear="right">

## Capabilities

| Area | What it does | Boundary |
| --- | --- | --- |
| Identity and households | Server-side sessions and CSRF, operator-issued enrollment, assisted recovery, invitations, membership and role lifecycle with last-owner protection. | No public self-service signup or email-ownership proof. |
| Manual finance | Private accounts, exact signed transactions in seven currencies, corrections and voids, linked refunds, transfers. | No automatic currency conversion; amounts in different currencies are never summed. |
| Shared finance | Explicit per-transaction disclosure, equal or exact unequal allocations, cumulative refund apportionment, per-currency member balances, consented external repayment records, settlement suggestions, period contributions. | Repayments are records of money moved elsewhere; HouseSync never executes payments. |
| Categorization | Owner-private exact-match rules, provider-category mapping, provenance, review queue; explicit user decisions always win. | Optional AI suggestions are off by default and never write to the ledger. |
| Insights | Month-over-month comparisons by category and merchant, recurring-expense detection, household bill/subscription plans, monthly budgets, one coherent summary with evidence links. | Suggestions are not verified bills; budgets reserve nothing; no forecasts. |
| Connected finance | Plaid adapter with account linking, durable cursor-based sync and owner-reviewed admission into the ledger. | Optional, off by default. Fake and sandbox coverage only; live bank-initiated changes are unverified. |

See [known limits](docs/product/known-limits.md) for what is deliberately out of scope or not yet validated.

## Architecture

```text
Browser (React / TypeScript / Vite)
       │ same-origin session cookie + CSRF
       ▼
nginx (or Vite dev proxy) ── /api, /actuator ──► Spring Boot modular monolith
                                                 ├─ identity + households
                                                 ├─ accounts + transactions + allocations
                                                 ├─ repayments + settlement + reports
                                                 ├─ categorization + Insights
                                                 └─ optional provider adapters / leased workers
                                                              │
                                                        PostgreSQL 17
                                             (Flyway, sessions, ledger, idempotency, work queues)
```

The backend decides access and money; the web client renders authorized views and helps users recover from uncertain writes. Account ownership, household membership and transaction disclosure are separate checks enforced in SQL. Provider records enter an owner-private review inbox before confirmation into the ledger. Details: [system overview](docs/architecture/system-overview.md), [API contracts and decisions](docs/index.md).

## Quick start (Docker)

Requires Docker with Compose v2 and Buildx. An isolated Compose project and non-default loopback ports avoid clashing with anything else on the machine:

```sh
test -e .env || cp .env.example .env
export COMPOSE_PROJECT_NAME=housesync_showcase DB_PORT=58432 SERVER_PORT=58080 WEB_PORT=58081
docker compose --profile app up --build -d --wait --wait-timeout 180
```

No account exists yet. Registration requires a recipient-bound, single-use enrollment code issued by a host-local operator command:

```sh
docker compose --profile app exec -T backend java -jar /app/app.jar \
  --spring.main.web-application-type=none --spring.main.banner-mode=off --logging.level.root=OFF \
  --app.operator.action=issue-enrollment --app.operator.email=person@example.test
```

Open `http://127.0.0.1:58081/enroll#code=<code>`, register as `person@example.test`, then sign in. Stop with `docker compose --profile app down` (data is retained in the project volume). All ports bind to `127.0.0.1`; the `.env.example` credentials are disposable development defaults.

For native development (Java 21, Node 22.13+, npm 10.9.2+, Docker, GNU Make): `make doctor`, `make setup`, `make db-up`, then `make backend-dev` and `make web-dev` in separate terminals and open <http://localhost:5173>. See [local setup](docs/development/local-setup.md) and the [operator CLI](docs/architecture/identity-api.md#operator-cli-boundary).

## Engineering highlights

- [Exact splits and cumulative refunds](docs/engineering.md#exact-money-and-refunds): integer minor units, deterministic remainders, a persisted refund policy, conservation under partial refunds.
- [Privacy as a query boundary](docs/engineering.md#privacy-is-a-query-boundary): membership plus financial ownership enforced in SQL, not hidden web controls.
- [Replay, workers and uncertain writes](docs/engineering.md#replay-workers-and-uncertain-writes): durable idempotency, lease fencing for provider and AI work, same-key retry after an unknown response.
- [Architecture decision records](docs/index.md#decisions-worth-reading): eleven ADRs covering the stack, sessions, invitations, money, sharing, connected finance, categorization and Insights.

## Verification

```sh
make verify   # = make backend-check + make web-check
```

`make backend-check` runs Spotless, unit tests and PostgreSQL integration tests through Testcontainers (no in-memory database). `make web-check` runs ESLint, TypeScript, Prettier, Vitest and the production build. CI runs both, a full-history secret scan, and a Compose build with a web-to-backend proxy check. Results and what they do not cover: [testing](docs/development/testing.md).

## Project documents

[Documentation index](docs/index.md) · [Known limits](docs/product/known-limits.md) · [Deployment boundaries](docs/development/deployment.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Source availability is not an invitation to use a hosted financial service; see [SECURITY.md](SECURITY.md) for known dependency advisories before deploying. HouseSync's first-party source is licensed under [MIT](LICENSE).
