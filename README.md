# HouseSync

[![HouseSync checks](https://github.com/lavinhoque33/HouseSync/actions/workflows/ci.yml/badge.svg)](https://github.com/lavinhoque33/HouseSync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A shared household ledger that keeps private money private.** Each member links their own bank accounts through Plaid or records entries by hand. Accounts and transactions stay private to their owner; a member discloses exactly the entries the household should share, and those are split exactly, tracked as per-member balances and settled through recorded repayments. HouseSync keeps the ledger; it never moves money or infers bank balances.

## Try the live demo

**[demo.hsync.ihoque.com](https://demo.hsync.ihoque.com)**: sign in with these shared demo credentials:

| Email | Password |
| --- | --- |
| `demo@example.com` | `HouseSyncDemo2026!` |

You land in a synthetic two-member household with three months of private and shared manual entries, exact splits, a refund, repayments, budgets, a tracked bill and recurring-charge suggestions. Bank linking is turned off in the demo because it needs Plaid credentials. The demo runs as a separate instance with its own database and no real household data. It resets to that seed every hour (briefly unavailable while it does), so your changes are temporary and other visitors can see them until the reset. Please don't enter real personal information. Accounts are operator-issued, so the demo has no sign-up form.

![Bank activity inbox on desktop: history synced from a linked Plaid Sandbox bank waits in the owner's private inbox, each item confirmed or dismissed before it reaches the ledger](docs/images/bank-activity-desktop.png)

<img src="docs/images/household-feed-mobile.png" alt="Household feed on mobile: one member's shared manual entries and another member's shared bank-sourced entry, allocated and categorized, without account details" width="320" align="right">

Above: three months of history synced from a linked test bank into the owner's private inbox, part already confirmed into the ledger and part still awaiting review. Right: the household feed on a phone, where one member's manual entries and the other's bank-sourced entry appear side by side with their allocations.

The screenshots come from a local instance with two synthetic members. One linked Plaid's Sandbox test bank (`First Platypus Bank`) through the real Plaid Link flow and confirmed its generated history; the other recorded manual entries. The [walkthrough](docs/development/synthetic-walkthrough.md) reproduces them.

**Stack:** Java 21 · Spring Boot 4.1 · PostgreSQL 17 · Flyway · React 19 · TypeScript · Vite · Vitest · Testcontainers · Docker Compose.

<br clear="right">

<details>
<summary><strong>More screenshots</strong> (14): bank linking, review into the ledger, balances and settlement, Insights, mobile</summary>

#### Link a bank and admit accounts

![Plaid Link opened from the Bank connections page, at the institution selection step, with Plaid's Sandbox banner](docs/images/plaid-link-desktop.png)

![Bank connections page: a Sandbox connection with the account list, three accounts admitted and unsupported account types marked not eligible](docs/images/connections-desktop.png)

![Bank activity inbox with a confirm form open: entry type, description and category chosen by the owner before the item is added to the ledger](docs/images/bank-activity-confirm-desktop.png)

#### Private ledger and household feed

![Transactions page showing the owner's private entries sourced from the linked checking and credit card accounts](docs/images/transactions-desktop.png)

![Household feed on desktop: shared entries from both members, with Household, Allocated and category chips; another member's entries show no account details](docs/images/household-feed-desktop.png)

![Accounts page listing three connected accounts marked private, and the form to add a manual account](docs/images/accounts-desktop.png)

#### Balances, settlement and repayments

![Balances page: per-currency member balances derived from allocations and confirmed repayments, and a read-only settlement plan](docs/images/balances-desktop.png)

![Repayments page: the form to assert a payment completed outside HouseSync, a pending record and a confirmed one](docs/images/repayments-desktop.png)

#### Insights

![Insights overview comparing September with August 2026: net spending, expenses, refunds and separate income, with category and description-group drivers and the monthly budget](docs/images/insights-desktop.png)

![Monthly net spending trend over the last twelve months](docs/images/insights-trend-desktop.png)

![Possible recurring expenses detected from shared entries, with occurrence counts, amount ranges and the next expected slot](docs/images/insights-recurring-desktop.png)

#### Mobile (390 CSS px)

<p>
<img src="docs/images/transactions-mobile.png" alt="Private transactions on mobile, sourced from the linked bank" width="260">
<img src="docs/images/balances-mobile.png" alt="Member balances on mobile" width="260">
<img src="docs/images/insights-mobile.png" alt="Insights overview on mobile" width="260">
</p>

</details>

## Capabilities

| Area | What it does | Boundary |
| --- | --- | --- |
| Connected finance | Plaid Link in the browser, server-side token exchange, owner-chosen account admission, durable cursor-based transaction sync with webhooks, and an owner-private inbox where every synced item is confirmed or dismissed before it enters the ledger. | Off by default; needs your own Plaid credentials. Verified against Plaid Sandbox and a local fake only; live bank-initiated changes are unverified. |
| Manual finance | Private accounts, exact signed transactions in seven currencies, corrections and voids, linked refunds, transfers. | No automatic currency conversion; amounts in different currencies are never summed. |
| Shared finance | Explicit per-transaction disclosure, equal or exact unequal allocations, cumulative refund apportionment, per-currency member balances, consented external repayment records, settlement suggestions, period contributions. | Repayments are records of money moved elsewhere; HouseSync never executes payments. |
| Categorization | Owner-private exact-match rules, provider-category mapping, provenance, review queue; explicit user decisions always win. | Optional AI suggestions are off by default and never write to the ledger. |
| Insights | Month-over-month comparisons by category and merchant, recurring-expense detection, household bill/subscription plans, monthly budgets, one coherent summary with evidence links. | Suggestions are not verified bills; budgets reserve nothing; no forecasts. |
| Identity and households | Server-side sessions and CSRF, operator-issued enrollment, assisted recovery, invitations, membership and role lifecycle with last-owner protection. | No public self-service signup or email-ownership proof. |

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

### Link a bank with Plaid Sandbox

Bank linking is off until you supply your own Plaid credentials; Sandbox is free and uses Plaid's generated test banks. Generate a token-encryption key with `openssl rand -base64 32`, then set in `.env` (Compose reads it literally, so paste the value):

```sh
CONNECTED_FINANCE_ENABLED=true
PLAID_ENV=sandbox
PLAID_CLIENT_ID=<your Plaid client id>
PLAID_SECRET=<your Plaid Sandbox secret>
CONNECTED_FINANCE_KEYS=local:<the base64 key>
```

Recreate the backend with `docker compose --profile app up -d --wait backend`; it fails closed at startup if the credentials or key are invalid. Then, in a household, open **Bank connections → Link a bank**, search for `First Platypus Bank` and sign in with Plaid's Sandbox credentials `user_good` / `pass_good`. Choose which accounts to admit; synced history appears under **Bank activity**, where each item is confirmed into your private ledger or dismissed. With connected finance enabled, the browser loads Plaid Link from `cdn.plaid.com` (it runs in its own iframe and talks to Plaid) and the backend calls `sandbox.plaid.com`; HouseSync contacts no other external service.

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
