# ADR 0001 — Foundation stack and modular monorepo

- **Status:** Accepted; stack implemented.
- **Scope:** Repository/runtime foundation.
- **References:** [system overview](../architecture/system-overview.md); [local setup](../development/local-setup.md).

## Context

HouseSync needs a serious Java backend and a polished mobile-first web client that evolve together.
The manual-finance domain must be validated before bank synchronization, and financial/privacy rules
must remain reusable by a future Android client. The initial build benefits from simple local operations,
reproducible checks, and one integrated deployment boundary rather than distributed infrastructure.

The selected stack is:

## Decision

| Concern | Selected baseline |
| --- | --- |
| Backend runtime/build | Java 21; checked-in Maven wrapper, invoked through `sh` |
| Backend framework | Stable Spring Boot compatible with Java 21, pinned in `backend/pom.xml` |
| Backend shape | One modular monolith, REST-oriented DTO boundaries, domain-owned business rules and authorization |
| Browser client | React + TypeScript + Vite, responsive mobile-first web |
| JavaScript runtime/build | Node 22, at least 22.13; npm >=10.9.2 <11 with committed lockfile and repository-local tooling |
| Database | PostgreSQL 17; Flyway versioned migrations and PostgreSQL integration checks |
| Repository | `backend/`, `web/`, `docs/`, `infrastructure/`; root operational scripts and Compose |
| Local runtime | Native backend/web against containerized PostgreSQL; optional all-container `app` profile |
| CI | Independent Java 21 backend and Node 22 web jobs on Ubuntu 24.04; dependent container build/startup/proxy checks |

Exact Maven, Spring Boot, library, plugin, formatter, npm, and image patch versions are maintained in
their implementation manifests/configuration. The backend uses Flyway, PostgreSQL Testcontainers,
Maven Failsafe, and Spotless; the web uses Vitest, ESLint, TypeScript checks, and Prettier.
See [testing](../development/testing.md) for reproducible checks.

Domain packages are introduced with the features that need them. The choice of a modular monolith does not mandate
an interface for every class, an elaborate module framework, or packages for unimplemented future domains.

## Rationale

- Java 21 provides a stable baseline for a backend whose value lies in domain correctness and integration reliability.
- Spring Boot centralizes application configuration and operations within one service.
- React/TypeScript/Vite supports fast, typed, mobile-first UI delivery without requiring server-side rendering.
- PostgreSQL supports transactional invariants and a realistic local/CI persistence environment.
- Maven wrapper and npm lockfile reduce tool-version drift and avoid global Maven/frontend tool requirements.
- One repository makes API/client changes, tests, and documentation reviewable as coherent units.
- Database-only default Compose keeps native development light; the `app` profile exercises container integration.

## Consequences

- Backend checks that exercise containerized PostgreSQL require working Docker access; missing Docker is a blocked
  check, not grounds for disabling it or claiming success from unit tests alone.
- Native development requires Java 21 and Node 22 in addition to Docker and Make; container application startup
  is a separate workflow with its own build/startup evidence.
- Client and backend must coordinate DTO money/date/error contracts. The web never becomes the authoritative
  source of financial or authorization rules.
- Compose service names and native `localhost` settings differ and must be tested through both routing paths.
- Root native targets load `.env`; Vite permits `API_PROXY_TARGET` override before deriving a target from
  `SERVER_PORT`. Compose maps that host port to fixed backend port 8080; nginx always uses `backend:8080`.
- CI configuration describes checks; only an actual run establishes their result.

## Alternatives and deferred choices

- **Microservices, queues, caches:** deferred until a concrete reliability/scale requirement justifies them.
- **Android:** not implemented; a native client would need the same backend authorization and
  exact-money boundaries.
- **Public Android distribution:** requires its own release and operational assessment.
- **Banking and AI providers:** adapter paths now exist, but provider configuration and
  live suitability are distinct from a local runtime.
- **Global Maven/frontend installations:** unnecessary; wrapper and local scripts define the build workflow.
- **Authentication/session model:** selected in [ADR 0002](ADR-0002-identity-sessions.md).


Revisit this decision when runtime support, measured operating needs, or validated product requirements
change materially. Record a superseding ADR for a consequential change instead of rewriting history.
