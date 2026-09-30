# Backups and restore

LodgeKeep production is backed up every night at 03:30 (server time) to a
Backblaze B2 bucket through [restic](https://restic.net). Everything is
encrypted on the VPS before it leaves; Backblaze only ever holds ciphertext.
This file is the procedure to get the data back. The backup code is in
`ops/backup/`.

## What is backed up

| Snapshot tag | Contents | How |
|---|---|---|
| `db` | The whole production MySQL database (`mysqldump`, all tables, routines, triggers) | Streamed straight into restic. The dump never exists as a file on the VPS. |
| `files` | The volumes `export_storage`, `import_storage`, `menu_image_storage`, `property_logo_storage`, plus `.env.production` | Read in place by restic. |

Retention: 7 daily, 4 weekly, 6 monthly snapshots of each tag; the rest is
pruned automatically. A failed dump creates no snapshot. Every Sunday the job
also verifies the repository structure and a 5% sample of the stored data.

**Not backed up:** Redis (queues, rate-limit counters, rebuilt on start), the
Caddy volumes (TLS certificates are re-issued automatically; see the rate-limit
note below), and the code (that is in git).

## What you must save OUTSIDE the server

If the VPS dies, these are the only things standing between you and total loss.
Keep them in your password manager, not only on the server:

1. **`RESTIC_PASSWORD`**. Without it the backups cannot be opened by anyone, ever.
2. **`RESTIC_REPOSITORY`** (`b2:<bucket>:<folder>`).
3. **`B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY`** (or be ready to create a new key in the B2 console).
4. The healthchecks.io URL (optional, only for alerting).

The simplest safe move is to store a copy of the whole `/etc/lodgekeep/backup.env`.
`.env.production` (which holds `ENCRYPTION_KEY`) is also inside every `files`
snapshot, but you need items 1-3 to reach it.

## One-time setup (already done if the timer is running)

```bash
# 1. In Backblaze: create a PRIVATE bucket and an application key restricted to it
#    (capabilities: listBuckets, listFiles, readFiles, writeFiles, deleteFiles).
#    Bucket settings -> Lifecycle Settings: choose "Keep only the last version of the file".
#    (restic prunes by deleting; with B2's default "keep all versions" the deleted data
#    stays as hidden versions and keeps being billed.)
# 2. In healthchecks.io: create a check, period 1 day, grace 2 hours. Do not skip this:
#    it is the only thing that tells you a backup failed or never ran.
# 3. On the VPS, from the LodgeKeep checkout:
sudo ops/backup/install.sh      # first run creates /etc/lodgekeep/backup.env and stops
sudoedit /etc/lodgekeep/backup.env
sudo ops/backup/install.sh      # second run creates the repository and enables the timer
```

Generate the passphrase with `openssl rand -base64 32`.

## Day-to-day

```bash
systemctl list-timers lodgekeep-backup.timer          # next run
journalctl -u lodgekeep-backup -n 80 --no-pager       # last run's log
sudo systemctl start lodgekeep-backup.service         # run one now
sudo -i                                               # then, as root:
set -a; . /etc/lodgekeep/backup.env; set +a
restic snapshots                                      # what exists in B2
```

## Restore drill (run this after setup, and every few months)

```bash
sudo ops/backup/restore-drill.sh            # compare against live production
sudo QUIESCE=1 ops/backup/restore-drill.sh  # stops the backend ~2 min for an exact comparison
```

It takes a fresh backup, restores it **from B2** (with an empty restic cache, so everything is read from Backblaze) into a
throwaway database `lodgekeep_restore_drill`, compares `CHECKSUM TABLE` of every
table and a file-by-file diff of the volumes, then drops the throwaway database.
Production is never written to. It prints `RESULT: PASS` or lists what differs.

## Restore procedures

All commands below run on the VPS as root, from the LodgeKeep checkout, after
loading the credentials:

```bash
sudo -i
cd /path/to/LodgeKeep                      # the checkout (LODGEKEEP_DEPLOY_PATH)
set -a; . /etc/lodgekeep/backup.env; set +a
export C="docker compose --env-file .env.production -f docker-compose.prod.yml"
restic snapshots --host lodgekeep-prod     # pick a snapshot id, or use "latest"
```

### A. Restore the database into a fresh, separate database (inspect, or recover some data)

This does not touch production:

```bash
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot -e "CREATE DATABASE lodgekeep_restored CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"'
restic dump --host lodgekeep-prod --tag db latest /lodgekeep_prod.sql \
  | $C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot lodgekeep_restored'
# Look around:
$C exec mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot lodgekeep_restored'
# When finished:
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot -e "DROP DATABASE lodgekeep_restored"'
```

To restore an older point in time, replace `latest` with a snapshot id.

### B. Replace the production database with a backup (production data is damaged)

This **replaces current data**. Decide on the snapshot first (A lets you inspect
it). It first saves the current database into restic (tag `pre-restore`) so the
step can be undone, then drops and recreates the database so no newer table is
left behind (a leftover table would make `migrate` fail), then loads the backup.

```bash
set -o pipefail                                     # a dropped B2 connection must stop the pipe
$C stop backend                                     # no writers while restoring

# 1. Safety copy of what is there now (recoverable later with --tag pre-restore):
restic backup --host lodgekeep-prod --tag pre-restore --stdin-from-command --stdin-filename lodgekeep_prod.sql -- \
  $C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump -uroot --single-transaction --routines --triggers --events --no-tablespaces --default-character-set=utf8mb4 "$MYSQL_DATABASE"'

# 2. Empty database (the application user's grants survive a drop/create):
$C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot -e "DROP DATABASE \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"'

# 3. Load the chosen snapshot (an id, or "latest"):
restic dump --host lodgekeep-prod --tag db <SNAPSHOT_ID> /lodgekeep_prod.sql \
  | $C exec -T mysql sh -c 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysql -uroot "$MYSQL_DATABASE"'

# 4. Start the stack; "migrate" brings an older backup up to the deployed code:
$C up -d
```

If step 3 prints any error, do not start the backend: fix the cause and repeat
steps 2-3 (they are safe to repeat). To undo the whole thing, repeat steps 2-3
using the `pre-restore` snapshot (`--tag pre-restore`).

If `migrate` fails with *"migration directory is corrupt, the following files
are missing"*, the backup contains a migration from a branch that is not in the
deployed code; delete that one row from `knex_migrations` and run `$C up -d` again.

### C. Restore the uploaded files

```bash
restic restore --host lodgekeep-prod --tag files latest --target /var/tmp/restore-files
ls /var/tmp/restore-files/var/lib/docker/volumes/     # one folder per volume
$C stop backend                                        # nothing may write while files are replaced
# Copy one volume back, preserving ownership (the app runs as uid 1000):
cp -a /var/tmp/restore-files/var/lib/docker/volumes/lodgekeep-prod_menu_image_storage/_data/. \
      "$(docker volume inspect -f '{{.Mountpoint}}' lodgekeep-prod_menu_image_storage)"/
rm -rf /var/tmp/restore-files
```

Repeat for `property_logo_storage` (and the other two if needed), then `$C start backend`.
`.env.production` is in the same snapshot under the checkout's original path
(`/var/tmp/restore-files<checkout path>/.env.production`).

### D. Total loss: rebuild on a new VPS

1. Provision Ubuntu, install Docker, clone the repo, `cd` into it.
2. Install restic and recreate the credentials file:
   `sudo ops/backup/install.sh` (first run installs restic and writes a template),
   then fill in `/etc/lodgekeep/backup.env` from your password manager. Do **not**
   run the second pass yet.
3. Get `.env.production` back: run `restic restore --host lodgekeep-prod --tag files latest --include '*/.env.production' --target /var/tmp/restore-files`,
   copy it to the checkout root (`cp "$(find /var/tmp/restore-files -name .env.production)" .env.production`), `chmod 600 .env.production`. (`ENCRYPTION_KEY`
   in it must be the original; a different key makes stored SMTP passwords
   unreadable.)
4. Start only the data services: `$C up -d mysql redis` and wait until healthy.
5. Load the database as in **B** (skip `stop backend`; it is not running yet).
6. Restore the volumes as in **C**. Create them first with `$C create`.
7. `$C up -d --build` to start everything. Check `https://<host>/healthz` through
   the app and sign in.
8. Point DNS at the new server. Caddy re-issues TLS certificates on demand; if
   you have many tenant domains, stage the Let's Encrypt CA first to avoid the
   50-per-week limit (see the Caddyfile comment).
9. `sudo ops/backup/install.sh` again to re-enable the nightly timer, then run
   the drill.

Keep `TENANT_PURGE_ENABLED=false` until a drill has passed; the retention purge is
not reversible except from these backups.
