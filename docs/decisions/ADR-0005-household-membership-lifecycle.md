# ADR 0005 - Household membership lifecycle

- **Status:** Accepted and implemented.
- **Scope:** Member roster visibility, role changes, member removal, voluntary leave, and last-owner safety.
- **Related:** [Household API](../architecture/household-api.md),
  [household context](ADR-0003-household-membership-context.md),
  [capability invitations](ADR-0004-capability-household-invitations.md), and
  [known limits](../product/known-limits.md).

## Context

Invitation acceptance creates `MEMBER` rows, but without a lifecycle users cannot see who belongs to a household
or manage membership. That lifecycle must exist before financial records depend on the household boundary. The design
must also make the existing invitation owner checks safe when role changes occur concurrently.

The household remains the tenant boundary. A browser-displayed role, member ID, or stale roster is never
authorization evidence; every operation uses the authenticated actor and current PostgreSQL membership.

## Decision

- Every current household member may view a minimal roster containing each member's user UUID, canonical email,
  and current `OWNER` or `MEMBER` role. Email is already the account's visible identifier and is disclosed only
  inside a household where both users are current members. Password, session, invitation, and account metadata
  remain private.
- Owners may promote a current `MEMBER` to `OWNER`, demote a current `OWNER` to `MEMBER`, or remove another
  current member. Co-owners have equal authority; there is no hidden creator privilege.
- Any current member may leave. The dedicated leave operation is the browser's self-removal path. Removing the
  actor through the owner target endpoint is rejected so self-removal has one explicit contract.
- A household must always have at least one owner. The final owner cannot be demoted or leave. Because the
  owner-target endpoint cannot target the actor, an owner also cannot remove themself through that route.
- Role assignment is idempotent when the requested role already matches. Removing a target that is not a current
  member returns a generic membership 404. Missing households and non-member actors retain the existing
  indistinguishable household 404.
- Membership mutations lock the household row in a bounded transaction before resolving actor and target roles.
  Owner-authorized invitation create, list, and revoke operations take the same lock before authorization. This
  serializes role changes, removal/leave, owner invitation access, and invitation writes for one household so a
  stale owner cannot commit a new owner-only write or receive owner-only list data after a completed demotion, and
  concurrent mutations cannot remove the final owner.
- Membership rows keep the existing composite key and role constraint. No migration is needed: the lifecycle
  changes existing role values or removes rows, and the current schema already represents the required state.

Household rename/delete, invitation email delivery, audit history, custom roles, ownership percentages,
preferred-household persistence, and finance visibility remain separate decisions.

## API and browser consequences

The lifecycle extends the household API with a member roster, role update, owner removal, and leave endpoints.
Unsafe operations use the existing session-backed CSRF header and every response is `Cache-Control: no-store`.
Stable `MEMBERSHIP_NOT_FOUND` and `LAST_OWNER_REQUIRED` errors distinguish a missing target from a blocked
ownership invariant without exposing another household.

The browser renders a roster in each household card. Owners receive role and remove controls for other members;
all users receive a leave control. Destructive actions require confirmation. After any success, uncertain timeout,
or stale-access response, the browser reloads authoritative household data rather than preserving client-side
authority. When the actor leaves or loses access, that household and its controls disappear.

## Verification

- PostgreSQL-backed tests cover roster privacy, owner/member authorization, promotion, demotion, removal, leave,
  self-target rejection, missing-target behavior, and concurrent last-owner attempts.
- Integration tests prove a completed demotion/removal immediately denies household and invitation access, and
  owner-only invitation writes serialize with role changes.
- Web tests cover member and owner rosters, confirmations, duplicate-submit guards, success, validation, CSRF,
  session expiry, timeout reconciliation, stale role/access recovery, focus announcements, and state cleanup.
- Behavior checks cover two members and an outsider, migration constraints,
  last-owner races, mobile reflow, keyboard/focus and stale authority recovery.
