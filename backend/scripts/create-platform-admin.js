'use strict';

/**
 * Bootstraps the first platform admin — the account that logs into
 * `/platform` at all. `seeds/01_dev_tenants.js` seeds one for local
 * development, but that script refuses outright under
 * `NODE_ENV=production` (SECURITY.md §2's "no self-service platform
 * signup exists" — there was, until this file, no other way to create
 * one either). A real deployment therefore started with an empty
 * `platform_users` table and no way to sign in to the platform console.
 *
 * Run inside the backend container, once, right after the first
 * migration:
 *
 *   docker compose exec backend \
 *     npm run create-platform-admin -- --email=ops@example.com --password='a real passphrase'
 *
 * `--email`/`--password` (or the `PLATFORM_ADMIN_EMAIL`/
 * `PLATFORM_ADMIN_PASSWORD` env vars, for a non-interactive deploy
 * script that would rather not put a password on the command line) are
 * the only required inputs; `--first-name`/`--last-name` default to
 * "Platform"/"Admin" the same way the dev seed's own placeholder account
 * does.
 *
 * ── WHY `role: 'admin'`, ALWAYS ──────────────────────────────────────────
 *
 * `20260923090000_add_platform_user_role.js`'s own header is explicit: a
 * freshly-provisioned platform row defaults to `support` because "an
 * engineer manually provisioning a new platform account... must opt a
 * row INTO the more privileged tier explicitly, never receive it by
 * omission." That default is right for a SECOND account, added by an
 * already-logged-in admin. It is wrong for the FIRST one: no
 * `PATCH`/role-change endpoint exists anywhere in `src/modules/platform`
 * (confirmed by reading that module directly, not assumed) — a `support`
 * row has no path to ever become `admin`, so bootstrapping one here would
 * create an account that can read the tenant roster and nothing else,
 * permanently. This script exists specifically to hand the first login a
 * capable account, so it always inserts `role: 'admin'`.
 *
 * ── WHY MFA NEEDS NO EXTRA CODE HERE ──────────────────────────────────────
 *
 * `platform_users.mfa_enabled` defaults to `true` and `mfa_secret` starts
 * `NULL` (see that table's own migration comment). `platformLogin`
 * (`src/auth/service.js`) already treats a null `mfa_secret` as "this
 * account has never enrolled" and returns `mfa_enrollment_required` with a
 * fresh TOTP secret to scan — the exact real enrollment flow, not a
 * bypass. This script only has to leave `mfa_secret` unset for that to
 * fire on the very first login; it deliberately never pre-seeds a secret
 * nobody has actually scanned into an authenticator app, the same
 * reasoning the dev seed's own platform row already documents.
 *
 * ── WHY IT REFUSES ONCE ANYONE EXISTS ────────────────────────────────────
 *
 * `platform_users` has no signup surface and no invite mechanism — the
 * only two ways a row is ever created are this script and the dev seed.
 * Letting this script insert a second row would make it a silent,
 * undocumented way to add another platform admin later, bypassing
 * whatever real process (a second engineer running this same command,
 * reviewed the same way) should govern that. So it checks the table is
 * genuinely empty first and refuses otherwise — bootstrap-only, by
 * design, not by omission.
 */

const { scopedDb, destroy } = require('../src/db');
const { systemContext } = require('../src/modules/tenancy');
const { hashPassword, validatePassword } = require('../src/auth');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
    } else {
      const key = raw.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = String(args.email || process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(args.password || process.env.PLATFORM_ADMIN_PASSWORD || '');
  const firstName = String(args['first-name'] || process.env.PLATFORM_ADMIN_FIRST_NAME || 'Platform').trim();
  const lastName = String(args['last-name'] || process.env.PLATFORM_ADMIN_LAST_NAME || 'Admin').trim();

  if (!email || !password) {
    console.error(
      'Usage: npm run create-platform-admin -- --email=<email> --password=<password> ' +
        '[--first-name=<name>] [--last-name=<name>]\n' +
        '(or set PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD / PLATFORM_ADMIN_FIRST_NAME / PLATFORM_ADMIN_LAST_NAME)'
    );
    process.exitCode = 1;
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`"${email}" does not look like a valid email address.`);
    process.exitCode = 1;
    return;
  }

  const passwordIssue = await validatePassword(password);
  if (passwordIssue) {
    console.error(passwordIssue.message);
    process.exitCode = 1;
    return;
  }

  const db = scopedDb().for(systemContext()).platform();

  const existing = await db.table('platform_users').first('id');
  if (existing) {
    console.error(
      'Refusing to run: a platform_users row already exists (id ' +
        `${existing.id}). This script only bootstraps the FIRST platform ` +
        'admin — it is not a way to add a second one. Provision further ' +
        'accounts by inserting into platform_users directly, under the ' +
        'same review a change like that deserves.'
    );
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);

  const [id] = await db.table('platform_users').insert({
    email,
    password_hash: passwordHash,
    first_name: firstName,
    last_name: lastName,
    mfa_enabled: true,
    role: 'admin',
  });

  console.log(`Created platform admin #${id} (${email}).`);
  console.log('First login at /platform will require real TOTP enrollment — scan the QR/enter the manual key shown then.');
}

main()
  .catch((error) => {
    console.error('Failed to create platform admin:', error.message);
    process.exitCode = 1;
  })
  .finally(() => destroy());
