#!/usr/bin/env bash
# One-time (and safely re-runnable) setup of the nightly off-site backup.
#
# Usage, on the VPS, from the LodgeKeep checkout:
#   sudo ops/backup/install.sh
#
# First run:  installs restic, creates /etc/lodgekeep/backup.env (mode 600)
#             from the template and STOPS so you can fill it in.
# Second run: validates the file, creates the restic repository in B2 if it
#             does not exist yet, installs the systemd service + timer and
#             enables the timer. Re-running later just refreshes the units.

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG="${LODGEKEEP_BACKUP_ENV:-/etc/lodgekeep/backup.env}"

# The backup streams mysqldump into restic with --stdin-from-command, added in
# restic 0.17. Ubuntu 24.04's apt package is 0.16.4, which lacks it, so install
# a pinned upstream release and verify its SHA-256 (from the release's own
# SHA256SUMS file) before trusting it.
RESTIC_VERSION="0.19.1"
declare -A RESTIC_SHA256=(
  [amd64]="f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c"
  [arm64]="a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465"
)

apt-get update -qq
apt-get install -y -qq curl bzip2
if ! command -v restic >/dev/null || ! restic version | grep -q "restic $RESTIC_VERSION "; then
  arch="$(dpkg --print-architecture)"
  [ -n "${RESTIC_SHA256[$arch]:-}" ] || { echo "Unsupported architecture: $arch" >&2; exit 1; }
  tmp="$(mktemp -d)"
  echo "Installing restic $RESTIC_VERSION ($arch)..."
  curl -fsSL -o "$tmp/restic.bz2" "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${arch}.bz2"
  echo "${RESTIC_SHA256[$arch]}  $tmp/restic.bz2" | sha256sum -c - >/dev/null || { echo "restic download failed its checksum; aborting." >&2; exit 1; }
  bunzip2 "$tmp/restic.bz2"
  install -m 755 "$tmp/restic" /usr/local/bin/restic
  rm -rf "$tmp"
  hash -r
fi
echo "restic: $(restic version)"

if [ ! -e "$CONFIG" ]; then
  install -d -m 700 "$(dirname "$CONFIG")"
  install -m 600 "$SCRIPT_DIR/backup.env.example" "$CONFIG"
  sed -i "s|^LODGEKEEP_DEPLOY_PATH=.*|LODGEKEEP_DEPLOY_PATH=$DEPLOY_PATH|" "$CONFIG"
  cat <<EOF

Created $CONFIG (root-only). Edit it now and fill in:
  RESTIC_REPOSITORY, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, RESTIC_PASSWORD, HEALTHCHECK_URL
then run this script again:   sudo $0

For RESTIC_PASSWORD use a long random value, e.g.:  openssl rand -base64 32
EOF
  exit 0
fi

# shellcheck source=ops/backup/lib.sh
. "$SCRIPT_DIR/lib.sh"
load_config

[ -f "$LODGEKEEP_DEPLOY_PATH/.env.production" ] || { echo "No .env.production in $LODGEKEEP_DEPLOY_PATH" >&2; exit 2; }

if [ -z "${HEALTHCHECK_URL:-}" ]; then
  echo
  echo "WARNING: HEALTHCHECK_URL is empty. Without it nobody is told when a backup"
  echo "fails or the timer never runs; a broken backup can go unnoticed for months."
  echo "Create a check at healthchecks.io (period 1 day, grace 2 hours) and set it."
  echo
fi

echo "Checking the repository..."
if out="$(restic cat config 2>&1)"; then
  echo "Repository already initialised."
elif grep -q "Is there a repository at the following location" <<<"$out"; then
  echo "Initialising a new encrypted repository at $RESTIC_REPOSITORY"
  restic init
else
  # Bad key, wrong password, network down: do NOT guess that the repo is missing.
  echo "Cannot open the repository:" >&2
  echo "$out" >&2
  exit 1
fi

sed "s|@DEPLOY_PATH@|$DEPLOY_PATH|g" "$SCRIPT_DIR/lodgekeep-backup.service" > /etc/systemd/system/lodgekeep-backup.service
install -m 644 "$SCRIPT_DIR/lodgekeep-backup.timer" /etc/systemd/system/lodgekeep-backup.timer
chmod 755 "$SCRIPT_DIR/lodgekeep-backup.sh" "$SCRIPT_DIR/restore-drill.sh"
systemctl daemon-reload
systemctl enable --now lodgekeep-backup.timer

echo
systemctl list-timers lodgekeep-backup.timer --no-pager
cat <<EOF

Installed. The backup runs nightly at 03:30 (server time).

=========================== SAVE THESE SEPARATELY ===========================
Store these in your password manager (NOT only on this server). If the VPS is
lost, this list is what lets you recover everything:

  1. RESTIC_PASSWORD           <- without it the backups CANNOT be opened, ever
  2. RESTIC_REPOSITORY         <- $RESTIC_REPOSITORY
  3. B2_ACCOUNT_ID + B2_ACCOUNT_KEY (or make a new B2 key later)
  4. A copy of .env.production (it is ALSO inside every 'files' snapshot, but
     you need restic working first to get it out)
Full copy of $CONFIG is the simplest thing to save.
=============================================================================

Next: take the first backup and prove the restore:
  sudo systemctl start lodgekeep-backup.service ; journalctl -u lodgekeep-backup -n 50 --no-pager
  sudo ops/backup/restore-drill.sh
EOF
