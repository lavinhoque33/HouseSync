# Development infrastructure

The root [`compose.yaml`](../compose.yaml) defines PostgreSQL 17 and an optional
`app` profile for the backend and web images. Root placement keeps `docker compose`
and `.env` discovery predictable. [`Makefile`](../Makefile) is the native command entry point.

- `infrastructure/scripts/doctor.sh` checks native toolchain and Docker access.
- PostgreSQL is the only default service; its named volume survives normal shutdown.
- Published ports bind to `127.0.0.1`; `WEB_PORT` defaults to 8081. Container services
  communicate using Compose DNS.
- The root Compose file declares `name: housesync`; export a distinct `COMPOSE_PROJECT_NAME`
  **before first startup** to isolate a disposable stack's containers, networks and database
  volume. Also choose unused `DB_PORT`, `SERVER_PORT` and `WEB_PORT` for host publishing. Do not change the
  project name later and accidentally abandon or target a different volume.
- Backend readiness checks database connectivity; the web forwards API paths unchanged.
- `.env.example` contains disposable local defaults. Real `.env` files are ignored; native Make
  sources root `.env` and may replace inherited shell values.

Start with the [Docker-first local walkthrough](../docs/development/local-setup.md), then read
[testing](../docs/development/testing.md) and [deployment boundaries](../docs/development/deployment.md).
The separate [`deploy/`](../deploy/README.md) hosted reference requires target-specific operator review;
neither local Compose nor this repository certifies a public financial service.
