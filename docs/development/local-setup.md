# Local development

## Status and prerequisites

This guide follows the root [Makefile](../../Makefile), [Compose configuration](../../compose.yaml),
and [environment example](../../.env.example). It describes disposable local development, not a
hosted service. Work from the repository root in an isolated checkout.

**Docker-first path:** Docker Engine with Compose v2 and Buildx is enough to build and run the
application containers. Native development additionally needs the toolchain below. Confirm that
your chosen database, backend and web host ports are free. Use a distinct Compose
project name to avoid reusing another stack's volume:

```sh
cp -n .env.example .env
export COMPOSE_PROJECT_NAME=housesync_showcase DB_PORT=58432 SERVER_PORT=58080 WEB_PORT=58081
docker compose --profile app up --build -d --wait --wait-timeout 180
curl -fsS http://127.0.0.1:58081/actuator/health/readiness
```

Use these exports in the **same shell** for every `docker compose` command, including
`docker compose --profile app down` (no `-v`). Compose loads `DB_PASSWORD` from the local
`.env`; explicit exported port values override `.env` interpolation. `COMPOSE_PROJECT_NAME`
overrides the root `name: housesync`; changing it later selects a different database volume.
Never run this against a volume containing valued records. `make app-up` uses the same exported
project/ports, but first creates `.env` if absent. On systems where `cp -n` differs, use
`test -e .env || cp .env.example .env` instead.

For a real, grant-gated local enrollment, with the stack above running:

```sh
docker compose --profile app exec -T backend java -jar /app/app.jar \
  --spring.main.web-application-type=none --spring.main.banner-mode=off \
  --logging.level.root=OFF --app.operator.action=issue-enrollment \
  --app.operator.email=person@example.test
```

The CLI prints `grantId`, `expiresAt`, and a one-use `code` once. Give the synthetic recipient
`http://127.0.0.1:58081/enroll#code=<code>` privately; the fragment is not sent to the server.
Enter `person@example.test` and a new password in the enrollment form. Registration does **not**
sign in: use the sign-in form afterwards. An anonymous browser cannot issue a grant; neither
the operator CLI nor CSRF may be bypassed. For an HTTP-only walkthrough with separate cookie
jars and a valid CSRF header, install `jq`, then run the following in a Bash terminal. Keep
the terminal, cookie jar and code private; this uses disposable local credentials only:

```bash
BASE=http://127.0.0.1:58081
COOKIE_JAR=$(mktemp)
chmod 600 "$COOKIE_JAR"
read -r -s -p 'One-use enrollment code: ' CODE; echo
read -r -s -p 'Disposable password: ' PASSWORD; echo
CSRF=$(curl -fsS -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$BASE/api/auth/csrf" | jq -r .token)
jq -n --arg email person@example.test --arg password "$PASSWORD" \
  --arg enrollmentCode "$CODE" \
  '{email:$email,password:$password,enrollmentCode:$enrollmentCode}' |
  curl -fsS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H 'Content-Type: application/json' \
    -H "X-CSRF-TOKEN: $CSRF" --data-binary @- "$BASE/api/auth/register"
jq -n --arg email person@example.test --arg password "$PASSWORD" \
  '{email:$email,password:$password}' |
  curl -fsS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -H 'Content-Type: application/json' \
    -H "X-CSRF-TOKEN: $CSRF" --data-binary @- "$BASE/api/auth/login"
curl -fsS -b "$COOKIE_JAR" "$BASE/api/auth/me"
rm -f "$COOKIE_JAR"
unset CODE PASSWORD CSRF
```

Use a fresh isolated project if the sample identity has already been registered; grants do
not reset existing accounts. See [identity API](../architecture/identity-api.md) for lifecycle
and [deployment boundary](deployment.md) for why a local run is not a hosted deployment.

For native backend/web development, provision:

- Java 21 JDK (`java` and `javac`, with `JAVA_HOME` consistent when set).
- Node 22, version 22.13 or newer within that major, and npm >=10.9.2 <11; `.nvmrc` pins the development baseline.
- Docker with a running accessible daemon, Compose v2 supporting profiles and `--wait`, and the Buildx plugin for image builds.
- GNU Make, Git, and a POSIX shell.
- `unzip`, `curl` or `wget`, and `sha256sum` or `shasum` for verified Maven wrapper downloads.

Use the checked-in Maven wrapper and npm-local tools. Do not install Maven, Vite, formatters, or test runners
globally for this project. Wrapper/dependency downloads and container builds may require network access.
Exact tool/plugin versions belong in manifests. `make setup` is not a system dependency installer.

### Ubuntu / Linux Mint example

For native development, install supported system packages as appropriate for your distribution:
```sh
sudo apt-get update
sudo apt-get install -y openjdk-21-jdk-headless docker.io docker-compose-v2 docker-buildx
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

The Docker group grants administrative daemon access. After joining it, log out and back in, use
`newgrp docker`, or run an individual command through `sg docker -c 'make doctor'`. Existing shells do
not automatically acquire the new group. Other operating systems should use their supported JDK and
Docker installation process; the repository command contract stays the same.

## First setup and native workflow

Run from the repository root:

```sh
make doctor
make setup
make db-up
```

`doctor` diagnoses prerequisites and exits nonzero when required tools/access are missing. `setup` copies
`.env.example` to `.env` only if `.env` is missing and installs locked web dependencies with `npm --prefix web ci`.
`db-up` starts and waits for PostgreSQL readiness.

In separate terminals:

```sh
make backend-dev
```

```sh
make web-dev
```

Open `http://localhost:5173`. Vite binds to localhost with a strict port and forwards `/api` and
`/actuator` to the native backend with prefixes preserved; the web requests `GET /actuator/health`.
`make web-dev` uses an explicit `API_PROXY_TARGET` when set, otherwise
`http://localhost:${SERVER_PORT:-8080}`. The backend configures
`/actuator/health/liveness` and `/actuator/health/readiness`, including database readiness;
health details are hidden. The web health display is a startup snapshot with a five-second
timeout, not continuous monitoring.

### Environment contract

Root `.env.example` contains these local-only defaults:

| Variable | Default | Native meaning |
| --- | --- | --- |
| `DB_HOST` | `localhost` | Loopback host publishing PostgreSQL |
| `DB_PORT` | `5432` | Published PostgreSQL port |
| `DB_NAME` | `housesync` | Local database name |
| `DB_USER` | `housesync` | Local database user |
| `DB_PASSWORD` | `housesync_local_only` | Disposable-development credential, never a production secret |
| `SERVER_PORT` | `8080` | Native backend port/default proxy target; also the Compose host-published backend port |
| `SERVER_ADDRESS` | `127.0.0.1` | Native Make listener only; Compose keeps its internal network listener. |
| `SESSION_COOKIE_SECURE` | `false` locally | Native Make/Compose explicitly permit local HTTP; standalone backend defaults to `true` for HTTPS. |
| `CONNECTED_FINANCE_ENABLED` | `false` | Optional private bank-linking routes; manual finance remains available when disabled. |
| `CONNECTED_FINANCE_PROVIDER` | `plaid` | Application adapter. `fake` requires the separate explicit fake flag and is local/test only. |
| `CONNECTED_FINANCE_FAKE_ALLOWED` | `false` | Must be `true` before the deterministic fake adapter can start. Never use it as production evidence. |
| `PLAID_ENV` | `sandbox` | Allowlisted provider environment; use `production` only with approved production configuration. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | empty | Server-only Plaid credentials required when enabled with provider `plaid`. |
| `PLAID_REDIRECT_URL`, `PLAID_WEBHOOK_URL` | empty | Deployment URLs; do not configure them for local manual-finance development. |
| `CONNECTED_FINANCE_KEYS` | empty | Rotation-capable `keyId:base64(32-byte-key)` set; required whenever connected finance is enabled. |
| `CATEGORIZATION_AI_ENABLED` | `false` | Opt in to owner-private, suggestion-only AI work; no jobs or provider calls while disabled. |
| `CATEGORIZATION_AI_KEY`, `CATEGORIZATION_AI_MODEL`, `CATEGORIZATION_AI_POLICY` | empty | Server-only credential, exact model, and a stable 1-32-character `[A-Za-z0-9_.-]` policy; all are required when enabled. Change policy when prompt/validation rules change. |
| `CATEGORIZATION_AI_BASE_URL` | `https://api.openai.com/v1/chat/completions` | Full trusted Chat Completions-compatible endpoint, not a root URL. Use HTTPS for real provider calls. |
| `CATEGORIZATION_AI_TIMEOUT_MS` | `5000` | Outbound timeout; startup accepts 500-15000 ms. |
| `CATEGORIZATION_AI_POLL_MS` | `1000` | Background due-work sweep; no worker runs while disabled. |

Keep `.env` local and excluded from version control. Both native Make targets source/export root `.env`;
assignments in that file replace the corresponding inherited environment values. Use shell-compatible
assignments and do not source an untrusted environment file. The backend requires a nonblank `DB_PASSWORD`.
Database secrets must never enter browser-exposed build variables.
Provider credentials and encryption keys are server-only and must not be committed. Enabled connected finance
fails startup closed when provider credentials, allowlisted environment, or AES-256 keys are invalid. For a
bounded local fake-adapter journey, set provider `fake`, opt in with `CONNECTED_FINANCE_FAKE_ALLOWED=true`, and
generate a disposable 32-byte key; do not treat that journey as Plaid Sandbox verification. The fake adapter then
also serves deterministic transaction-sync pages, so the private bank-activity inbox, manual sync, and
confirm/dismiss flows can be exercised without a provider account; the sync worker interval and scrub timings are
optional `app.connected-finance.sync-*` properties that keep their documented defaults.

Optional AI is a server-side adapter, not a browser integration. A local HTTP fake may be used only with
disposable credentials against an isolated Compose project; do not expose it publicly. The default endpoint
and empty key make no call until `CATEGORIZATION_AI_ENABLED=true` and the required model/policy/key are
supplied. The adapter sends only a bounded normalized description, entry kind, and normalized bank category
codes when present; it validates structured output before creating a private review. It never assigns a
ledger category. Transient timeouts, transport outages, HTTP 429, and 5xx may retry twice (three calls total);
validation and authentication failures are terminal. A finance member's status returns only their own
pending and failed work counts without model text or entry details. Paid-provider quality is unverified.
A production retention/erasure policy remains a prerequisite before public deployment.

`API_PROXY_TARGET` is an optional tooling-only override, absent from the default example. Set it in root
`.env` or pass it to `make web-dev` (provided root `.env` does not replace it). Restart Vite after changes.
Direct `npm --prefix web run dev` uses Vite's own environment loading and defaults to `http://localhost:8080`;
it does not perform the Make target's root `.env` export or `SERVER_PORT` derivation. The override is not
injected into the browser bundle and does not change the container nginx upstream.

Compose reads its environment for interpolation, but that alone does not configure the native backend;
the Make target's export step supplies the application's environment. Direct Maven invocation requires
the caller to provide equivalent environment values.

`make backend-dev` defaults its listener to `127.0.0.1` and supplies `SESSION_COOKIE_SECURE=false` when absent after loading `.env`; Compose supplies
the same local default. Existing `.env` files therefore continue to work without being overwritten. For direct
Maven/JAR runs over plain HTTP, set it explicitly to false. Production must use HTTPS and Secure cookies.

The UI now supports registration and sign-in. Registration does not auto-login. Sessions are stored in the
same PostgreSQL database via Flyway-managed Spring Session tables, survive backend restarts, and expire after
30 minutes idle. See the [identity API](../architecture/identity-api.md) for CSRF/logout and lifecycle behavior.

### Ports and hostnames

| Service | Native/local address | Container-network address |
| --- | --- | --- |
| PostgreSQL | `localhost:${DB_PORT:-5432}` | `postgres:5432` |
| Backend | `localhost:${SERVER_PORT:-8080}` | `backend:8080` |
| Native web development | `localhost:5173` | Not part of the native workflow |
| Container web | `localhost:${WEB_PORT:-8081}` | Web server listens on port `8080` |

Host-published Compose ports bind to `127.0.0.1`. Within a container, `localhost` refers to that container.
Compose sets backend `DB_HOST=postgres`, `DB_PORT=5432`, and `SERVER_PORT=8080`; nginx uses `backend:8080`.
Changing root `SERVER_PORT` changes the published backend port (`127.0.0.1:${SERVER_PORT:-8080}:8080`),
not the container listener or nginx upstream. Likewise `DB_PORT` changes only PostgreSQL's host publication.
Database name/user default to `housesync`; Compose requires the password supplied by the local example or `.env`.

## Command reference

All targets run from the repository root. Maven targets use
`sh backend/mvnw -f backend/pom.xml --batch-mode --no-transfer-progress`.

| Target | Behavior |
| --- | --- |
| `make setup` | Copy missing `.env` without overwriting it; run `npm ci` for `web/`. |
| `make doctor` | Check/report local toolchain and Docker prerequisites with actionable failures. |
| `make db-up` | `docker compose up -d --wait postgres` |
| `make db-down` | `docker compose stop postgres`; retain database data. |
| `make backend-dev` | Export root `.env`, then invoke the Maven wrapper with `spring-boot:run`. |
| `make web-dev` | Export root `.env`; run `npm --prefix web run dev` with explicit `API_PROXY_TARGET` or a target derived from `SERVER_PORT`. |
| `make backend-check` | Maven wrapper `verify`, including Docker-dependent PostgreSQL integration checks. |
| `make web-check` | Web `lint`, `typecheck`, `format:check`, `test`, and `build` scripts. |
| `make verify` | Backend verification plus all web checks. |
| `make format` | Maven `spotless:apply`, then `npm --prefix web run format`; review changes within file ownership. |
| `make app-up` | `docker compose --profile app up --build -d --wait --wait-timeout 180` |
| `make down` | `docker compose --profile app down`; preserve the database volume. |

`setup`, `db-up`, `backend-dev`, `web-dev`, and `app-up` create missing `.env` through a Make prerequisite.
Checks use the test environment rather than loading the development `.env`. Exact formatter versions and
bindings live in `backend/pom.xml` and `web/package.json`. Do not regenerate lockfiles to bypass a failing install.

## Optional application containers

Ensure the root environment file is present. Stop native processes that occupy the same ports, then run:

```sh
make app-up
```

Open `http://localhost:8081` by default, or the configured `WEB_PORT` (58081 in the isolated example above). The web container serves built assets on its internal port 8080 and proxies
API requests to the backend. PostgreSQL remains the only default Compose service; backend and web require
the `app` profile. Container startup needs Docker/Compose and the configured builds; it does not prove
native toolchain checks have passed.

Use `make down` to remove the stack's containers/network while retaining its database volume.
For native development, stop backend/web terminal processes and use `make db-down` to stop only PostgreSQL.
Do not use volume-removal flags as a routine shutdown or troubleshooting step.

## Targeted troubleshooting

| Symptom | Check and next action |
| --- | --- |
| Java missing/wrong version | Check `java -version`, `javac -version`, and `JAVA_HOME`; provide JDK 21 before native backend checks. |
| Node/lockfile failure | Check `node --version` and the web manifest/lockfile; use Node 22 >=22.13 and `npm ci`, preserving the lockfile. |
| Docker unavailable | Check `docker info` and `docker compose version`; restore daemon access. After being added to the `docker` group, log out/in or use `sg docker -c 'make doctor'` to refresh access in a child shell. |
| Docker build unavailable | Check `docker buildx version`; install the Buildx plugin before `make app-up`. Ubuntu/Mint packages split it into `docker-buildx`. |
| PostgreSQL startup failure | Inspect `docker compose ps` and `docker compose logs postgres` in the same exported project; check port occupancy and environment values without publishing secrets. |
| Database password changed but login still fails | PostgreSQL initialization variables do not reset users in an existing data volume; reconcile credentials deliberately while preserving needed data. |
| Native API/proxy failure | Check backend startup and `SERVER_PORT`; restart web dev after proxy changes. Inspect actual API route/rewrite configuration. |
| Container API failure | Inspect web/backend service logs and health status; confirm service DNS and container ports rather than using `localhost` between containers. |
| Published port already occupied | Stop the conflicting native/container process or deliberately update supported configuration; keep backend/proxy settings aligned. |
| Download/build blocked | Record the exact network/tool/dependency error and stop that branch; do not describe partial execution as a successful setup. |

Run [verification](testing.md) once prerequisites are available. See [deployment](deployment.md) for
the distinction between local containers, a separately reviewed private deployment, and public-service
readiness. Local `.env` values are disposable development defaults, never deployment defaults.
