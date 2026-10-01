# ADR 0002 — First-party identity and server-side browser sessions

- **Status:** Accepted; enrollment, recovery and session controls implemented.
- **Scope:** Operator-gated enrollment/recovery, sign-in, CSRF, password change and account-wide session revocation.
- **Related:** [API contract](../architecture/identity-api.md), [known limits](../product/known-limits.md).

## Context and alternatives

Identity must work in native development, Compose, and isolated PostgreSQL tests.
No external identity provider, client credentials, email-delivery service, or public deployment is configured.
HouseSync's Java backend owns identity and later household authorization; clients do not own access decisions.

Managed OpenID Connect would outsource password storage, recovery, verification, and possibly MFA. It
also requires provider selection, client/redirect configuration, and an operational dependency for contributors.
Application-owned credentials keep the application independently runnable but require ongoing password,
abuse-prevention, recovery, and session-security maintenance. This is a deliberate tradeoff, not a claim that
custom identity is inherently safer. Revisit managed OIDC before public launch if its operational benefits win.

## Decision

Use first-party email/password accounts with **Spring Session JDBC in PostgreSQL** and a server-side
Spring Security context. Flyway owns both identity and session tables; automatic session-schema initialization
is disabled. Household membership and financial permissions will be checked against current backend data,
not copied into long-lived session authorities.

- Canonical user identity is a generated UUID. The initial login identifier is a case-insensitive ASCII email,
  trimmed/lowercased using a locale-independent policy, at most 254 characters, and unique in PostgreSQL.
- Passwords are not trimmed or normalized. Require at least **15 Unicode code points**, at most **72 UTF-8
  bytes**, and no NUL; allow spaces and punctuation. Use Spring's delegating password encoder with bcrypt
  cost 12. Reject overlength input rather than accepting bcrypt truncation. Never return or log a hash/password.
- Registration returns a safe user DTO but **does not sign the user in**. An authorized operator issues
  recipient-bound one-time 24-hour enrollment grants via the host-local Docker CLI; an anonymous
  public self-registration path is no longer available. The bearer secret is 32 cryptographic random
  bytes (43 base64url characters); PostgreSQL stores only its SHA-256 digest. Grant issue, revoke and
  consume are audited without secret or password. A duplicate account cannot receive a new enrollment grant.
- Password authentication uses Spring's authentication manager/provider, including dummy-hash work for
  unknown identifiers. Unknown-user and incorrect-password failures return the same 401 code/message.
- On successful JSON login, invoke session-fixation and CSRF authentication strategies **before** explicitly
  saving the new SecurityContext to the session repository. No credentials or bearer tokens go into browser storage.
- Sessions have a **30-minute sliding idle timeout** and an additional **30-day absolute lifetime**
  enforced using the persisted creation timestamp, including pre-upgrade sessions. No remember-me;
  session cookie is browser-only. Password change, recovery, explicit revoke and operator disable
  increment a per-account `BIGINT` session generation atomically with the account mutation and JDBC
  session deletion. Before authorization, each restored authenticated principal must match the current
  enabled account and generation; a login persisted after deletion with an old generation is rejected.
  The serialized principal retains its serial UID; pre-migration sessions deserialize generation zero
  and remain valid until idle/absolute expiry unless revoked.
- Configure an explicit session cookie: `SESSION`, path `/`, HttpOnly, SameSite=Lax, no Domain attribute.
  `SESSION_COOKIE_SECURE` defaults to true in the backend. Native Make development and local Compose explicitly
  supply false for HTTP; production must use HTTPS and Secure cookies, with deliberately trusted proxy handling.
- Use a session-backed CSRF token repository. `GET /api/auth/csrf` returns the token and header name to the SPA;
  the client keeps it in memory and supplies it on unsafe requests. Preserve Spring's XOR/BREACH handling:
  return the exposed request token and use its returned header name. All POSTs, including register/login/logout,
  require CSRF. Fetch a new token after login/logout and after an invalid-token response; do not blindly replay writes.
- Use same-origin browser requests through Vite/nginx. Do not enable wildcard or credentialed cross-origin CORS.
  The public CSRF endpoint does not make its response readable to foreign origins under browser same-origin policy.
- Apply bounded **single-process throttling** to registration and login: 30 attempts per source address per minute,
  plus 10 login attempts per canonical identifier per 10 minutes. Count attempts before password work, bound
  retained keys (10,000), expire entries, return 429 + `Retry-After`, and test using an injectable clock.
  Do not trust arbitrary forwarded headers. Behind the current proxy address-level limits can be shared by users;
  a trusted-edge/distributed policy is required before a public multi-instance deployment.
- Authentication endpoints have explicit method/path rules; all other unimplemented routes remain denied.
  Return JSON 401/403 responses instead of redirects or generated login pages. Health probes remain public.

## Recovery, departure and remaining limits

Recovery is operator-assisted without cost or mailbox proof: the operator verifies the
recipient out of band, then issues a recipient-bound 24-hour one-use recovery grant to an existing
account through the host-local CLI. Wrong, expired, revoked, already-used and recipient-mismatched
codes return the same generic 403 outcome. Recovery cannot be requested by an anonymous email-only
API. The user enters email with the fragment-only link secret; neither web server nor proxy receives
the fragment on navigation. Changing a password requires the current password. Both mutations revoke
all browser sessions; the client signs in again. Household data remain owned by stable UUIDs upon
departure: owner-authorized household role transfer and removal of **all** memberships
(including `MEMBER`) happens before the operator disables account access. The CLI refuses to disable
an account with any remaining membership; household creation, invitation acceptance and owner
promotion lock the affected user row and require it to be enabled, so a request already in flight
cannot leave a disabled member or create a disabled sole owner after disablement commits.
Infrastructure operator access never grants household ownership or deletes historical records.
This is suitable for a small private deployment, **not public-ready identity**: mailbox verification,
MFA/passkeys and trusted-edge/distributed throttling are outside the current scope.

Future Android should reuse backend identity/domain capabilities. Its credential/token transport needs a
separate threat model; this ADR does not prescribe copying the browser's CSRF/cookie flow into Android.
If OIDC is later adopted, map provider identities to the stable user UUID rather than coupling households to
provider subjects or email addresses. Do not build speculative dual-login adapters now.

## Verification

The [API contract](../architecture/identity-api.md) defines statuses, payloads and UI recovery. Tests cover
PostgreSQL migration and uniqueness, registration without authentication, fixation rotation, context persistence
across requests/restart, no-CSRF/invalid-CSRF denial, same user after reload, logout and expired-session denial,
safe generic login failures, cookie flags, password boundaries, and bounded throttling, plus keyboard/mobile
forms and native/container flows.

## References

- [Spring Security session management](https://docs.spring.io/spring-security/reference/servlet/authentication/session-management.html)
- [SecurityContext persistence](https://docs.spring.io/spring-security/reference/servlet/authentication/persistence.html)
- [CSRF protection](https://docs.spring.io/spring-security/reference/servlet/exploits/csrf.html)
- [Password storage](https://docs.spring.io/spring-security/reference/features/authentication/password-storage.html)
- [Spring Session JDBC](https://docs.spring.io/spring-session/reference/configuration/jdbc.html)
- [Spring Boot session configuration](https://docs.spring.io/spring-boot/reference/web/spring-session.html)
