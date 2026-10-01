# Hosted overlay: operator-reviewed reference

The overlay combines root `compose.yaml` with `deploy/compose.hosted.yaml`: Caddy terminates HTTPS and routes to the web nginx container, which forwards API paths to the backend; PostgreSQL, backend and web remain loopback-published on the host. Caddy publishes TCP 80/443. It has no shared edge Basic authentication: sign-in and the landing page become public when deployed, while account creation still requires a one-use recipient-bound operator grant. **This is not an approved production deployment recipe.** No operator, domain, host, recovery objectives, security review, populated-data drill or alert receiver is supplied by this repository. Follow [deployment boundaries](../docs/development/deployment.md).

## Review before any hosted use

An authorized operator must choose and review a target host and access policy, DNS/TLS, firewall (including SSH policy), source/artifact transfer, persistent storage, secret custody, data retention, backup destination, alert receiver, recovery objectives and rollback. Docker group access is root-equivalent; keep the operator CLI and PostgreSQL private. The overlay only publishes Caddy externally, but firewalls must independently enforce that restriction. Inspect `docker compose ... config` without leaking interpolated secrets into logs. The `.test` hostname in [`hosted.env.example`](hosted.env.example) is intentionally unusable publicly; do **not** deploy it unchanged. Keep optional Plaid/AI disabled until separately approved and reviewed. Root `.env.example` is only for local development.

For an **operator-approved** single-host example, install Docker Engine/Compose v2 and Buildx and arrange a reviewed source tree at an operator-selected location, e.g. `/opt/housesync`. In that tree, create `.env` from `deploy/hosted.env.example` only if no host `.env` exists, replace `DOMAIN` with a controlled DNS hostname, and generate a unique database password with `openssl rand -base64 32`. Keep `SESSION_COOKIE_SECURE=true`, restrict `.env` to the operator and never commit it. If the volume exists, changing `DB_PASSWORD` in `.env` does not re-key PostgreSQL. Confirm local `DB_PORT`, `SERVER_PORT` and fixed web port 8081 are free; choose `COMPOSE_PROJECT_NAME` before creating the database volume and retain it consistently for every command. Do not run these commands on another operator's installation.

```sh
# Run from the approved host's source-tree root after configuring its untracked .env.
export COMPOSE_PROJECT_NAME=housesync_hosted_example
# Stop: review this rendered configuration securely before creating containers.
docker compose -f compose.yaml -f deploy/compose.hosted.yaml --profile app config
# After review and permission to deploy:
docker compose -f compose.yaml -f deploy/compose.hosted.yaml --profile app up -d --build --wait
```

The `app` profile is required: omitting it starts PostgreSQL and Caddy, but not backend or web, yielding 502. Caddy deliberately has no profile so it cannot silently disappear from a deployment command. Compose health checks wait for PostgreSQL and backend and the nginx root, **not** real TLS, web-to-API routing, financial journeys or a backup. In the same shell/project, use `... ps`, `... logs caddy`, `... logs backend`; repeat `... up -d --build --wait` only after review. `... down` retains PostgreSQL and Caddy certificate volumes. Never add `-v`/`--volumes`: it removes the database and TLS state. Image rollback does not reverse Flyway migrations. An operator must document artifact provenance and removed files; do not use an anonymous public `git archive` command as a deployment approval mechanism.

After operator-controlled DNS/certificate issuance, set `BASE=https://<approved-hostname>` in a private shell and check the root, `/api/auth/csrf`, and `/actuator/health/readiness` with `curl`; `/actuator/env` must return 404 at Caddy, anonymous `/api/auth/me` 401, and logout without CSRF 403. Confirm that PostgreSQL/backend/operator surfaces are unreachable externally and inspect the actual certificate in a browser. The Caddyfile repeats security headers in `handle_errors` so generated errors keep them. Its allowed health probes are public; review that exposure for the actual environment. With Caddy's default HTTP/3 advertisement but no UDP 443 publication, clients fall back to TCP; add UDP only after explicit network review.

## Grant-gated account lifecycle

The operator verifies and approves a recipient **out of band**. From the approved source-tree root with a healthy backend and the same Compose project export:

```sh
docker compose -f compose.yaml -f deploy/compose.hosted.yaml --profile app exec -T backend \
  java -jar /app/app.jar --spring.main.web-application-type=none \
  --spring.main.banner-mode=off --logging.level.root=OFF \
  --app.operator.action=issue-enrollment --app.operator.email=person@example.test
```

The separate process prints `grantId`, `expiresAt`, and `code` **once**. A recipient-bound grant expires after 24 hours, cannot be reused, and does not auto-login the new user. Privately hand over `https://<approved-hostname>/enroll#code=<code>`; never place the code in a query string, issue, monitoring, shell history or saved script. The recipient enters the matching email and sets their own password, then signs in. The operator may revoke an undelivered grant with `--app.operator.action=revoke --app.operator.grant-id=<grantId>` instead of email. For recovery, first verify the account holder by a trusted out-of-band channel, then use `--app.operator.action=issue-recovery --app.operator.email=<existing-email>` and privately deliver `/recover#code=<code>`; a successful reset revokes sessions. Email alone is not ownership proof.

For departure, have a household owner transfer ownership and remove **all** memberships through normal application controls first; host operator privilege never grants household ownership. Then invoke the same CLI with `--app.operator.action=disable-account --app.operator.email=<existing-email>`; it rejects remaining memberships and disables the account/revokes sessions while retaining records. Do not manipulate database rows to bypass that guard. See [identity API](../docs/architecture/identity-api.md) for CSRF, sessions and response contracts. For a disposable localhost version of this exact enrollment flow (including HTTP requests), use [local setup](../docs/development/local-setup.md).

## Recovery and limits

The [backup and restore reference](backup/README.md) explains the age recipient, encrypted logical dump and configuration, off-host NAS pull, failure markers, key custody, restricted SSH and isolated restore. Those scripts alone do not prove any alert was delivered or any real data was restored. A real operator must record restore reconciliation for representative populated records, whole-host recovery timing, disk/resource alerting, key custody and operational response before promising recovery. Public source is not a public financial service.
