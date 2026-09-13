SHELL := /bin/sh
.DEFAULT_GOAL := help

MVN := sh backend/mvnw -f backend/pom.xml --batch-mode --no-transfer-progress
# Native applications do not read Compose's environment file themselves.
LOAD_ENV = set -a; if [ -f .env ]; then . ./.env; fi; set +a;

.PHONY: help setup doctor db-up db-down backend-dev web-dev backend-check web-check verify format app-up down

help:
	@printf '%s\n' \
	  'HouseSync development (run from the repository root)' \
	  '  setup          Create missing .env and install locked web dependencies' \
	  '  doctor         Check native tools and Docker access' \
	  '  db-up/db-down  Start/wait for or stop PostgreSQL; retain data' \
	  '  backend-dev    Run the API with root .env configuration' \
	  '  web-dev        Run Vite on localhost:5173 with the API proxy' \
	  '  backend-check  Format check, tests, package, PostgreSQL integration tests' \
	  '  web-check      Lint, types, formatting, tests, production build' \
	  '  verify         Run both check suites (requires Docker and JDK 21)' \
	  '  format         Apply backend and web formatters' \
	  '  app-up         Build/start/wait for the container stack; web on :8081' \
	  '  down           Remove stack containers/network; retain database volume'

.env:
	cp .env.example .env

setup: .env
	npm --prefix web ci

doctor:
	@sh infrastructure/scripts/doctor.sh

db-up: .env
	docker compose up -d --wait postgres

db-down:
	docker compose stop postgres

backend-dev: .env
	@$(LOAD_ENV) SERVER_ADDRESS="$${SERVER_ADDRESS:-127.0.0.1}" SESSION_COOKIE_SECURE="$${SESSION_COOKIE_SECURE:-false}" $(MVN) spring-boot:run

web-dev: .env
	@$(LOAD_ENV) API_PROXY_TARGET="$${API_PROXY_TARGET:-http://localhost:$${SERVER_PORT:-8080}}" npm --prefix web run dev

backend-check:
	$(MVN) verify

web-check:
	npm --prefix web run lint
	npm --prefix web run typecheck
	npm --prefix web run format:check
	npm --prefix web test
	npm --prefix web run build

verify: backend-check web-check

format:
	$(MVN) spotless:apply
	npm --prefix web run format

app-up: .env
	docker compose --profile app up --build -d --wait --wait-timeout 180

down:
	docker compose --profile app down
