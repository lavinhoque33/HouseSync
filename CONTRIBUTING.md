# Contributing

HouseSync is a personal project, not an open signup or deployed financial service. Issues and focused pull requests are welcome. A contribution should identify its actual authors and evidence honestly.

## Make a focused change

1. Start with the [architecture overview](docs/architecture/system-overview.md), [engineering cases](docs/engineering.md), relevant [API contract/ADR](docs/index.md), and [local setup](docs/development/local-setup.md). Define the behavior, boundary and failure state before changing a contract.
2. Keep financial arithmetic exact and currency-explicit; do not use JS floating point for money. Enforce authorization in backend service/repository queries for current household membership, resource ownership and disclosure, including aggregate/count endpoints. A web control is not a security boundary.
3. Preserve idempotency keys for an unknown write outcome, respect version conflicts, and update migration/API/client behavior together. Add a forward migration rather than editing an applied migration. Do not add speculative distributed infrastructure.
4. Add deterministic tests for changed money, privacy or retry invariants using PostgreSQL where database semantics matter. Prefer observable behavior and adverse cases to copied DTO/wiring tests. Describe any test or provider check not exercised rather than presenting it as passed.
5. Update the relevant contract and developer instructions for material behavior or command changes. Keep examples fictional and avoid private operational details.

## Check and report

With Java 21, Node 22, npm 10 and Docker available, run `make doctor`, `make backend-check`, `make web-check` (or `make verify` for both). Backend verification uses Docker-backed PostgreSQL integration tests; web checks include lint, typecheck, formatting, Vitest and build. See [testing](docs/development/testing.md) and [backend](backend/README.md)/[web](web/README.md) maps. In a contribution, state **exact commands and outcomes**, plus any unrun checks or environment limitations. Never claim real-provider validation merely because source/test files exist.

## Security and privacy

Do not commit `.env`, passwords, enrollment/recovery codes, provider tokens, real member records, screenshots containing personal data, local database volumes or generated artifacts. Use development-only examples. Keep operator-grant issuance separate from public HTTP and do not bypass enrollment to make a demo easy. Do not log raw financial payloads or copy real transactions into an issue. Report a suspected vulnerability privately as described in [SECURITY.md](SECURITY.md). The MIT license grants no access to any running instance and is not approval to operate a public financial service.
