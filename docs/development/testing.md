# Testing and verification

How to verify HouseSync locally, what the suites target, and the results recorded so far. Use synthetic accounts and amounts. A green build, a healthy probe and an end-to-end browser journey provide different kinds of evidence; none substitutes for security, accessibility, provider or recovery review.

## Run the repository checks

From the repository root after [local setup](local-setup.md):

```sh
make doctor
make setup
make backend-check
make web-check
# Equivalent combined check after setup:
make verify
```

`make backend-check` invokes `sh backend/mvnw -f backend/pom.xml --batch-mode --no-transfer-progress verify`: Spotless, unit tests, package and Failsafe PostgreSQL integration tests. It requires Java 21 and Docker/Testcontainers; the tests manage their own PostgreSQL container, not the development Compose volume. Maven `package` alone does **not** run the Failsafe integration phase. `make web-check` runs `lint`, `typecheck`, `format:check`, Vitest (`npm --prefix web test`) and the production build, using locked packages installed with `make setup`. `make verify` runs both checks. Do not substitute an in-memory database or silently skip failing container tests; report missing prerequisites and separately run checks that remain possible. Do not point tests at real member data or a hosted database.

For a container/proxy smoke in an isolated local project, follow [Docker-first setup](local-setup.md#status-and-prerequisites), including the exported `COMPOSE_PROJECT_NAME`, `DB_PORT`, `SERVER_PORT` and `WEB_PORT` in the same shell. With the stack healthy:

```sh
curl -fsS http://127.0.0.1:58081/actuator/health/readiness
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:58081/api/auth/me
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:58081/api/auth/logout
```

Expect an `UP` readiness JSON, `401` for anonymous identity and `403` for mutation without CSRF. This checks the web-to-backend proxy rather than only nginx's `/` health. A complete grant-gated registration/sign-in exercise, including the host-local operator CLI and real HTTP CSRF/cookies, is in [local setup](local-setup.md); enrollment is never opened by disabling auth. `docker compose --profile app down` retains the project volume; never use `-v` against valued data. A local smoke is not a remotely deployed result.

## What behavior the suites target

Read the actual [backend test sources](../../backend/src/test/), [web test sources](../../web/src/) and [CI configuration](../../.github/workflows/ci.yml) for their current coverage and execution. In particular, check the identity, finance and reporting contracts before modifying a consumer:

| Concern | Useful checks and contract |
| --- | --- |
| Identity and membership | [Identity API](../architecture/identity-api.md): one-time recipient-bound grants, CSRF/cookies, throttling, session revocation, household roles and outsider denial. |
| Exact money and sharing | [Manual finance API](../architecture/manual-finance-api.md), [shared finance contract](../architecture/shared-finance-contract.md): currency/scale rejection, conservation and deterministic rounding, corrections/refunds, party visibility and stale writes. |
| Categorization and connected finance | [Categorization contract](../architecture/categorization-contract.md) and [bank connection contract](../architecture/connected-finance-contract.md): owner-only evidence, explicit review/admission, idempotency, removals, retries and provider-off operation. |
| Persistence and web | Flyway migrations and real PostgreSQL constraints, transaction rollback/concurrency; web loading/error/retry states, focus, keyboard navigation and small-screen reflow. |

Control time, external dependencies and identity with isolated fixtures. Test observable outcomes and relevant failure paths, not implementation wording, source text or mock echoes. Deterministic fake adapters and local HTTP fakes do not establish Plaid production, paid AI quality or webhook delivery. Core suites must not require live banking credentials or paid API calls.

## Recorded results

### Build and test suites

Run on 2026-10-01 on Linux x64 with OpenJDK 21, Docker 29 (Testcontainers PostgreSQL 17) and Node 22.14.0 / npm 10.9.2 selected through Volta (`volta run --node 22.14.0 --npm 10.9.2 make verify`):

| Check | Result |
| --- | --- |
| Backend Spotless, compilation, package | Passed |
| Backend unit tests (Surefire) | 372 passed; no failures, errors or skips |
| PostgreSQL integration tests (Failsafe, 44 classes) | 332 passed; no failures, errors or skips |
| Web lint, TypeScript and Prettier | Passed |
| Web tests (Vitest) | 825 passed across 47 files |
| Web production build | Passed; Vite reports an existing >500 kB chunk advisory |

The same checks run in [CI](../../.github/workflows/ci.yml) on every push, alongside a full-history Gitleaks scan and a Compose build with a web-to-backend proxy check.

### Container runtime and API

A September 2026 run used the documented Docker workflow with a fresh Compose project, unused loopback ports (database 58432, API 58080, web 58081), a new named volume and only `.env.example` values. Observed through the web proxy:

- Readiness `UP`, anonymous identity `401`, unsafe logout without CSRF `403`.
- Operator-issued enrollment, registration `201`, still anonymous after registration, then successful login.
- Same-key account creation replay returned the same account ID.
- An authenticated outsider received household `404`.
- After accepting an invitation, a second member received `404` for another member's private account and transaction but `200` for a shared transaction, with a null `accountId` and no account name.
- That member's attempted correction of the financial owner's shared transaction returned `403`.

### Browser and accessibility

In the same run, Chromium signed in through the real form, navigated to Insights, created a `2400.00 USD` budget target through its review/confirmation UI and displayed the exact remaining `305.95 USD`. The [synthetic walkthrough](synthetic-walkthrough.md) explains the screenshot data. The 390px transaction view and 320px reflow had no page-level horizontal overflow; the filter sheet is a named native dialog that Escape closes, returning focus to **Filters**. axe 4.13.0 reported zero WCAG 2 A/AA violations on desktop Insights and the 390px ledger, and no console or page errors appeared. Real phones, OS keyboards, browser zoom and human screen-reader use remain unverified.

### Backup and restore

The reference backup script encrypted a synthetic PostgreSQL dump and configuration to a disposable age recipient. The dump decrypted and restored into a separate disposable database, where all 42 tables matched exact row counts and canonical-row checksums. Temporary plaintext was removed, and a run with a missing recipient failed closed while preserving the previous success marker. This does not establish off-host transfer, alert delivery, recovery objectives or whole-host recovery.

## Manual review

Exercise a changed journey in a real browser at phone and desktop widths: keyboard-only use, focus and error recovery, text zoom/reflow, accessible names and announcements, and a screen-reader path when making accessibility claims. Automated accessibility results alone do not certify WCAG. Record the actual environment, commands, results and failures for each review.

Before a deployment holds real data, separately demonstrate approved-member enrollment, password change/recovery and revocation, two-member/outsider authorization, HTTPS and restricted management/database exposure, off-host encrypted backup with populated-data restore/reconciliation, a delivered alert, upgrade/recovery and operator review. [Deployment boundaries](deployment.md) and the [backup/restore reference](../../deploy/backup/README.md) describe those requirements; they are not evidence that any were met.
