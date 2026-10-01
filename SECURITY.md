# Security

HouseSync handles financial information. Public source availability does not make a running household service public, authorize testing someone else's deployment, or certify production readiness.

## Report a concern safely

Do not open a public issue containing credentials, cookies, invitation/enrollment/recovery codes, private records, database dumps or an unredacted exploit trace. Use GitHub's private vulnerability reporting for this repository when enabled. If no private reporting channel is available, ask the maintainer for one without disclosing the sensitive details publicly. No response-time or supported-version service agreement is promised.

Reproduce against an isolated local instance with synthetic accounts and data. Do not contact real providers or attempt access to other members' records without explicit authorization.

## Known dependency advisories

The current dependency baseline matches published upstream advisories. Passing tests are not a vulnerability clearance; read the [advisory review](docs/development/dependency-review.md) before operating an internet-facing instance.

| Component | Version | Advisories | Fixed in | Applicability |
| --- | --- | --- | --- | --- |
| Apache Tomcat (embedded) | 11.0.24 | Multiple, including CVE-2026-77756 (HTTP/1.0 request parsing) | 11.0.26 | The parser issue affects the installed version. The reference nginx hop uses HTTP/1.1, but loopback and Compose-network callers reach the backend directly. Other reviewed issues concern features HouseSync does not configure (AJP, WebSockets, HTTP/2 by default, container authentication). |
| Jackson Databind | 3.1.5 | GHSA-gx83-3vf8-gh7j, GHSA-q4xh-88c3-wmh7, GHSA-wjgm-6hv5-3cvf | 3.1.6 | Each requires an untrusted binding target that source review did not find. |

Upgrade to a compatible Spring Boot maintenance release or aligned overrides covering Tomcat 11.0.26+ and Jackson 3.1.6+, then rerun `make verify` and the container smoke checks.

## Security model

- Server-side sessions and CSRF protection; operator-issued enrollment is separate from household invitations.
- Current household membership plus financial ownership/resource visibility enforced by backend services and scoped queries.
- Exact financial representations, durable idempotency and explicit stale/uncertain-outcome recovery.
- Provider credentials remain server-side. Connected finance and AI are off by default; AI suggestions do not assign money or access rights.
- Local environment examples use disposable development credentials and loopback HTTP. They are not deployment secrets or internet-facing defaults.

Read the [identity contract](docs/architecture/identity-api.md), [engineering decisions](docs/engineering.md) and [known limits](docs/product/known-limits.md). Review hosted configuration, TLS/cookies, retention, backups, recovery and abuse controls for your own environment before deploying.

## Repository hygiene

Never commit real environment files, provider tokens, private keys, account data, screenshots of real records or generated operational logs. Synthetic test fixtures are intentionally retained and allow-listed in [`.gitleaks.toml`](.gitleaks.toml); CI scans the complete history on every push. Secret scanning is defense in depth: a clean scanner result is not proof that a file contains no personal or operational information. Rotate an accidentally exposed credential; deleting its latest occurrence does not remove Git history.
