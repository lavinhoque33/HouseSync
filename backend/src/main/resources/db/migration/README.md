# Database migrations

Flyway owns the PostgreSQL schema. The first migrations establish identity, sessions and households:

- `V1__create_users.sql`: application users with canonical unique email,
  delegating password hash, and creation timestamp.
- `V2__create_spring_session.sql`: server-side session storage. This is the
  official Spring Session 4.1.1 PostgreSQL schema (from the
  `spring-session-jdbc` artifact managed by Spring Boot 4.1.1), adopted as a
  Flyway migration. Automatic session schema initialization stays disabled
  (`spring.session.jdbc.initialize-schema=never`); the same PostgreSQL
  database serves both identity and session data. Hibernate uses
  `ddl-auto: validate` and never creates or updates tables.
- `V3__widen_spring_session_principal_name.sql`: widens
  `SPRING_SESSION.PRINCIPAL_NAME` to `VARCHAR(254)`. The official schema used
  `VARCHAR(100)`, but the session principal is the canonical login email of up
  to 254 characters, so valid long emails could register yet fail at
  login-session save. Forward-only correction; V1/V2 stay immutable.
- `V4__create_households.sql`: households plus membership with the creator
  `OWNER` role. Covers primary keys, restrictive foreign keys, the composite
  membership key, the membership-role check, household-name checks
  (non-null, outer-trimmed including Unicode whitespace/space separators,
  nonempty, 1–100 characters, no control characters), and the actor index for
  membership-scoped reads. Non-ASCII boundary characters are built with
  `chr(codepoint)` so the migration stays plain ASCII. There is deliberately
  no `created_by` authorization source; authorization uses membership rows only.

Add follow-ups as monotonically increasing versions such as
`V26__descriptive_name.sql`, using lowercase snake_case descriptions, and
review migrations with the application change. Never edit or renumber a
migration that has run in a shared environment; add a forward migration
instead. Do not add dummy tables or empty SQL files just to populate this
directory.

Keep credentials and environment-specific values out of SQL. Test each
migration against PostgreSQL 17 via `./mvnw verify`, including a fresh
database and, when real migrations exist, an upgrade from the prior schema.
Flyway clean is disabled and automatic baselining is not enabled.
