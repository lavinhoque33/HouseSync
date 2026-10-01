# Invitation API

**Status:** Household invitations implemented. See
[ADR 0004](../decisions/ADR-0004-capability-household-invitations.md) and
[ADR 0003](../decisions/ADR-0003-household-membership-context.md).
Every response is non-cacheable; bodies are JSON except successful 204 revocation.
Authentication uses the server-side session; every POST and DELETE requires CSRF.

Invitation links authorize joining an existing household, not creating an account.
Account registration separately requires an operator-issued recipient-bound enrollment
grant under the [identity API](identity-api.md). Invitation capability is not
recipient-email bound; an unverified email is not proof of mailbox ownership.

## Capability contract

Creation returns an opaque invitation UUID plus a one-time 43-character unpadded base64url secret containing
32 cryptographically random bytes:

```json
{
  "id": "opaque-invitation-uuid",
  "secret": "one-time-base64url-secret",
  "createdAt": "2026-09-13T04:00:00Z",
  "expiresAt": "2026-09-20T04:00:00Z"
}
```

The web client builds `/join/{id}#invite={secret}` using its current origin. The backend never constructs a full
URL from an untrusted host header. The fragment secret is extracted and removed from the address bar before any
preview or acceptance request. PostgreSQL stores only `SHA-256(raw_bytes)`, calculated after strict base64url
decoding; owner listing cannot recover a secret.

Preview and acceptance accept exactly this request:

```json
{
  "invitationId": "opaque-invitation-uuid",
  "secret": "one-time-base64url-secret"
}
```

Unknown properties, missing values, malformed UUIDs, and secrets that do not match
`^[A-Za-z0-9_-]{43}$` or decode to exactly 32 bytes are validation failures. Padded and alternate encodings are
rejected. The request never accepts a household ID, user ID, email, owner, role, expiry, or status.

## Owner endpoints

| Method/path | Request | Success | Other outcomes |
| --- | --- | --- | --- |
| `POST /api/households/{householdId}/invitations` | No body; authenticated current owner + CSRF | 201 one-time capability response | 400 malformed UUID, 401 expired/missing session, 403 `FORBIDDEN` for current non-owner or `CSRF_INVALID` for CSRF, 404 missing/non-member household, 5xx safe failure |
| `GET /api/households/{householdId}/invitations` | Authenticated current owner | 200 active invitation collection | 400 malformed UUID, 401 expired/missing session, 403 current member without owner permission, 404 missing/non-member household, 5xx safe failure |
| `DELETE /api/households/{householdId}/invitations/{invitationId}` | Authenticated current owner + CSRF | 204 with `Cache-Control: no-store` when active is revoked or the same invitation was already revoked | 400 malformed UUID, 401 expired/missing session, 403 `FORBIDDEN` for current non-owner or `CSRF_INVALID` for CSRF, 404 household/invitation unavailable within the actor's scope, 5xx safe failure |

The active collection has this shape and is ordered by `createdAt`, then `id`:

```json
{
  "invitations": [
    {
      "id": "opaque-invitation-uuid",
      "createdAt": "2026-09-13T04:00:00Z",
      "expiresAt": "2026-09-20T04:00:00Z"
    }
  ]
}
```

Only unaccepted, unrevoked, unexpired invitations appear. No list response contains the secret/digest, creator,
accepting user, household name/ID, recipient hint, or terminal history. Duplicate creates are independent
invitations; no idempotency key is defined. If a create response is lost, refresh, revoke the resulting
unshareable invitation if present, and create another explicitly.

The path household is resolved with current membership. A non-member and a missing household receive the same
`404 HOUSEHOLD_NOT_FOUND`. A current member is already authorized to know the household but lacks owner powers,
so receives `403 FORBIDDEN`; CSRF denial uses `403 CSRF_INVALID` instead. Invitation IDs are always scoped to the
authorized path household. After household authorization, accepted, expired, missing, and wrong-household
invitation IDs use `404 INVITATION_NOT_FOUND`; a repeated revoke of the same revoked row returns 204.

## Recipient endpoints

| Method/path | Request | Success | Other outcomes |
| --- | --- | --- | --- |
| `POST /api/invitations/preview` | Capability request + authenticated session + CSRF | 200 minimal preview for an active invitation | 400 validation/shape, 401 expired/missing session, 403 CSRF, 404 invalid/unavailable capability, 5xx safe failure |
| `POST /api/invitations/accept` | Capability request + authenticated session + CSRF | 200 authorized household response; role is the actor's current membership role | 400 validation/shape, 401 expired/missing session, 403 CSRF, 404 invalid/unavailable capability, 5xx safe failure |

Preview exposes exactly:

```json
{
  "householdName": "Elm Street home",
  "role": "MEMBER",
  "expiresAt": "2026-09-20T04:00:00Z"
}
```

Acceptance returns the existing household response contract. A newly joined actor receives `MEMBER`. If the
actor was already a member, including the creating owner, the invitation is still consumed and the response
contains that actor's current role. Repeating the same accepted capability as its recorded actor is idempotent
only while the actor remains a member; it returns their current role. A removed actor receives 404 and the replay
never recreates membership.

A correctly shaped but wrong secret, missing record, expiry, revocation, or capability consumed by another actor
uses one `404 INVITATION_NOT_FOUND` code and generic message. These states do not reveal the household name, ID,
terminal reason, accepting actor, or whether the invitation ever existed. The browser represents all of them as
"invalid or no longer available" and directs the user to request a new link. A signed-out user is prompted to
authenticate without calling preview, so anonymous users receive no capability-validity oracle.

## Persistence and transaction contract

The next forward migration is `V5__create_household_invitations.sql`. It adds:

- `id UUID PRIMARY KEY`;
- `household_id UUID NOT NULL` and `created_by_user_id UUID NOT NULL`, with restrictive foreign keys;
- `secret_hash BYTEA NOT NULL UNIQUE` constrained to 32 bytes;
- `created_at TIMESTAMPTZ NOT NULL` and `expires_at TIMESTAMPTZ NOT NULL`, with expiry after creation;
- nullable paired `accepted_at TIMESTAMPTZ` and `accepted_by_user_id UUID`, with a restrictive user foreign key;
- nullable `revoked_at TIMESTAMPTZ`; and
- checks that acceptance fields are both null or both populated and that acceptance and revocation cannot coexist.

An index on `(household_id, created_at, id)` for rows whose acceptance and revocation instants are null supports
the owner-scoped active list; the query additionally excludes expired rows.
There is no persisted raw secret, email, role, recipient hint, status enum, resend state, or delivery-provider data.
Expiry and state are derived. Application instants use PostgreSQL-compatible microsecond precision.

Creation checks current `OWNER` membership and inserts one invitation in a transaction. A digest collision causes
one server-side regeneration attempt; a second collision returns a safe 500 without exposing either value.
Preview reads by invitation ID, strictly decodes the canonical secret, hashes the raw 32 bytes, compares digest
bytes with `MessageDigest.isEqual`, and returns only an active row. It never loads a household first and filters
capability state in the browser.

Acceptance uses one transaction and a row lock:

1. Load the invitation by ID for update and compare the secret digest.
2. If it was accepted by the same actor, return the current membership-scoped household response or 404 when
   membership no longer exists; never recreate removed membership on replay.
3. Otherwise require unrevoked, unaccepted state and `now < expires_at`.
4. Insert `(household_id, actor_id, MEMBER)` with database-backed conflict handling; an existing membership is
   valid and does not duplicate the row.
5. Record `accepted_at` and `accepted_by_user_id`, then commit both membership and consumption together.

Revocation locks the same row and records `revoked_at`. Concurrent acceptance versus acceptance, or acceptance
versus revocation, produces one winning terminal transition without a duplicate membership or partial commit.
Terminal rows are retained for idempotency; deletion/retention policy remains deferred.

## Errors, security, and diagnostics

Invitation endpoints retain the identity error envelope and existing `VALIDATION_FAILED`, `UNAUTHENTICATED`,
`CSRF_INVALID`, `FORBIDDEN`, `HOUSEHOLD_NOT_FOUND`, and `INTERNAL_ERROR` codes, plus
`INVITATION_NOT_FOUND`. `fieldErrors` contains only `invitationId` or `secret` when applicable and never echoes
values. Unsupported media types and unknown fields receive safe 400/415 responses.

Every route is added as an exact method/path rule before the existing deny-all fallback. All authorization comes
from the authenticated principal, current membership, and persisted invitation. Client-displayed role, path IDs,
and capability contents are not independently trusted.

Every response, including a successful 204 revocation, uses `Cache-Control: no-store`. Logs and errors never
include the secret, digest, fragment, request body,
household name, session cookie, or authorization/CSRF headers. A correlation ID and safe stable code remain
available. There is no dedicated invitation throttle; distributed source/actor controls, quotas, pagination,
and retention are needed before public or multi-instance use.

## Browser lifecycle and recovery

1. The owner can create only after household access and role are freshly confirmed. The one-time link appears
   with a private-sharing warning and accessible copy confirmation. Reloading never reveals it again.
2. Active invitations remain revocable after reload. Create/revoke timeout states require a list refresh; writes
   are not replayed automatically. An unshareable invitation from an uncertain create is revoked and replaced.
3. The join route extracts and removes the fragment immediately. Application-root state above authentication and
   user-keyed household components keeps the capability only in same-tab memory through registration/sign-in and
   shows no household details while signed out. Reloading requires reopening the original link.
4. Once authenticated, preview shows household name, `MEMBER`, and expiry. Acceptance is an explicit action with
   duplicate-submit protection. Success refreshes the recipient's household collection and offers detail access.
   An accepted household name/role and prior preview belong only to that signed-in identity: clear them
   before paint when the session ends or the user changes. A consumed link also leaves the join route
   on identity loss. An unconsumed link can remain in memory across session expiry, but a signed-out
   holder sees only the generic sign-in prompt until authorized preview.
5. `CSRF_INVALID` refreshes CSRF and requires an explicit retry. On an acceptance timeout, check the household
   collection first, then permit an explicit idempotent retry. Network failure never masquerades as expiry.
6. Successful acceptance, terminal capability failure, explicit logout, or leaving the flow discards the
   in-memory secret. No capability, principal snapshot, household authority, or CSRF token enters web storage.

Use semantic headings/forms, persistent labels, visible focus, polite status/error announcements, 44 CSS-pixel
targets, and wrapping rather than truncating the only link or household-name representation. Copy failure must
leave a manual-copy path. Recipient dismissal performs no server mutation; only an owner revokes.

## Test coverage

- PostgreSQL tests cover fresh V5 migration, V4-to-V5 upgrade with prior data preserved, checks/FKs/indexes,
  digest-only storage, seven-day boundary, restrictive deletion, rollback, and terminal-state constraints.
- HTTP tests use real session/CSRF flows for owner create/list/revoke, member/outsider denial, forged fields,
  authenticated preview, exactly-once acceptance, existing-member acceptance, same-actor replay, expiry,
  revocation, wrong secrets, safe errors/DTOs, and no-cache responses.
- Concurrency tests prove accept-versus-accept and accept-versus-revoke produce one terminal result and at most one
  membership. Tests use an injected clock and coordination primitives, not sleeps or an in-memory database.
- Web tests cover owner state gating, one-time copy/manual fallback, lost create outcomes, revocation recovery,
  fragment cleanup, signed-out authentication transitions, terminal links, duplicate-submit guards, session/CSRF
  recovery, accept timeout reconciliation, logout cleanup, and no browser storage. The typed client handles
  `INVITATION_NOT_FOUND` and the safe `invitationId`/`secret` field-error keys rather than degrading them to
  unknown failures.
- Two-user/outsider journeys run with persisted invitations across restart, including phone reflow and
  keyboard/focus recovery; automated checks alone do not establish full accessibility.
