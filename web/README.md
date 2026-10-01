# Web developer map

The responsive React/TypeScript/Vite client covers identity, household membership, private and deliberately shared finance, connected-finance review, categorization and Insights. It is a client of the [API contracts](../docs/index.md), **not** an authority for money or household permissions. An owner cannot see another member’s private account merely because the UI offers household views.

## Develop and check

From the repository root, use [local setup](../docs/development/local-setup.md) to bring up PostgreSQL and the backend, then start the web proxy:

```sh
make setup
make db-up
make backend-dev  # separate terminal
make web-dev      # separate terminal
```

Open <http://localhost:5173>. `make setup` creates a missing development `.env` and performs `npm ci` against the committed lockfile; Node 22 >=22.13 and npm 10 >=10.9.2 are needed for native development. `make web-dev` loads the root environment and sets the Vite proxy to the configured native backend port. Direct `npm --prefix web run dev` does not perform that Make environment wiring. For Docker-only startup and operator-gated enrollment, use the isolated [root quick start](../README.md#quick-start-docker).

```sh
make web-check
```

That target runs lint, TypeScript, Prettier check, Vitest and production build; individual scripts can run from `web/` as `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build`. `npm run test:watch` is available when iterating. `dist/` is generated, not source. `make verify` adds the backend's Docker-backed PostgreSQL integration suite.

## UI and API boundaries

| Area                                | What to inspect                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                       | URL navigation, history/popstate, focus transfer and reduced-motion-aware transitions.                                                                                                                                                                                 |
| `src/auth/`                         | Session/CSRF bootstrap, operator-link enrollment and recovery, foreground/background request ownership; [identity API](../docs/architecture/identity-api.md).                                                                                                          |
| `src/household/`, `src/invitation/` | Directory, invitations, role/membership and active household; [household API](../docs/architecture/household-api.md).                                                                                                                                                  |
| `src/finance/`                      | Exact decimal-string inputs, account/transaction privacy, refunds, allocation, bank activity and categorization actions; [manual finance API](../docs/architecture/manual-finance-api.md) and [shared-finance decision](../docs/decisions/ADR-0010-shared-finance.md). |
| Insights views under `src/`         | Source-linked posted/shared spending, plans, budgets and recurring suggestions; [Insights contract](../docs/architecture/financial-insights-contract.md).                                                                                                              |

Browser requests use same-origin cookie credentials and CSRF; the dev server forwards `/api` and `/actuator` to the backend. The health indicator is a startup snapshot, not a service-level monitor. Web storage does not contain credentials, CSRF, grant codes or financial drafts. An uncertain write keeps its key and request **in memory** for explicit same-key retry while the page remains open; after reload, that recovery key is gone and the client must not pretend it can replay the original intent. Version conflicts refresh authoritative server state while preserving safe user input. [AuthSection tests](src/auth/AuthSection.test.tsx) cover stale-request ownership; [BankActivitySection tests](src/finance/BankActivitySection.test.tsx) cover uncertain writes and review. Some complex finance components remain large; change their existing recovery paths deliberately rather than replacing them with optimistic success banners.

The client has keyboard/focus and responsive interaction tests, but that does not certify WCAG conformance or a full screen-reader review. Connected finance and AI require separate server-side opt-in; neither is needed for manual and shared workflows. The app shows suggested obligations, **not** bank balances or executed payments. See [engineering decisions](../docs/engineering.md) and [known limits](../docs/product/known-limits.md).
