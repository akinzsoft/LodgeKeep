#!/usr/bin/env bash
# Nightly encrypted off-site backup of the LodgeKeep production stack.
#
# Runs as root on the VPS, from the systemd timer (lodgekeep-backup.timer).
# Usage:  sudo ops/backup/lodgekeep-backup.sh        (also safe to run by hand)
#
# What it does, in order:
#   1. Database: mysqldump of the production database, STREAMED into restic
#      (--stdin-from-command). The dump never exists as a file on this disk.
#      If mysqldump fails, restic creates NO snapshot, so a half-written dump
#      can never be mistaken for a good backup.
#   2. Files: the four upload/export volumes (exports, imports, menu-images,
#      property-logos) and .env.production (holds ENCRYPTION_KEY, without which
#      stored SMTP passwords are unreadable after a restore).
#   3. Retention: keep 7 daily, 4 weekly, 6 monthly snapshots; prune the rest.
#   4. On Sundays, verify the repository's structure plus a 5% sample of data.
#
# Everything is encrypted on this machine by restic before it leaves; Backblaze
# only ever sees ciphertext. Config and secrets: /etc/lodgekeep/backup.env.
#
# Failure handling: any error stops the run and pings the healthchecks.io
# /fail URL. A run that never starts is caught because the success ping is
# missing by its deadline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"
load_config

# One backup at a time (a slow run must not overlap the next one or the drill).
exec 9>/run/lodgekeep-backup.lock
# 75 (EX_TEMPFAIL), not 0: the restore drill relies on a non-zero exit to know
# it did NOT get a fresh backup.
flock -n 9 || { echo "Another backup is already running; exiting." >&2; exit 75; }

ping_hc() { # $1 = "", "/start" or "/fail"; $2 = optional body
  [ -n "${HEALTHCHECK_URL:-}" ] || return 0
  # The URL is the credential for the check (anyone holding it can fake a
  # success ping), so pass it on stdin, not in argv where `ps` shows it.
  printf 'url = "%s%s"\n' "$HEALTHCHECK_URL" "$1" | \
    curl -fsS -m 15 --retry 3 -o /dev/null --data-raw "${2:-}" --config - || \
    echo "warning: could not reach healthchecks.io ($1)" >&2
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "BACKUP FAILED (exit $status)" >&2
    ping_hc /fail "lodgekeep backup failed on $(hostname) (exit $status)"
  fi
}
trap on_exit EXIT

log() { echo "[$(date -u +%FT%TZ)] $*"; }

WARNINGS=0
# restic exits 3 when the snapshot WAS written but some files could not be read
# (typical for the live export/import volumes: a file vanishes mid-scan). That
# must not skip retention or turn every night red, so it is a warning; any
# other non-zero status is a real failure.
run_restic_backup() {
  local rc=0
  restic backup "$@" || rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "warning: restic could not read some files (snapshot still saved)" >&2
    WARNINGS=1
  elif [ "$rc" -ne 0 ]; then
    return "$rc"
  fi
}

ping_hc /start
log "Starting backup to $RESTIC_REPOSITORY"

# --- 1. Database, straight into restic -------------------------------------
# The command runs as MySQL root inside the container, so --no-tablespaces is
# not strictly needed there; it is kept so the same line also works as the app
# user (which has no PROCESS privilege). --single-transaction gives a
# consistent snapshot without locking writers.
log "Database dump -> restic"
cd "$LODGEKEEP_DEPLOY_PATH"
# shellcheck disable=SC2016  # the password/db variables expand inside the container, on purpose
run_restic_backup \
  --host "$RESTIC_HOST" --tag db \
  --stdin-from-command --stdin-filename "$DUMP_NAME" \
  -- docker compose --env-file .env.production -f docker-compose.prod.yml \
     exec -T mysql sh -c \
     'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump -uroot --single-transaction --routines --triggers --events --no-tablespaces --default-character-set=utf8mb4 "$MYSQL_DATABASE"'

# --- 2. Files ---------------------------------------------------------------
paths=()
for v in "${BACKUP_VOLUMES[@]}"; do
  paths+=("$(volume_path "$v")")
done
paths+=("$LODGEKEEP_DEPLOY_PATH/.env.production")

log "Files -> restic: ${paths[*]}"
run_restic_backup --host "$RESTIC_HOST" --tag files "${paths[@]}"

# --- 2b. Sanity-check the new dump BEFORE old snapshots can be pruned ------
# mysqldump's exit status only proves it ran. If MYSQL_DATABASE ever pointed at
# an empty or wrong database, every night would store a tiny "successful" dump
# and, after a week, retention would have deleted every real one. So: the new
# snapshot must end with mysqldump's completion trailer and be at least
# MIN_DUMP_BYTES (default 20 KB; a real LodgeKeep schema alone is far larger).
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-20000}"
dump_bytes="$(restic dump --host "$RESTIC_HOST" --tag db latest "/$DUMP_NAME" | wc -c)"
if ! restic dump --host "$RESTIC_HOST" --tag db latest "/$DUMP_NAME" | tail -c 400 | grep -q -- '-- Dump completed'; then
  echo "New database snapshot has no 'Dump completed' trailer; NOT pruning." >&2
  exit 1
fi
if [ "$dump_bytes" -lt "$MIN_DUMP_BYTES" ]; then
  echo "New database snapshot is only $dump_bytes bytes (< $MIN_DUMP_BYTES); NOT pruning." >&2
  exit 1
fi
log "Dump check OK ($dump_bytes bytes, trailer present)"

# --- 3. Retention -----------------------------------------------------------
# Grouped by tag so the database and file snapshots are each kept 7/4/6 and
# one series can never crowd out the other.
log "Applying retention and pruning"
restic forget --host "$RESTIC_HOST" --group-by host,tags \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# --- 4. Weekly integrity check ---------------------------------------------
if [ "$(date +%u)" = "7" ]; then
  log "Weekly repository check (structure + 5% of data)"
  restic check --read-data-subset=5%
fi

if [ "$WARNINGS" -eq 1 ]; then
  log "Backup finished with warnings (some files unreadable)"
  ping_hc "" "lodgekeep backup ok WITH WARNINGS on $(hostname)"
else
  log "Backup finished OK"
  ping_hc "" "lodgekeep backup ok on $(hostname)"
fi
