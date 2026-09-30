#!/usr/bin/env bash
# Restore drill: proves the WHOLE backup loop works, end to end, from B2.
#
# Usage, on the VPS:
#   sudo ops/backup/restore-drill.sh              # live comparison
#   sudo QUIESCE=1 ops/backup/restore-drill.sh    # exact comparison (see below)
#
# What it does:
#   1. Records a CHECKSUM TABLE of every production table (A).
#   2. Takes a fresh real backup to B2 (runs lodgekeep-backup.sh).
#   3. Restores the newest database snapshot FROM B2 (with an empty restic cache, so
#      everything is read from B2) into a THROWAWAY database
#      named lodgekeep_restore_drill, never touching production.
#   4. Checksums every restored table (R) and production again (B).
#   5. Restores the newest file snapshot into a temp dir and diffs it against
#      the live volumes and .env.production.
#   6. Drops the throwaway database and deletes the temp files.
#
# A table PASSES when R == A or R == B, i.e. the restore equals production
# either before or after the backup. A table that changed in the few seconds
# between A and B and was caught mid-change could fail even though the backup
# is fine: re-run, or run with QUIESCE=1, which stops the backend container for
# the ~1-2 minutes the drill takes so nothing can write (the site shows an
# error page meanwhile; the backend is started again automatically, even if
# the drill fails). Run it at a quiet hour.
#
# Exit status 0 only if every table and every file matched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"
load_config

DRILL_DB="lodgekeep_restore_drill"
TMP="$(mktemp -d /var/tmp/lodgekeep-drill.XXXXXX)"
chmod 700 "$TMP"
# A fresh, empty cache directory: restic must fetch all repository metadata and
# every data pack from Backblaze (it never reuses the nightly job's cache).
export RESTIC_CACHE_DIR="$TMP/cache"
BACKEND_STOPPED=0

cleanup() {
  local status=$?
  set +e
  echo "--- cleanup"
  echo "DROP DATABASE IF EXISTS \`$DRILL_DB\`;" | mysql_root "" >/dev/null 2>&1
  [ "$BACKEND_STOPPED" = 1 ] && { echo "Starting backend again"; compose start backend; }
  rm -rf "$TMP"
  [ "$status" -ne 0 ] && echo "DRILL ABORTED (exit $status)" >&2
  exit "$status"
}
trap cleanup EXIT

# shellcheck disable=SC2016
PROD_DB="$(compose exec -T mysql sh -c 'printf %s "$MYSQL_DATABASE"')"
[ -n "$PROD_DB" ] || { echo "Could not read the production database name" >&2; exit 2; }

if [ "$(echo "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$DRILL_DB'" | mysql_root "")" != "0" ]; then
  echo "Database $DRILL_DB already exists (a previous drill crashed?). Drop it first." >&2
  trap - EXIT; rm -rf "$TMP"; exit 2
fi

# "table<TAB>checksum" for every base table of database $1, sorted.
checksums() {
  local db="$1" tables stmt="" t
  tables="$(echo "SELECT table_name FROM information_schema.tables WHERE table_schema='$db' AND table_type='BASE TABLE' ORDER BY 1" | mysql_root "")"
  for t in $tables; do stmt+="CHECKSUM TABLE \`$db\`.\`$t\`;"; done
  echo "$stmt" | mysql_root "" | sed 's/^[^.]*\.//' | sort
}

if [ "${QUIESCE:-0}" = "1" ]; then
  echo "--- QUIESCE=1: stopping backend so nothing can write"
  compose stop backend
  BACKEND_STOPPED=1
fi

echo "--- 1/5 checksums of production ($PROD_DB) before the backup"
checksums "$PROD_DB" > "$TMP/A"
echo "$(wc -l < "$TMP/A") tables"

echo "--- 2/5 taking a fresh real backup to B2"
# Exits 75 (and aborts the drill) if the nightly job holds the lock, so the
# drill can never "pass" on a stale snapshot it did not just take.
"$SCRIPT_DIR/lodgekeep-backup.sh"

echo "--- 3/5 restoring the newest DB snapshot from B2 into throwaway database $DRILL_DB"
restic snapshots --host "$RESTIC_HOST" --tag db --latest 1
echo "CREATE DATABASE \`$DRILL_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" | mysql_root "" >/dev/null
restic dump --host "$RESTIC_HOST" --tag db latest "/$DUMP_NAME" | mysql_root "$DRILL_DB" >/dev/null

echo "--- 4/5 comparing every table"
checksums "$DRILL_DB" > "$TMP/R"
checksums "$PROD_DB"  > "$TMP/B"

fail=0
tables_total=0
while IFS=$'\t' read -r table sum_r; do
  tables_total=$((tables_total + 1))
  sum_a="$(awk -F'\t' -v t="$table" '$1==t{print $2}' "$TMP/A")"
  sum_b="$(awk -F'\t' -v t="$table" '$1==t{print $2}' "$TMP/B")"
  if [ "$sum_r" != "$sum_a" ] && [ "$sum_r" != "$sum_b" ]; then
    echo "  MISMATCH  $table  restored=$sum_r prod-before=$sum_a prod-after=$sum_b"
    fail=$((fail + 1))
  fi
done < "$TMP/R"
missing_in_restore="$(comm -23 <(cut -f1 "$TMP/B") <(cut -f1 "$TMP/R") | tr '\n' ' ')"
if [ -n "$missing_in_restore" ]; then
  echo "  MISSING from restore: $missing_in_restore"
  fail=$((fail + 1))
fi
churned="$(comm -13 <(sort "$TMP/A") <(sort "$TMP/B") | wc -l)"
echo "tables compared: $tables_total, mismatches: $fail (tables that changed in production during the drill: $churned)"
# Views, routines, triggers and events are not covered by CHECKSUM TABLE: compare counts.
objects() { echo "SELECT (SELECT COUNT(*) FROM information_schema.views WHERE table_schema='$1'), (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema='$1'), (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='$1'), (SELECT COUNT(*) FROM information_schema.events WHERE event_schema='$1')" | mysql_root ""; }
if [ "$(objects "$PROD_DB")" = "$(objects "$DRILL_DB")" ]; then
  echo "views/routines/triggers/events: $(objects "$DRILL_DB" | tr '\t' '/') match"
else
  echo "  MISMATCH  views/routines/triggers/events: prod=$(objects "$PROD_DB" | tr '\t' '/') restored=$(objects "$DRILL_DB" | tr '\t' '/')"
  fail=$((fail + 1))
fi
echo "migrations recorded: prod=$(echo "SELECT COUNT(*) FROM knex_migrations" | mysql_root "$PROD_DB") restored=$(echo "SELECT COUNT(*) FROM knex_migrations" | mysql_root "$DRILL_DB")"

echo "--- 5/5 restoring the newest file snapshot and diffing against the live volumes"
restic restore --host "$RESTIC_HOST" --tag files latest --target "$TMP/files" >/dev/null
files_bad=0
for v in "${BACKUP_VOLUMES[@]}"; do
  live="$(volume_path "$v")"
  # Content (diff) and ownership/mode (find listing) must both match.
  meta() { (cd "$1" && find . -printf '%p %U:%G %m\n' | sort); }
  if diff -rq "$TMP/files$live" "$live" >"$TMP/diff.$v" 2>&1 \
     && [ "$(meta "$TMP/files$live")" = "$(meta "$live")" ]; then
    echo "  OK        $v ($(find "$live" -type f | wc -l) files)"
  else
    echo "  DIFFERS   $v"; head -5 "$TMP/diff.$v" | sed 's/^/            /'
    files_bad=$((files_bad + 1))
  fi
done
if cmp -s "$TMP/files$LODGEKEEP_DEPLOY_PATH/.env.production" "$LODGEKEEP_DEPLOY_PATH/.env.production"; then
  echo "  OK        .env.production"
else
  echo "  DIFFERS   .env.production"; files_bad=$((files_bad + 1))
fi

echo
if [ "$fail" -eq 0 ] && [ "$files_bad" -eq 0 ]; then
  echo "RESULT: PASS - database and files restored from B2 match production."
else
  echo "RESULT: FAIL - $fail database problem(s), $files_bad file problem(s)."
  [ "${QUIESCE:-0}" = "1" ] || echo "If only busy tables mismatched, re-run with QUIESCE=1 for an exact comparison."
  exit 1
fi
