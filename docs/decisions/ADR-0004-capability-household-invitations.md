# ADR 0004 - Capability-based household invitations

- **Status:** Accepted and implemented.
- **Scope:** Household invitation capability, expiry, single-use acceptance and revocation;
  not email-recipient binding or service enrollment.
- **Related:** [Invitation API](../architecture/invitation-api.md),
  [household membership decision](ADR-0003-household-membership-context.md),
  [identity/session decision](ADR-0002-identity-sessions.md), and
  [known limits](../product/known-limits.md).

## Context and alternatives

HouseSync needs a second person to join a household without weakening the household tenant boundary.
The current account email is an unverified login identifier, and no email-delivery provider exists.
Treating an owner-entered email as authorization would let an account that merely claimed that address
receive membership. Adding verified email and transactional delivery first would be safer for email-bound
invitations, but it would expand household invitations into account lifecycle and provider operations.

The initial alternative is a capability invitation: the owner deliberately shares an unguessable link through
a private channel they choose. Possession of the secret establishes invitation entitlement, while an
authenticated HouseSync account establishes the user that receives membership. This is implementable without
pretending that HouseSync verified an email address or delivered a message.

## Decision

Use an owner-mediated, single-use capability link for household invitations.

- Only a current `OWNER` may create, list active, or revoke invitations for a household. Authorization is
  resolved from current membership data on every operation. A current `MEMBER` receives `403 FORBIDDEN`;
  a missing household and a non-member both receive the existing privacy-safe household 404.
- An invitation always grants `MEMBER`. The request cannot choose a role, user, household, owner, or recipient.
  The household comes from the owner-authorized route during creation and from the invitation during acceptance.
- The server generates 32 cryptographically secure random bytes and encodes them as exactly 43 unpadded
  base64url characters. PostgreSQL stores only `SHA-256(raw_bytes)`, a 32-byte digest calculated after decoding
  that canonical string. The raw secret is returned once in the create response and cannot be recovered by
  listing or reloading.
- The web client constructs `/join/{invitationId}#invite={secret}` on its current origin. URI fragments are not
  sent in the initial HTTP request. The client reads the secret once, immediately removes the fragment with
  `history.replaceState`, keeps the secret only in memory, and sends it only in non-cacheable JSON request bodies.
  It never places the secret in query strings, path segments, logs, analytics, titles, or browser storage.
- The owner shares the link through a private out-of-band channel. HouseSync does not send email, SMS, or push
  notifications. The UI must state that anyone with the link can join until it expires, is used,
  or is revoked. Forwarding cannot be prevented by this bearer design and must not be represented as impossible.
- An invitation expires exactly 168 hours after creation. Expiry is checked against an injected server clock;
  viewing an invitation does not extend it. Expiry is derived from `expires_at`, not advanced by a scheduler.
- Preview and acceptance require an authenticated session. Both receive the invitation ID and secret in a JSON
  body and require the existing session-backed CSRF header. A signed-out link holder sees a generic sign-in or
  registration prompt, not household metadata or token-validity information.
- A valid preview exposes only household name, resulting `MEMBER` role, and expiry. It exposes no household ID,
  roster, owner, email, member count, finance data, creator, or invitation history.
- Acceptance locks and revalidates the invitation, inserts the actor's `MEMBER` row if absent, and records the
  accepting actor in one transaction. The membership composite key remains authoritative. An actor who already
  belongs to the household consumes the invitation and receives their existing authorized household response.
- Repeating acceptance of the same invitation by the recorded accepting actor is idempotent only while that
  actor remains a current member. It returns the current membership-scoped household and current role, including
  a later promotion. If that actor was removed, replay returns 404 and never restores membership. Any other actor,
  wrong secret, malformed capability, expired invitation, revoked invitation, or otherwise consumed invitation
  receives the same `404 INVITATION_NOT_FOUND` body.
- Any current owner may revoke an active invitation. Revocation is permanent. Repeating revocation of that
  already-revoked invitation is a successful no-op for an authorized owner. Accepted, expired, missing, and
  wrong-household invitation IDs return the same `404 INVITATION_NOT_FOUND` after household authorization.
  Acceptance and revocation serialize on the invitation row so only one terminal transition wins.
- Recipient rejection is local dismissal only. A bearer invitation has no recipient account before acceptance,
  so a recipient cannot authoritatively decline it on behalf of an identity. The owner may revoke it.

## Persistence and lifecycle consequences

Migration V5 adds `household_invitations` with an opaque UUID, household and creator foreign keys,
the capability's digest, creation/expiry instants, nullable acceptance instant/user, and nullable revocation instant.
Database checks keep acceptance fields paired, prevent simultaneous acceptance and revocation, require expiry
after creation, and require a 32-byte digest. Foreign keys remain restrictive while deletion and retention are
undecided. Terminal rows remain so same-actor acceptance retries can be resolved safely.

Invitation state is derived:

- active: not accepted, not revoked, and current time is before `expires_at`;
- expired: not accepted or revoked, and current time is at or after `expires_at`;
- accepted: acceptance instant and actor are present;
- revoked: revocation instant is present.

Owner listing returns only active invitations and never returns secret material or accepting-user metadata.
The initial list is unpaginated because invitations are manual owner actions. Before public or bulk use,
HouseSync must define bounded pending quotas, cursor pagination, terminal-row retention, and distributed abuse
controls. There is no dedicated invitation throttle and no production claim.

## Browser and operational consequences

The owner sees the generated link once, can copy it, and can revoke active invitations after a reload. If create
times out, the outcome is unknown: refresh the active list, revoke any unshareable invitation that appeared, and
create a replacement explicitly. Never replay creation automatically.

The application root owns the in-memory capability above authentication and user-keyed household components, so
it can survive registration and sign-in within the same tab without entering browser storage. A join component
must not lose the secret merely because authenticated UI replaces anonymous UI. A reload, explicit logout, navigation away, terminal failure,
or successful acceptance discards the state; recovery is to reopen the original link. On an acceptance timeout,
refresh the authorized household list before an explicit retry. Same-actor acceptance idempotency makes that
retry safe without silently replaying it.

Invitation pages and API responses use `Cache-Control: no-store`; the web delivery must set
`Referrer-Policy: no-referrer` and avoid third-party content on the join flow. Production delivery requires HTTPS
and Secure session cookies. Diagnostics may include a correlation ID and stable error code. A non-secret record
ID may appear only in owner-scoped success diagnostics, never an `INVITATION_NOT_FOUND` path. Diagnostics never
include the raw secret, digest, link, submitted body, or household name.

## Deferred decisions

Verified-email delivery remains a separate identity and infrastructure decision.
Future invitation types could bind a verified address or stable recipient UUID,
but cannot reinterpret existing capabilities or trust an unverified login email.
Operator-assisted account recovery and household roster/lifecycle exist under
their separate [identity](ADR-0002-identity-sessions.md) and
[membership](ADR-0005-household-membership-lifecycle.md) decisions.

## Verification

The [Invitation API](../architecture/invitation-api.md) contract is backed by a PostgreSQL forward/upgrade
migration, transaction and concurrency tests for accept-versus-accept and accept-versus-revoke, current-owner
authorization, indistinguishable invalid capability responses, exactly-once membership, safe secret
storage/transport, and native/container browser journeys for owner create/copy/revoke and recipient
sign-in/preview/accept. Web tests cover timeout and CSRF recovery, fragment cleanup, no browser storage,
keyboard/focus behavior, phone/desktop/200% reflow, and automated accessibility.

## References

- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
  for random, sufficiently long, securely stored, expiring, single-use token guidance
- [MDN URI fragment reference](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment)
- [MDN Referrer-Policy reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
