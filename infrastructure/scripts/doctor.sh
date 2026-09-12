#!/bin/sh
# Read-only prerequisite check. Run through `make doctor` or `sh`.
set -u
failed=0

ok() { printf '[OK] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; failed=1; }

if command -v java >/dev/null 2>&1; then
  version=$(java -version 2>&1)
  case "$version" in
    *'version "21.'*) ok 'Java 21 runtime available' ;;
    *) fail 'Use Java 21; check java -version and JAVA_HOME' ;;
  esac
else
  fail 'Java missing: install a Java 21 JDK and set JAVA_HOME'
fi
if command -v javac >/dev/null 2>&1; then
  case "$(javac -version 2>&1)" in
    'javac 21.'*) ok 'Java 21 compiler available' ;;
    *) fail 'Use the Java 21 compiler; check javac -version and JAVA_HOME' ;;
  esac
else
  fail 'javac missing: a full JDK 21 is required, not only a JRE'
fi

if command -v node >/dev/null 2>&1; then
  if node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 22 && minor >= 13 ? 0 : 1)'; then
    ok "Node $(node --version) available"
  else
    fail 'Use Node 22 >=22.13; nvm use reads the root .nvmrc'
  fi
else
  fail 'Node missing: install Node 22 >=22.13 (see .nvmrc)'
fi
if command -v npm >/dev/null 2>&1; then
  npm_version=$(npm --version)
  if command -v node >/dev/null 2>&1 && node -e 'const [a,b,c] = process.argv[1].split(".").map(Number); process.exit(a === 10 && (b > 9 || (b === 9 && c >= 2)) ? 0 : 1)' "$npm_version"; then
    ok "npm $npm_version available"
  else
    fail 'Use npm >=10.9.2 <11, matching web/package.json'
  fi
else
  fail 'npm missing: install npm with the supported Node toolchain'
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok 'Docker daemon accessible'
  else
    fail 'Docker daemon inaccessible: start Docker and check docker info'
  fi
  if docker compose version >/dev/null 2>&1 && docker compose up --help | command grep -q -- --wait; then
    ok 'Docker Compose supports --wait'
  else
    fail 'Install/update Docker Compose v2 with profiles and --wait support'
  fi
  if docker buildx version >/dev/null 2>&1; then
    ok 'Docker Buildx available for application image builds'
  else
    fail 'Install the Docker Buildx plugin for make app-up image builds'
  fi
else
  fail 'Docker missing: install Docker Engine/Desktop and Compose v2 for PostgreSQL and integration tests'
fi

if command -v git >/dev/null 2>&1; then ok 'Git available'; else fail 'Install Git for version control'; fi
if command -v make >/dev/null 2>&1; then ok 'Make available'; else fail 'Install GNU Make for root commands'; fi
if command -v unzip >/dev/null 2>&1; then ok 'unzip available'; else fail 'Install unzip for the checksum-pinned Maven ZIP download'; fi
if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
  ok 'Maven download tool available'
else
  fail 'Install curl or wget for Maven wrapper downloads'
fi
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then
  ok 'SHA-256 verification tool available'
else
  fail 'Install sha256sum or shasum for Maven distribution verification'
fi

if [ "$failed" -eq 0 ]; then
  printf '\nPrerequisites available. Next: make setup && make db-up\n'
else
  printf '\nResolve the missing prerequisites above; see docs/development/local-setup.md.\n'
fi
exit "$failed"
