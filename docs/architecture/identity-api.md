# Identity API

**Status:** Session identity, operator-issued enrollment/recovery grants and account-wide
session revocation are implemented. Hosted operation is not established by this contract.
See [ADR 0002](../decisions/ADR-0002-identity-sessions.md).
All API responses use JSON except 204 logout. Browser fetches are same-origin with credentials included.
Identity/CSRF responses and errors are not cacheable. Authentication is session-based; no JWT/localStorage tokens.

Enrollment and recovery require operator-issued, recipient-bound one-time 24-hour links.
Email is an unverified login identifier; neither link is issued on the authority of
an unverified email request.
Sessions retain a 30-minute idle timeout and additionally end 30 days after creation (including sessions
created before rollout). Password change, recovery, explicit revoke and account disablement atomically
advance the account's session generation and delete existing sessions. Every restored authenticated
principal is checked against current generation and account enablement before protected authorization;
even a concurrent login persisted after deletion cannot regain access with its pre-revocation generation.
Sessions persisted before the generation column existed deserialize at generation zero and remain usable until
expiry unless the account is subsequently revoked. Any hosted edge access control is an
operational deployment decision, not a substitute for backend enrollment control.

## Endpoints

| Method/path | Request | Success | Other outcomes |
| --- | --- | --- | --- |
| `GET /api/auth/csrf` | None | 200 `{"token":"...","headerName":"X-CSRF-TOKEN"}`; materializes anonymous session if needed | 429 session-creation budget exhausted (see below), 5xx safe failure |
| `POST /api/auth/register` | `{"email":"person@example.test","password":"...","enrollmentCode":"43-character-base64url"}` + CSRF | 201 safe user; does not authenticate | 403 `ENROLLMENT_INVALID` for absent/expired/replayed/mismatched code; 400 password validation, 409 duplicate, 403 CSRF, 429 throttle |
| `POST /api/auth/recover` | `{"email":"person@example.test","recoveryCode":"...","newPassword":"..."}` + CSRF | 204, all sessions revoked | 403 `RECOVERY_INVALID` for absent/expired/replayed/mismatched code; 400 password validation, 403 CSRF, 429 throttle |
| `POST /api/auth/password` | `{"currentPassword":"...","newPassword":"..."}` + authenticated session/CSRF | 204, all sessions revoked including current | 401 wrong current password, 400 new password validation, 403 CSRF |
| `POST /api/auth/sessions/revoke` | Authenticated session/CSRF; no body | 204, all sessions revoked including current | 401 unauthenticated, 403 CSRF |
| `POST /api/auth/login` | `{"email":"...","password":"..."}` + CSRF header | 200 safe user DTO and rotated session cookie | 400 malformed/invalid shape, 401 generic credentials failure, 403 CSRF, 429 throttle |
| `GET /api/auth/me` | Session cookie | 200 safe user DTO | 401 missing/expired/revoked identity |
| `POST /api/auth/logout` | CSRF header and session cookie; no body required | 204; session invalidated and cookie cleared; safe for an already-anonymous valid-CSRF session | 403 missing/invalid CSRF |

`id` is an opaque UUID string and email is canonical ASCII lowercase. Password/hash/session internals are never
part of the user DTO. JSON endpoint validation rejects missing/unknown fields and unsupported media types with
safe errors. Registration follows ADR password policy; login accepts nonempty password input up to 72 UTF-8 bytes
without enforcing the new-password minimum, so failure semantics are stable for existing credentials.

## Errors

```json
{
  "code": "VALIDATION_FAILED",
  "message": "Check the supplied details.",
  "correlationId": "opaque-request-id",
  "fieldErrors": {"email": "Enter a valid email address."}
}
```

`fieldErrors` is optional and contains safe messages keyed only by known form fields. Stable codes:
`VALIDATION_FAILED` (400/415), `INVALID_CREDENTIALS` (401), `UNAUTHENTICATED` (401), `CSRF_INVALID` (403),
`ENROLLMENT_INVALID` (403), `RECOVERY_INVALID` (403), `FORBIDDEN` (403),
`REGISTRATION_CONFLICT` (409), `RATE_LIMITED` (429), and `INTERNAL_ERROR` (500).
Malformed JSON and unsupported request shape/content type receive safe 400/415 errors; include a correlation ID
without echoing submitted fields, SQL, stack traces or credentials. Login failure message is identical for
unknown identifiers and incorrect passwords. A 429 includes an integer-seconds `Retry-After` header.

Throttling is process-local and runs before any password hashing. Registration, login, and recovery share one
budget of 30 attempts per client address per 60 seconds; every attempt counts. Login additionally allows 10
failed attempts per canonical email per 600 seconds: a slot is reserved before authentication (so concurrent
guesses cannot overshoot) and returned when the credentials verify, so successful sign-ins never consume it.
The client address is attributed hop by hop. The web nginx trusts `X-Forwarded-For` only from loopback and
private Docker ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), resolves the rightmost untrusted
address with `real_ip_recursive`, and overwrites `X-Forwarded-For`/`X-Real-IP` with that single client address.
The backend (`server.forward-headers-strategy: native`, `server.tomcat.remoteip.internal-proxies`) applies the
forwarded address only when its direct peer is in the same trusted set; a direct untrusted peer's forwarded
headers are ignored. In the hosted overlay, Caddy replaces client-supplied forwarded headers before nginx.
Processes on the host itself can reach the loopback-published web/backend ports through the Docker bridge, and
anything attached to the Compose network reaches them directly; both are therefore trusted to assert any client
address. `X-Forwarded-Proto` never changes the session cookie's `Secure` attribute, which
`SESSION_COOKIE_SECURE` sets explicitly.

Anonymous session creation has its own per-address budget (`app.auth.session-max-creations`, default 30 per
`app.auth.session-window-seconds`, default 600), because every new session is a persisted `SPRING_SESSION` row
that lives until its 30-minute idle timeout. One filter (inside Spring Session, before the security chain) wraps
the request so that only a call that would create a session spends budget: `GET /api/auth/csrf` without a valid
`SESSION` cookie (a bogus cookie counts as none) and an unsafe write without a session, whose CSRF rejection
generates a token. Requests carrying a valid session are never limited, and anonymous requests that create no
session (401 on protected routes, health probes, the Plaid webhook) spend nothing. Beyond the budget the request
is refused with the same 429 `RATE_LIMITED` problem response and `Retry-After` as the auth limiter, and no session
row is written. 30 per 10 minutes admits a household behind one NAT (several devices signing in and out) while
keeping one source to a few dozen live rows per session lifetime. The limiter is process-local and shares the
key-capacity fail-closed behaviour of the other limiters.

Unexpected-error logging never includes the exception message or stack trace, because database and validation
messages can echo user-supplied values. Handlers log the event, error code, correlation ID and the exception class
(plus the root-cause class for 500s) only.

Unauthenticated protected access returns 401. Unimplemented routes remain denied (401 anonymous / 403
authenticated is acceptable); no route gains access simply because the client has a session. Health GETs keep
their safe UP/DOWN contract with optional public `groups` metadata.

## Browser lifecycle and recovery

1. Bootstrap CSRF and check `me`. Initial 401 means signed out, not an alarming error. Network/server failures
   show an actionable retry state rather than masquerading as signed-out success.
2. Operator privately delivers `/enroll#code=<secret>` or `/recover#code=<secret>`. The fragment is not sent
   in an HTTP request; the user supplies the recipient email in the form. Clear the fragment from browser history
   as soon as it is parsed. Do not persist codes to browser storage or assume mailbox ownership.
3. Registration collects email/password/password confirmation and enrollment code; success does not authenticate.
   Recovery collects recipient email/new password/code; success removes every existing session.
4. Login submits JSON with the current CSRF header; disable duplicate submissions. On 200 fetch a fresh CSRF
   token before further writes and display the safe current identity with logout and household status.
5. Recheck `me` when the app regains focus. Expired or revoked sessions require sign-in again; a network failure
   must not be represented as confirmed expiry.
6. Password change and explicit session revoke invalidate the current session along with other sessions. Clear
   authenticated state and bootstrap fresh anonymous CSRF after success.
7. Logout POST includes CSRF; on 204 clear user/password state and fetch new anonymous CSRF. If logout fails,
   preserve authenticated state and provide recovery rather than pretending the server session was invalidated.
8. On `CSRF_INVALID`, refresh CSRF and invite an explicit retry; never silently replay a write.
9. **Profile Settings** retains `/account/security`, separate from household/finance
   pages. A top-right native-dialog profile menu shows the existing email identity,
   account ID, settings link and guarded sign-out; the current API has no display
   name field. The portal stays inside authenticated state ownership and disappears
   on identity loss. The authenticated controller survives client-side navigation;
   direct protected-page visits show sign-in until the session is confirmed. Leaving
   settings or changing identity clears password drafts. Typing never moves route
   focus or restarts unrelated household requests; route changes close modal overlays
   before focusing the page heading and resetting the viewport once.

Use semantic forms, associated labels/errors, autocomplete `email`/`current-password`/`new-password`, visible focus,
polite status/error announcements, accessible button states, and a mobile-first layout consistent with the shared styles.
Do not persist credentials, grant codes, principal snapshots, or CSRF tokens to web storage. Recovery and
change-password controls are available for hosted use via operator assistance; there is no
unverified-email self-service reset and no email-ownership proof in this flow.

## Operator CLI boundary

Only an authorized administrator with Docker access may run the one-shot CLI;
Docker group membership is root-equivalent. Use an isolated configured deployment
and replace the example recipient with its intended canonical address. The CLI
uses backend database configuration, not a public HTTP administration endpoint.

```sh
docker compose -f compose.yaml -f deploy/compose.hosted.yaml --profile app exec -T backend java -jar /app/app.jar --spring.main.web-application-type=none --spring.main.banner-mode=off --logging.level.root=OFF --app.operator.action=issue-enrollment --app.operator.email='person@example.test'
```

For an existing account use `--app.operator.action=issue-recovery`; for an unconsumed grant revoke it
with `--app.operator.action=revoke --app.operator.grant-id=<grantId>` (omit email). The CLI prints
`grantId`, `expiresAt` and `code` to **docker exec's one-shot stdout** only, not the running app's
logs. Do not redirect or paste stdout into logs, tickets, chat archives, shell arguments, or monitoring.
Privately convey the fragment URL to the intended recipient and treat it like a password until consumed;
the operator can revoke an undelivered link by grant ID. Only SHA-256 digests reside in PostgreSQL;
the audit rows contain grant ID, action, time and actor marker, never codes or passwords.

For departure use the same one-shot invocation with `--app.operator.action=disable-account` and
`--app.operator.email='person@example.test'` (no grant ID). This marks the account inaccessible,
revokes unconsumed grants and every session in one transaction, and preserves household records
and their user UUID references. Remove **every** household membership (including `MEMBER`) first using
household owner-authorized APIs; the CLI refuses to disable anyone who remains in any household.
Transfer the departing household's ownership to an enabled member before removing its final departing
owner. Host operator access does not confer household owner authority. Disablement is irreversible
without a separate decision.

## Test coverage

- Flyway owns identity and Spring Session tables. PostgreSQL tests validate
  migrations, constraints and retained sessions rather than rely on an in-memory database.
- Testcontainers/HTTP tests exercise cookies, JSON, CSRF bootstrap/rotation, fixation, session persistence,
  logout/expiry, duplicates and limits against real PostgreSQL. Unit tests cover password/normalization and
  limiter time/capacity boundaries. Use test clocks and isolated identities instead of sleeping through windows.
- Web tests cover anonymous/authenticated boot, register-to-sign-in, safe validation and failures, invalid
  credentials, logout failure/success, CSRF rebootstrap, expired-session transitions and server unavailability.
- Container stack checks exercise restart persistence, revoked/expired
  sessions, cookie flags and denied unsafe requests.
