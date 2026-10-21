'use strict';

/**
 * Replaces the Paystack secret key that guest / POS / QR / supermarket card
 * payments use: the ONE `platform_payment_integrations` row for NGN/paystack,
 * stored AES-256-GCM encrypted (`src/shared/encryption.js`). There is no admin
 * screen for it. `PAYSTACK_SECRET_KEY` in the env only seeded the row once, at
 * migration time, and is never read at runtime. The key is read from the
 * database on every call, so no restart is needed after this runs.
 * (Subscription billing uses `BILLING_PAYSTACK_SECRET_KEY` from the env, a
 * separate setting this script does not touch.)
 *
 * Run inside the backend (or migrate) container, which already carries the
 * production `ENCRYPTION_KEY` and DB settings (`scripts/` is copied into the
 * image). The new key is passed ONLY through an environment variable, never
 * argv (argv is visible in `ps` and shell history), and is never printed:
 *
 *   read -rs NEW_PAYSTACK_SECRET_KEY && export NEW_PAYSTACK_SECRET_KEY
 *   docker compose --env-file .env.production -f docker-compose.prod.yml \
 *     exec -T -e NEW_PAYSTACK_SECRET_KEY backend \
 *     node scripts/set-platform-paystack-key.js --dry-run
 *   ... same command without --dry-run to write ...
 *   ... same command with --check (needs no new key) to see what is stored ...
 *   unset NEW_PAYSTACK_SECRET_KEY
 *
 * Flags: --dry-run (everything except the write), --check (decrypt the stored
 * key and print only whether it is a live or a test key), --allow-test (accept
 * an sk_test_ key, for rolling back). Anything not starting `sk_live_` is
 * refused without --allow-test.
 *
 * Output is limited to counts and true/false flags. Error text never includes
 * any part of the key.
 */

const { encrypt, decrypt } = require('../src/shared/encryption');

const KEY_ENV = 'NEW_PAYSTACK_SECRET_KEY';
const TABLE = 'platform_payment_integrations';
const ROW = { provider: 'paystack', currency: 'NGN' };

function keyKind(key) {
  return { live: /^sk_live_/.test(key), test: /^sk_test_/.test(key) };
}

/**
 * @param {{ db: import('knex').Knex, env: Record<string,string|undefined>, argv: string[], out: (line: string) => void }} io
 * @returns {Promise<number>} process exit code
 */
async function run({ db, env, argv, out }) {
  const flags = new Set(argv);
  const unknown = argv.filter((a) => !['--dry-run', '--check', '--allow-test'].includes(a));
  if (unknown.length) {
    out(`Unknown option(s): ${unknown.map((a) => a.split('=')[0]).join(' ')}. The key must be passed via the ${KEY_ENV} env var, never as an argument.`);
    return 2;
  }

  if (flags.has('--check')) {
    const rows = await db(TABLE).where(ROW);
    if (rows.length !== 1) {
      out(`Expected exactly 1 NGN paystack row, found ${rows.length}.`);
      return 1;
    }
    let stored;
    try {
      stored = decrypt(rows[0].secret_key_encrypted);
    } catch {
      out('Stored key could not be decrypted with this ENCRYPTION_KEY.');
      return 1;
    }
    const kind = keyKind(stored);
    out(`active: ${Boolean(rows[0].is_active)}`);
    out(`live key: ${kind.live}`);
    out(`test key: ${kind.test}`);
    return 0;
  }

  const newKey = env[KEY_ENV];
  if (!newKey) {
    out(`Set ${KEY_ENV} in the environment (not as an argument). Nothing was changed.`);
    return 2;
  }
  const kind = keyKind(newKey);
  if (!kind.live && !(flags.has('--allow-test') && kind.test)) {
    out('Refused: the new key is not a live key (sk_live_...). Pass --allow-test to store a test key. Nothing was changed.');
    return 2;
  }

  const encrypted = encrypt(newKey);
  if (decrypt(encrypted) !== newKey) {
    out('Refused: encrypt/decrypt round trip failed. Nothing was changed.');
    return 1;
  }

  if (flags.has('--dry-run')) {
    const [{ n }] = await db(TABLE).where(ROW).count({ n: '*' });
    out(`dry run: would update ${Number(n)} row(s). Nothing was changed.`);
    return Number(n) === 1 ? 0 : 1;
  }

  const updated = await db.transaction(async (trx) => {
    const n = await trx(TABLE).where(ROW).update({ secret_key_encrypted: encrypted });
    if (n !== 1) throw new Error(`rows updated: ${n}`);
    return n;
  }).catch((error) => {
    out(`${error.message}. Rolled back; nothing was changed.`);
    return null;
  });
  if (updated === null) return 1;
  out(`rows updated: ${updated}`);
  return 0;
}

module.exports = { run, KEY_ENV };

if (require.main === module) {
  const { knex, destroy } = require('../src/db');
  run({ db: knex(), env: process.env, argv: process.argv.slice(2), out: (line) => console.log(line) })
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      // Never print the error object: nothing here carries the key, but stay conservative.
      console.error(`Failed: ${error.code ?? error.message}`);
      process.exitCode = 1;
    })
    .finally(() => destroy());
}
