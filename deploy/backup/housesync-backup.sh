#!/bin/sh
#
# Reference nightly encrypted backup; target/operator must review before installation.
#
# Writes into $BACKUP_DIR (default /var/backups/housesync):
#   housesync-<YYYY-MM-DD_HHMM>.dump.age       `pg_dump -Fc` database archive, age-encrypted
#   housesync-config-<YYYY-MM-DD>.tar.gz.age   host `.env` plus the `deploy/` overlay, age-encrypted
#   last-success / last-failure                run markers: timestamp, artifact names, byte sizes, reason
#
# Encryption model: this host knows only the age *public* recipient read from $RECIPIENT_FILE. The
# private key must stay off-host. Operator runbook: deploy/backup/README.md.
#
# Invariants:
#   * fail closed - a missing recipient, a missing or stopped database container, a missing
#     configuration source, an empty or non-PGDMP dump, or any encryption failure aborts the run;
#   * never publish a partial artifact - ciphertext is written to a hidden temp name in $BACKUP_DIR and
#     renamed into place only after age exits 0, so a failed run cannot damage the previous backup;
#   * never leave plaintext behind - the dump and the configuration tarball exist only as mode-600 temp
#     files that the EXIT trap removes on every path, success or failure;
#   * never print a secret - the recipient, `.env` contents and row data stay out of the log.
#
# Installed as /usr/local/sbin/housesync-backup and scheduled by housesync-backup.timer.
# Manual run: sudo /usr/local/sbin/housesync-backup
set -eu

# --- Environment (every value overridable; housesync-backup.service sets none of them) ------------
BACKUP_DIR=${BACKUP_DIR:-/var/backups/housesync}
RECIPIENT_FILE=${RECIPIENT_FILE:-/etc/housesync/backup-recipient}
CONTAINER=${CONTAINER:-housesync_hosted_example-postgres-1}
DB=${DB:-housesync}
DB_USER=${DB_USER:-housesync}
RETENTION_DAYS=${RETENTION_DAYS:-90}
SOURCE_DIR=${SOURCE_DIR:-/opt/housesync}
BACKUP_GROUP=${BACKUP_GROUP:-backupreader}

# --- Helpers --------------------------------------------------------------------------------------

log() {
  # Every step is timestamped on stdout; journald adds its own arrival time (journalctl -u).
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  failure_reason=$*
  exit 1
}

group_exists() {
  if command -v getent >/dev/null 2>&1; then
    getent group "$1" >/dev/null 2>&1
  else
    grep -q "^$1:" /etc/group
  fi
}

discard() {
  if [ -n "$1" ]; then
    rm -f -- "$1" 2>/dev/null || true
  fi
}

set_artifact_perms() {
  # 640 plus group $BACKUP_GROUP is what the NAS pull needs: readable by the restricted pull
  # account and by nobody else. A missing group is a deployment error, not something to paper over.
  chmod 640 "$1"
  if [ "$group_present" -eq 1 ]; then
    chgrp "$BACKUP_GROUP" "$1"
  else
    log "WARNING: group $BACKUP_GROUP does not exist; $1 is not readable for the NAS pull"
  fi
}

repair_artifact_perms() {
  # A run killed between `mv` and chmod would otherwise leave one artifact mode 600 forever, and the
  # file name never repeats, so every run re-applies the permissions to everything it keeps.
  for artifact in "$BACKUP_DIR"/housesync-*.dump.age "$BACKUP_DIR"/housesync-config-*.tar.gz.age; do
    if [ -f "$artifact" ]; then
      set_artifact_perms "$artifact"
    fi
  done
}

prune_old() {
  # `-mtime +N` is "modified more than N days ago", i.e. older than the retention window.
  pattern=$1
  stale=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$pattern" -mtime "+$RETENTION_DAYS")
  while IFS= read -r old; do
    if [ -n "$old" ]; then
      log "retention: removing $(basename "$old")"
      rm -f -- "$old"
    fi
  done <<EOF
$stale
EOF
}

# --- Working state and the one cleanup path -------------------------------------------------------

tmp_dump=''
tmp_config=''
tmp_age_dump=''
tmp_age_config=''
failure_reason=''
succeeded=0
group_present=0

cleanup() {
  status=$?
  # Plaintext first: whatever else happens, the dump and the configuration tarball must not survive.
  discard "$tmp_dump"
  discard "$tmp_config"
  discard "$tmp_age_dump"
  discard "$tmp_age_config"
  if [ "$succeeded" -eq 0 ]; then
    if [ -z "$failure_reason" ]; then
      failure_reason="unexpected exit status $status"
    fi
    log "FAILURE: $failure_reason"
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$failure_reason" >"$BACKUP_DIR/last-failure" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

# --- Preconditions: fail closed before touching any artifact --------------------------------------

log "starting: container=$CONTAINER db=$DB user=$DB_USER dir=$BACKUP_DIR retention=${RETENTION_DAYS}d"

# The destination exists before any marker can be written. Mode 750 keeps it away from unprivileged
# users; group $BACKUP_GROUP carries the read-only grant the NAS pull runs under.
mkdir -p "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"
if group_exists "$BACKUP_GROUP"; then
  group_present=1
  chgrp "$BACKUP_GROUP" "$BACKUP_DIR"
fi

for tool in docker age; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    die "$tool not found in PATH; install it first (age: apt-get install -y age)"
  fi
done

if [ ! -f "$RECIPIENT_FILE" ]; then
  die "recipient file $RECIPIENT_FILE is missing; install the age public recipient there (deploy/backup/README.md)"
fi
if [ ! -r "$RECIPIENT_FILE" ]; then
  die "recipient file $RECIPIENT_FILE is not readable by this job"
fi
recipient=$(cat "$RECIPIENT_FILE")
if [ -z "$recipient" ]; then
  die "recipient file $RECIPIENT_FILE is empty"
fi
case "$recipient" in
  age1*) : ;;
  *) die "recipient file $RECIPIENT_FILE does not hold an age1... public recipient (content not logged)" ;;
esac

container_state=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)
if [ "$container_state" != 'true' ]; then
  die "container $CONTAINER is missing or not running; start the stack before backing it up"
fi
log "container $CONTAINER is running"

stamp=$(date -u '+%Y-%m-%d_%H%M')
day=$(date -u '+%Y-%m-%d')
dump_name="housesync-$stamp.dump.age"
config_name="housesync-config-$day.tar.gz.age"

# --- Database dump --------------------------------------------------------------------------------

tmp_dump=$(mktemp)
chmod 600 "$tmp_dump"
log "dumping $DB (custom format) out of $CONTAINER"
if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" -Fc >"$tmp_dump"; then
  die "pg_dump failed inside $CONTAINER; the database is untouched but this night has no backup"
fi
if [ ! -s "$tmp_dump" ]; then
  die "pg_dump wrote an empty archive; refusing to encrypt it"
fi
dump_bytes=$(wc -c <"$tmp_dump")
if [ "$(dd if="$tmp_dump" bs=1 count=5 2>/dev/null)" != 'PGDMP' ]; then
  die "archive does not start with the PGDMP magic bytes ($dump_bytes bytes read); refusing a partial dump"
fi
log "dump ok: $dump_bytes bytes, PGDMP archive"

tmp_age_dump=$(mktemp "$BACKUP_DIR/.$dump_name.XXXXXX")
chmod 600 "$tmp_age_dump"
log "encrypting the dump to $dump_name"
if ! age -r "$recipient" -o "$tmp_age_dump" "$tmp_dump"; then
  die "age failed to encrypt the database dump; no artifact was published"
fi
mv -f "$tmp_age_dump" "$BACKUP_DIR/$dump_name"
tmp_age_dump=''
set_artifact_perms "$BACKUP_DIR/$dump_name"
log "published $dump_name ($(wc -c <"$BACKUP_DIR/$dump_name") bytes encrypted)"

# --- Configuration archive (.env plus the deploy/ overlay) -----------------------------------------

if [ ! -f "$SOURCE_DIR/.env" ]; then
  die "configuration source $SOURCE_DIR/.env is missing; refusing a partial configuration backup"
fi
if [ ! -d "$SOURCE_DIR/deploy" ]; then
  die "configuration source $SOURCE_DIR/deploy/ is missing; refusing a partial configuration backup"
fi

tmp_config=$(mktemp)
chmod 600 "$tmp_config"
log "archiving $SOURCE_DIR/.env and $SOURCE_DIR/deploy into $config_name"
if ! tar -czf "$tmp_config" -C "$SOURCE_DIR" .env deploy; then
  die "tar failed to archive the configuration; no artifact was published"
fi
if [ ! -s "$tmp_config" ]; then
  die "configuration archive is empty; refusing to encrypt it"
fi
if [ "$(dd if="$tmp_config" bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')" != '1f8b' ]; then
  die "configuration archive is not a gzip stream; refusing to encrypt it"
fi

tmp_age_config=$(mktemp "$BACKUP_DIR/.$config_name.XXXXXX")
chmod 600 "$tmp_age_config"
log "encrypting the configuration archive to $config_name"
if ! age -r "$recipient" -o "$tmp_age_config" "$tmp_config"; then
  die "age failed to encrypt the configuration archive; no artifact was published"
fi
mv -f "$tmp_age_config" "$BACKUP_DIR/$config_name"
tmp_age_config=''
set_artifact_perms "$BACKUP_DIR/$config_name"
log "published $config_name ($(wc -c <"$BACKUP_DIR/$config_name") bytes encrypted)"

# --- Retention, permissions, receipt ---------------------------------------------------------------

log "pruning artifacts older than ${RETENTION_DAYS} days"
prune_old 'housesync-*.dump.age'
prune_old 'housesync-config-*.tar.gz.age'
# Leftover ciphertext from a killed run: same window, so a crashed run cannot fill the disk either.
prune_old '.housesync-*'

repair_artifact_perms

now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
{
  printf '%s %s %s bytes\n' "$now" "$dump_name" "$(wc -c <"$BACKUP_DIR/$dump_name")"
  printf '%s %s %s bytes\n' "$now" "$config_name" "$(wc -c <"$BACKUP_DIR/$config_name")"
} >"$BACKUP_DIR/last-success"
# A success resolves the previous failure; a failure leaves the previous success in place, so that
# file stays the record of the newest recoverable checkpoint.
rm -f "$BACKUP_DIR/last-failure"
succeeded=1
log "success: $dump_name and $config_name in $BACKUP_DIR"
