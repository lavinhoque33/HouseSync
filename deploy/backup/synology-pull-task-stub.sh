#!/bin/sh
# --------------------------------------------------------------------------------------------------
# HouseSync NAS pull task - DSM Task Scheduler stub (reference only)
#
# DSM caps the "Run command" field at 8192 characters and the real task script is larger than that, so
# the script lives in the approved example shared folder and this stub executes it:
#
#   1. File Station > housesync-example > Upload > synology-pull-task.sh
#      (canonical deploy/backup/synology-pull-task.sh with VPS_HOST and both verified host keys filled in)
#   2. Control Panel > Task Scheduler > housesync-backup-pull > Edit > Task Settings > Run command:
#      the text of this file, verbatim.
#
# Updating the task means replacing the uploaded script - never re-editing this field. The stub's own
# failures (missing file, syntax error, unreadable folder) exit non-zero, so they reach the operator
# through the same DSM email as a failed pull. Details: deploy/backup/README.md, "Synology pull".
# --------------------------------------------------------------------------------------------------
set -eu

script=/volume1/housesync-example/synology-pull-task.sh

if [ ! -f "$script" ]; then
  echo "ABORT: $script is missing; upload deploy/backup/synology-pull-task.sh there first"
  exit 1
fi

if ! /bin/sh -n "$script" 2>/dev/null; then
  echo "ABORT: $script failed a syntax check; re-upload it from the repository"
  exit 1
fi

exec /bin/sh "$script"
