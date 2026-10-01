# ADR 0003 — Household membership and request-scoped context

- **Status:** Accepted and implemented.
- **Scope:** Household creation, membership-scoped listing and detail access, and creator ownership.
- **Related:** [Household API](../architecture/household-api.md),
  [identity/session decision](ADR-0002-identity-sessions.md) and
  [membership lifecycle](ADR-0005-household-membership-lifecycle.md).

## Context

Households are HouseSync's tenant boundary. Household support must establish authorization and
membership invariants before financial records exist, without prematurely implementing invitations, member
administration, or financial visibility. Authentication identifies an actor but does not itself grant access
to any household. Membership must remain current when later role changes and removals arrive.

The product does not require one household per user. Enforcing that restriction would make later household
membership unnecessarily rigid, so this decision supports multiple memberships while keeping the first web
flow simple.

## Decision

Use request-scoped household context backed by current PostgreSQL membership data.

- A household has an opaque UUID, a non-unique display name, and a server-generated creation instant.
- A membership is identified by `(household_id, user_id)` and has one of two stable roles: `OWNER` or
  `MEMBER`. Creation produces only `OWNER`; `MEMBER` rows come from invitations ([ADR 0004](ADR-0004-capability-household-invitations.md)).
- Creating a household and its creator `OWNER` membership is one transaction. The actor comes from the
  authenticated principal. The request accepts only `name`; clients cannot assign IDs, owners, roles,
  memberships, or tenant context.
- Every household must have at least one owner. Creation establishes this invariant; role changes and removals
  ([ADR 0005](ADR-0005-household-membership-lifecycle.md)) prevent the last owner from leaving, being removed, or being demoted in the same transaction.
- Users may belong to multiple households, and household names need not be globally unique. Authorization
  always uses membership rows, never names or creator provenance.
- Household-scoped routes carry the household UUID in the path. The application resolves the actor's current
  membership for every request; roles are not copied into the Spring Security session. Client-selected or
  displayed household state is not authorization evidence.
- Collection reads are scoped in the database to the actor's memberships. Detail reads query by both actor
  and household. An authenticated non-member receives the same `404 HOUSEHOLD_NOT_FOUND` response as a
  nonexistent household so the API does not disclose resource existence.
- The household schema adds `households` and `household_members`: primary keys, foreign keys, a membership-role
  check, a unique composite membership key, and an index supporting actor-scoped lists. There is no separate
  `created_by` authorization source. Foreign-key deletion remains restrictive until deletion lifecycle and
  retention are designed.
- A household name is trimmed at its outer boundary, must contain 1–100 Unicode code points, and cannot
  contain control characters. Interior spacing, case, and punctuation are preserved. PostgreSQL constraints
  enforce non-null, trimmed, nonempty, and length boundaries; application validation provides useful errors.
- There is no dedicated household-creation throttle. Creation is authenticated, and no public
  deployment is claimed. Abuse limits and quotas must be designed before public launch rather than reusing
  authentication limits with different semantics.

## API and browser consequences

The household API exposes `POST /api/households`, `GET /api/households`, and
`GET /api/households/{householdId}`. Responses expose the caller's role, not a general permission claim.
The list is ordered by creation instant then UUID and is intentionally unpaginated while household creation
and membership are individual user actions. Add bounded cursor pagination before introducing any bulk path or
if measured use makes the collection potentially large.

The signed-in web experience loads the caller's households. An empty list presents name-only creation;
successful creation immediately renders the authorized household. Loading, validation, unknown write outcome,
session expiry, CSRF rejection, and server failure remain distinct recoverable states. The browser keeps CSRF
and principal state in memory and never treats its displayed role or household ID as proof of access.

## Subsequent decisions and remaining limits

[ADR 0004](ADR-0004-capability-household-invitations.md) defines capability
invitations; [ADR 0005](ADR-0005-household-membership-lifecycle.md) defines
roster, role and departure safety. Selected transaction visibility is implemented
under [ADR 0006](ADR-0006-manual-finance-contracts.md). A persistent preferred
household and Android authentication transport remain outside this decision.
Email remains unverified and does not recipient-bind household invitations.

## Verification

Tests cover PostgreSQL migration and Hibernate validation, transaction rollback, membership uniqueness,
creator ownership, actor-scoped list/detail queries, anonymous denial, indistinguishable missing/non-member
detail responses, malformed and forged request rejection, duplicate-name behavior, and concurrent creation,
plus signed-in empty/create/view flows with safe errors, expiry/CSRF recovery, duplicate-submit guards,
keyboard operation, phone/desktop reflow and no household request while signed out.
