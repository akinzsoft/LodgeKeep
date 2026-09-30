#!/usr/bin/env bash
# Shared helpers for the LodgeKeep off-site backup scripts (sourced, not run).
#
# Everything is read from ONE root-only file on the VPS (default
# /etc/lodgekeep/backup.env, override with LODGEKEEP_BACKUP_ENV). That file is
# never in the repo. It holds the B2 key, the restic passphrase and the
# healthchecks.io URL; see ops/backup/backup.env.example for the shape.

# shellcheck disable=SC2034  # variables below are consumed by the scripts that source this file
load_config() {
  CONFIG="${LODGEKEEP_BACKUP_ENV:-/etc/lodgekeep/backup.env}"
  [ -r "$CONFIG" ] || { echo "Missing or unreadable config: $CONFIG (run ops/backup/install.sh)" >&2; exit 2; }

  # The file holds secrets: refuse to use one that other users can read.
  local mode
  mode="$(stat -c '%a' "$CONFIG")"
  if [ "${mode: -2}" != "00" ]; then
    echo "Refusing to use $CONFIG: mode is $mode, must be 600 (chmod 600 $CONFIG)" >&2
    exit 2
  fi

  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a

  local v
  for v in RESTIC_REPOSITORY RESTIC_PASSWORD B2_ACCOUNT_ID B2_ACCOUNT_KEY LODGEKEEP_DEPLOY_PATH; do
    [ -n "${!v:-}" ] || { echo "$v is not set in $CONFIG" >&2; exit 2; }
  done

  # --stdin-from-command (used by the backup) needs restic >= 0.17.
  local ver
  ver="$(restic version | awk '{print $2}')"
  if [ "$(printf '%s\n0.17.0\n' "$ver" | sort -V | head -1)" != "0.17.0" ]; then
    echo "restic $ver is too old; need >= 0.17 (re-run ops/backup/install.sh)" >&2
    exit 2
  fi

  COMPOSE_PROJECT="${COMPOSE_PROJECT:-lodgekeep-prod}"
  # One fixed host name, so snapshots group together even if the VPS is renamed.
  RESTIC_HOST="${RESTIC_HOST:-lodgekeep-prod}"
  # Stdin dump is stored under this name inside the snapshot.
  DUMP_NAME="lodgekeep_prod.sql"

  # Named volumes whose contents are irreplaceable or cheap enough to keep.
  # Compose prefixes them with the project name.
  BACKUP_VOLUMES=(export_storage import_storage menu_image_storage property_logo_storage)
}

# docker compose against the production stack, from the deploy checkout.
compose() {
  (cd "$LODGEKEEP_DEPLOY_PATH" && docker compose --env-file .env.production -f docker-compose.prod.yml "$@")
}

# Host path of a named volume (e.g. /var/lib/docker/volumes/.../_data).
volume_path() {
  docker volume inspect -f '{{.Mountpoint}}' "${COMPOSE_PROJECT}_$1"
}

# mysql client as root INSIDE the mysql container, so no password crosses the
# host shell or shows up in `ps`. $1 = database (may be empty).
mysql_root() {
  # shellcheck disable=SC2016  # $MYSQL_ROOT_PASSWORD must expand INSIDE the container
  compose exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot --batch --skip-column-names '"$1"
}
