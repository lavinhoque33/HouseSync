# Household API - create, access, and membership lifecycle

**Status:** Household create/access and membership lifecycle implemented.
See [ADR 0003](../decisions/ADR-0003-household-membership-context.md)
and [ADR 0005](../decisions/ADR-0005-household-membership-lifecycle.md).
Responses are non-cacheable JSON. Authentication uses the server-side session;
unsafe requests use session-backed CSRF.

## Resource

An authorized household response has exactly these fields:

```json
{
  "id": "opaque-uuid",
  "name": "Elm Street home",
  "role": "OWNER",
  "createdAt": "2026-09-13T01:30:00Z"
}
```

`role` is the current actor's membership role, `OWNER` or `MEMBER`. It is descriptive response data, not a
client credential. No member roster is embedded in this response. Roster access uses its dedicated membership
resource and never exposes password, session, invitation, finance, or internal persistence data.

The roster response has exactly one `members` collection with minimal member resources:

```json
{
  "members": [
    {
      "userId": "opaque-user-uuid",
      "email": "person@example.test",
      "role": "MEMBER"
    }
  ]
}
```

## Endpoints

| Method/path | Request | Success | Other outcomes |
| --- | --- | --- | --- |
| `POST /api/households` | `{"name":"Elm Street home"}` + authenticated session + CSRF | 201 household; creator role is `OWNER` | 400 validation/shape, 401 session missing/expired, 403 CSRF, 5xx safe failure |
| `GET /api/households` | Authenticated session | 200 `{"households":[...]}` scoped to the actor, ordered by `createdAt` then `id`; empty list is valid | 401 session missing/expired, 5xx safe failure |
| `GET /api/households/{householdId}` | Authenticated session | 200 household when the actor is a current member | 400 malformed UUID, 401 session missing/expired, 404 missing or non-member, 5xx safe failure |
| `GET /api/households/{householdId}/members` | Authenticated current member | 200 minimal roster ordered by email then user UUID | 400 malformed UUID, 401 session missing/expired, 404 missing or non-member, 5xx safe failure |
| `PATCH /api/households/{householdId}/members/{userId}` | `{"role":"OWNER"}` or `{"role":"MEMBER"}` + owner session + CSRF | 200 updated member; assigning the current role is idempotent | 400 shape/role/self-target, 401 session missing/expired, 403 current non-owner, 404 household/target, 5xx safe failure |
| `DELETE /api/households/{householdId}/members/{userId}` | Owner session + CSRF | 204 after removing another current member | 400 self-target, 401 session missing/expired, 403 current non-owner, 404 household/target, 5xx safe failure |
| `POST /api/households/{householdId}/leave` | Current member session + CSRF; no request fields are read | 204 after removing the actor | 401 session missing/expired, 404 missing or non-member, 409 last owner, 5xx safe failure |

Creation accepts only `name`. Unknown fields such as `id`, `householdId`, `ownerId`, `role`, `members`, or
`userId` are rejected as malformed input and never ignored as authorization hints. Duplicate household names
are valid and create distinct household IDs. Repeated successful create requests are separate operations; household
creation does not define an idempotency key.

The leave operation follows the existing bodyless invitation-create convention: it binds no request payload, so
any stray body is ignored and can never act as authorization evidence. Clients send no body.

## Validation and errors

The server trims leading/trailing whitespace from `name`, preserves interior content, and requires 1–100
Unicode code points with no control characters. A validation failure uses `fieldErrors.name`. The database
also rejects null, untrimmed, blank, and overlength stored names.

Errors retain the identity contract shape:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "Check the supplied details.",
  "correlationId": "opaque-request-id",
  "fieldErrors": {"name": "Enter a household name."}
}
```

`fieldErrors` is optional and only includes known fields. Household endpoints use the existing
`VALIDATION_FAILED` (400/415), `UNAUTHENTICATED` (401), `CSRF_INVALID` (403), `FORBIDDEN` (403), and
`INTERNAL_ERROR` (500) codes plus `HOUSEHOLD_NOT_FOUND` (404), `MEMBERSHIP_NOT_FOUND` (404), and
`LAST_OWNER_REQUIRED` (409). An authenticated non-member and a missing UUID receive the same household 404 code
and generic message; the body never contains the requested ID, user ID, email, or name. Malformed JSON, unknown
fields, unsupported media types, invalid role values, and owner self-target mutations remain safe 400/415 errors
with correlation IDs. Only `role` may appear as a lifecycle field error.

## Authorization and transaction contract

- Security configuration permits only the seven documented household method/path shapes for authenticated users;
  unimplemented household methods and deeper path variants remain deny-by-default.
- Creation derives `user_id` from the authenticated `HouseSyncUserDetails` UUID. Household and `OWNER`
  membership inserts commit or roll back together.
- Listing joins memberships by the actor UUID in PostgreSQL. Detail access queries by actor and household in
  one membership-scoped operation; it does not load an unrestricted household and filter in the browser.
- The membership composite key and foreign keys are authoritative under concurrency. Concurrent create
  requests may each create a distinct valid household; none may leave a household without its owner row.
- Current membership is checked on each request. A browser-held household ID or role cannot preserve access
  after a future removal or role change.
- A roster query requires actor membership in the same database statement that selects roster users. All members
  can read the minimal `userId`, `email`, and `role` representation; only owners can mutate another membership.
- Each membership mutation locks the household row before resolving current actor and target roles. Demotion and
  leave count owners under that lock and reject removing the final owner. Owner-authorized invitation create,
  list, and revoke operations take the same lock before checking authority. This prevents an in-flight stale owner
  write from committing after a completed demotion and ensures an invitation-list result is ordered before or
  after the role change rather than returning stale owner-only data after it.
- Lifecycle, invitation, and finance paths that take the household row lock first run a non-locking
  membership-scoped check. Missing households and non-members receive the generic 404 immediately, without
  queueing on or observing the lock; members then lock and re-read membership under it, so a removal or demotion
  committed first still wins.
- Role updates are idempotent. The owner target endpoints reject self-targeting; the dedicated leave endpoint is
  the only self-removal operation. Co-owners have equal permissions, with no creator privilege.

## Browser lifecycle and recovery

1. Do not request households while signed out. After identity bootstrap confirms a user, load the authorized
   household collection and show loading, empty, ready, or recoverable error state.
2. `/households` is a directory, not a creation form. The nested navigation drawer
   links to `/households/new`, whose labeled household-name field validates the
   documented bounds, preserves safe input/errors across navigation and failures,
   and disables duplicate submission while creation is pending.
3. On 201, retain the returned household, announce success and offer its entry link.
   On timeout, state that the outcome is unknown and offer a collection refresh
   instead of claiming failure or silently resubmitting.
4. On 401, clear authenticated household UI and use the identity sign-in-again recovery. A network error must
   not masquerade as session expiry.
5. On `CSRF_INVALID`, refresh CSRF and request an explicit retry; never replay creation automatically.
6. On logout or confirmed expiry, clear household response state together with the safe user snapshot. Do not
   persist household authority, principal snapshots, or CSRF tokens in web storage.
7. Load each visible household's roster from the dedicated endpoint. Keep a previously loaded roster visibly stale
   after a recoverable failure; do not expose mutation controls until current household and roster authority are
   confirmed.
8. Confirm role changes, removals, and leave before submission. Disable duplicate actions while pending. On an
   unknown timeout, refresh the household collection and roster before offering another mutation. On 401, use the
   established sign-in-again flow; on CSRF rejection, refresh the token and require an explicit retry.
9. After role/access changes, reconcile from the backend. A demoted actor loses owner controls; a removed or
   departed actor loses the household card. Never preserve authority from an optimistic client update.
10. Visible directory cards load authorized member counts and the viewer's private
    account-type/status summary; bounded pages are explicitly partial. Failed
    summaries are unavailable, not zero, and support retry. The household-context
    inbox counts unreviewed plus changed bank activity, never fabricated unread
    notifications. Successful bank decisions refresh its attention count without
    unnecessarily refreshing the ledger.
11. Both new read surfaces reconcile on 403 or `HOUSEHOLD_NOT_FOUND`, including the
    backend's hidden 404 membership-loss response. Concurrent card summary denials
    cause one reconciliation, not duplicate reloads. If the collection still lists
    the denied scope, summaries settle as unavailable with an explicit **Retry
    household access** action instead of automatically reloading forever. Removed
    households and changed roles clear the old denial guard. Session loss, scope
    changes and aborted/stale responses cannot republish prior private summary data.

Use semantic headings/forms, persistent labels, associated errors, status/error announcements, visible focus,
44 CSS-pixel targets, and mobile-first reflow. Household labels must wrap rather than lose their only visible
representation.

## Test coverage

- PostgreSQL tests cover fresh V4 migration, upgrade from V3 with identity/session data preserved, constraints,
  atomic rollback, duplicate names, concurrent creation, and actor-scoped queries.
- HTTP tests use real registration/login/session/CSRF flows for create/list/detail, anonymous and non-member
  denial, missing/non-member equivalence, forged fields, validation boundaries, and safe DTO/error content.
- Web tests cover signed-out request suppression, signed-in loading/empty/ready states, creation and duplicate
  submission, safe validation/server errors, unknown timeout outcome, CSRF explicit retry, expiry, logout cleanup,
  and keyboard/focus semantics.
- Lifecycle PostgreSQL/HTTP tests cover roster privacy, owner/member permissions, idempotent role updates,
  promotion/demotion, target removal, leave, last-owner protection under concurrency, stale access denial, strict
  request/response shapes, and invitation-write serialization.
- Lifecycle web tests cover owner/member controls, confirmations, duplicate guards, success and stale/unknown
  recovery, CSRF/session handling, authoritative reconciliation, and removal of lost household access.
- Persistence across restart, phone/desktop reflow, keyboard access and focus behavior are exercised
  separately from automated accessibility checks.
