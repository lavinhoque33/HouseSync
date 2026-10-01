#!/bin/sh
# --------------------------------------------------------------------------------------------------
# HouseSync example NAS pull task; review target settings before installation.
#
# Install (see deploy/backup/README.md, "Synology pull"):
#   Control Panel > Task Scheduler > Create > Scheduled Task > User-defined script
#   General  : name `housesync-backup-pull`, user `root`, enabled
#   Schedule : daily after the host job finishes; review both host/UTC timezones
#   Task Settings: tick "Send run details by email" and "Send run details only when the script
#                  terminates abnormally"; this script also logs to /volume1/housesync-example/pull.log
#   Run command : the text of deploy/backup/synology-pull-task-stub.sh, which executes this file from
#                  /volume1/housesync-example/ - DSM's field is capped at 8192 characters and this
#                  script is larger, so it is uploaded to the shared folder rather than pasted
#
# Before the first upload, replace the three placeholders below (VPS_HOST and the two host keys) - the
# script aborts, loudly, while any of them is still a placeholder. Details and the full setup sequence
# are in deploy/backup/README.md ("Synology pull"), which mirrors this text; this file is the source
# of truth.
#
# What it does, in order:
#   1. refuses to run with an unreplaced placeholder;
#   2. requires the shared folder ($DEST) to exist and be writable;
#   3. creates /root/.ssh (700) and an ed25519 keypair for this NAS if they do not exist yet;
#   4. publishes the public half to the shared folder so the operator can install it on the VPS;
#   5. pins every VPS host key type in /root/.ssh/known_hosts - the pull never trusts an unverified key;
#   6. pulls the encrypted artifacts with rrsync over SSH and appends a timestamped line to pull.log;
#   7. fails when the server job has stopped producing new dumps, so DSM's abnormal-termination email
#      reports a backup that quietly stopped working instead of every night looking successful.
#
# No secret is printed: the private key is generated here, stays here, and its only export is the
# public half. Nothing on this NAS ever holds the age private key that decrypts the pulled files.
# --------------------------------------------------------------------------------------------------
set -eu

# DSM starts scheduled tasks with a minimal environment; this one can find OpenSSH, rsync and the
# Synology tools. Absolute paths below are used for the two binaries this task depends on.
PATH=/usr/syno/sbin:/usr/syno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# --- Operator settings: replace both placeholders before the first run -----------------------------

# Example shared folder on the NAS. Create and approve it first.
DEST=/volume1/housesync-example

# Restricted backup account and host. The host must match the pinned host keys below.
# The authorized_keys forced command must pin `rrsync -ro /var/backups/housesync`.
VPS_BACKUP_USER=backupreader
VPS_HOST=__REPLACE_WITH_VPS_HOST__

# The VPS host keys, pinned - one line per key type, all of them.
#
# Pin every type the VPS offers, not only the one this NAS negotiates today: the SSH client picks its
# own preference order, and a client that prefers ECDSA over ED25519 (Synology's `/etc/ssh/ssh_config`
# does) fails with "REMOTE HOST IDENTIFICATION HAS CHANGED" when only the ED25519 line is pinned.
# Fill both from one scan:
#   ssh-keyscan -t ed25519,ecdsa <vps-host>
# Keys are verified on every run (StrictHostKeyChecking=yes): a rebuilt VPS fails the pull until the
# operator re-pins the new keys here, which is the point. Never fetch a key at run time.
VPS_HOST_KEY_ED25519='__REPLACE_WITH_VPS_ED25519_HOST_KEY__'
VPS_HOST_KEY_ECDSA='__REPLACE_WITH_VPS_ECDSA_HOST_KEY__'

# UTC-hour freshness threshold. This example assumes a backup scheduled at 03:30 UTC
# and NAS pull after 04:30 UTC. Review the host timezone and completion time before
# trusting freshness alerts; disabled NAS tasks cannot send failure email.
STALE_CHECK_AFTER_UTC_HOUR=5

# --- Helpers ---------------------------------------------------------------------------------------

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

say() {
  # stdout, for the Task Scheduler output pane, and the pull log, so the reason survives.
  line=$(log "$@")
  printf '%s\n' "$line"
  if [ -d "$DEST" ]; then
    printf '%s\n' "$line" >>"$DEST/pull.log" 2>/dev/null || true
  fi
}

abort() {
  say "ABORT: $*"
  exit 1
}

pin_host_key() {
  # One pinned host key line: appended exactly once, tolerated on every rerun.
  key_line=$1
  key_label=$2
  if [ -z "$key_line" ]; then
    abort "$key_label is empty"
  fi
  if grep -Fqx -e "$key_line" /root/.ssh/known_hosts 2>/dev/null; then
    say "$key_label already pinned in /root/.ssh/known_hosts"
  else
    if ! printf '%s\n' "$key_line" >>/root/.ssh/known_hosts; then
      abort "could not write /root/.ssh/known_hosts"
    fi
    chmod 600 /root/.ssh/known_hosts
    say "$key_label pinned in /root/.ssh/known_hosts"
  fi
}

# --- 1. Placeholders -------------------------------------------------------------------------------

case "$VPS_HOST" in
  __REPLACE_*) abort "VPS_HOST is still the placeholder; set the real VPS host name in this task" ;;
esac
case "$VPS_HOST_KEY_ED25519" in
  __REPLACE_*) abort "VPS_HOST_KEY_ED25519 is still the placeholder; pin the real host keys first (ssh-keyscan -t ed25519,ecdsa $VPS_HOST)" ;;
esac
case "$VPS_HOST_KEY_ECDSA" in
  __REPLACE_*) abort "VPS_HOST_KEY_ECDSA is still the placeholder; pin the real host keys first (ssh-keyscan -t ed25519,ecdsa $VPS_HOST)" ;;
esac

# --- 2. Shared folder ------------------------------------------------------------------------------

if [ ! -d "$DEST" ]; then
  abort "shared folder $DEST does not exist; create the approved shared folder first"
fi
mkdir -p "$DEST/daily"
PULL_LOG="$DEST/pull.log"
if ! touch "$PULL_LOG" 2>/dev/null; then
  abort "cannot write $PULL_LOG; run this task as root"
fi

# --- 3. Root SSH directory and the NAS pull keypair ------------------------------------------------

if [ ! -d /root/.ssh ]; then
  mkdir -p /root/.ssh || abort "could not create /root/.ssh"
  say "created /root/.ssh"
fi
chmod 700 /root/.ssh

KEY=/root/.ssh/housesync_pull
if [ -f "$KEY" ]; then
  say "reusing the existing pull key $KEY"
else
  say "generating an ed25519 pull key at $KEY (comment housesync-nas, no passphrase)"
  # A passphrase would hang an unattended task, so the key is intentionally empty.
  ssh-keygen -t ed25519 -N '' -C housesync-nas -f "$KEY" >/dev/null || abort "ssh-keygen failed"
  chmod 600 "$KEY"
fi
if [ ! -f "$KEY.pub" ]; then
  ssh-keygen -y -f "$KEY" >"$KEY.pub" || abort "could not derive the public half of $KEY"
fi

# --- 4. Publish the public key ---------------------------------------------------------------------

if ! cat "$KEY.pub" >"$DEST/housesync_pull.pub"; then
  abort "could not write $DEST/housesync_pull.pub"
fi
chmod 644 "$DEST/housesync_pull.pub"
say "public key available at $DEST/housesync_pull.pub - send it to the VPS if this is a new key"

# --- 5. Pin the VPS host keys ----------------------------------------------------------------------

pin_host_key "$VPS_HOST_KEY_ED25519" "ED25519 host key"
pin_host_key "$VPS_HOST_KEY_ECDSA" "ECDSA host key"

# --- 6. Pull ---------------------------------------------------------------------------------------

say "pull start: $VPS_BACKUP_USER@$VPS_HOST:/ -> $DEST/daily/"
status=0
if /usr/bin/rsync -rt --ignore-existing --no-perms --no-owner --no-group \
  -e "/usr/bin/ssh -i /root/.ssh/housesync_pull -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/root/.ssh/known_hosts" \
  "$VPS_BACKUP_USER@$VPS_HOST:/" "$DEST/daily/" >>"$PULL_LOG" 2>&1; then
  status=0
else
  status=$?
fi
if [ "$status" -ne 0 ]; then
  abort "rsync pull failed with status $status; see the lines above in $PULL_LOG"
fi

count=0
for artifact in "$DEST/daily"/housesync-*.age; do
  if [ -f "$artifact" ]; then
    count=$((count + 1))
  fi
done
say "pull ok: $count encrypted artifact(s) now in $DEST/daily/"

# --- 7. Freshness guard ----------------------------------------------------------------------------

# The pull can succeed while the server job has been failing for nights: rsync copies whatever is
# there and exits 0, so the only symptom is that nothing new arrived. Compare the newest dump with the
# one seen on the previous pull and fail (non-zero exit) once a UTC date boundary has passed without a
# new one, which makes DSM's "terminated abnormally" email the alarm. See STALE_CHECK_AFTER_UTC_HOUR.
newest=
for artifact in "$DEST/daily"/housesync-*.dump.age; do
  if [ -f "$artifact" ]; then
    newest=${artifact##*/}
  fi
done
if [ -z "$newest" ]; then
  abort "no housesync-*.dump.age in $DEST/daily/ after a successful pull; the server has nothing to restore"
fi

state=$DEST/last-pull-check
previous_newest=
previous_date=
if [ -f "$state" ]; then
  read -r previous_newest previous_date <"$state" || true
fi
today=$(date -u '+%Y-%m-%d')
hour=$(date -u '+%H')
hour=${hour#0}
[ -n "$hour" ] || hour=0

if [ "$newest" = "$previous_newest" ] && [ -n "$previous_date" ] &&
   [ "$previous_date" != "$today" ] && [ "$hour" -ge "$STALE_CHECK_AFTER_UTC_HOUR" ]; then
  failure_note=
  if [ -f "$DEST/daily/last-failure" ]; then
    failure_note=" The server's own last-failure line: $(head -n 1 "$DEST/daily/last-failure")"
  fi
  abort "no new backup since the previous check on $previous_date (newest dump is still $newest); the server job has stopped producing artifacts.$failure_note"
fi

printf '%s %s\n' "$newest" "$today" >"$state" || abort "could not write $state"
say "freshness ok: newest dump is $newest"
