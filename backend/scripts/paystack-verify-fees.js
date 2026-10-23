'use strict';

/**
 * Read-only sandbox check: prints amount, fees and the subaccount share Paystack reports for ONE transaction, so a
 * payment made before the PAYSTACK_FEE_BEARER change can be compared with one made after it.
 *
 *   docker compose exec -T -e REF=<reference> backend node scripts/paystack-verify-fees.js
 *
 * Reads the active NGN integration key from the database and refuses anything but a TEST key (sk_test_). Makes one
 * GET to /transaction/verify. Writes nothing. Never prints a key (nor any error text that could carry one). Amounts
 * are shown in naira (Paystack sends kobo). Same database access as scripts/set-platform-paystack-key.js.
 */

const { decrypt } = require('../src/shared/encryption');

const TABLE = 'platform_payment_integrations';

/**
 * @param {{ db: import('knex').Knex, env: Record<string,string|undefined>, out: (line: string) => void, fetchFn?: typeof fetch }} io
 * @returns {Promise<number>} process exit code
 */
async function run({ db, env, out, fetchFn = fetch }) {
  const reference = env.REF;
  if (!reference) {
    out('Set REF to the transaction reference (payments.provider_reference).');
    return 2;
  }

  const row = await db(TABLE).where({ currency: 'NGN', is_active: true }).first();
  if (!row) {
    out('No active NGN Paystack integration row.');
    return 1;
  }
  let key;
  try {
    key = decrypt(row.secret_key_encrypted);
  } catch {
    out('Stored key could not be decrypted with this ENCRYPTION_KEY.');
    return 1;
  }
  if (!key.startsWith('sk_test_')) {
    out('Refusing: the NGN key is not a TEST key.');
    return 1;
  }

  const response = await fetchFn(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = await response.json();
  if (!json.status) {
    out(`Paystack: ${json.message}`);
    return 1;
  }
  const d = json.data;
  const naira = (kobo) => (kobo == null ? null : (Number(kobo) / 100).toFixed(2));
  out(
    JSON.stringify(
      {
        reference: d.reference,
        status: d.status,
        channel: d.channel,
        amount: naira(d.amount),
        requested_amount: naira(d.requested_amount),
        fees: naira(d.fees),
        fees_split: d.fees_split ?? null,
        subaccount_code: d.subaccount?.subaccount_code ?? null,
        subaccount_percentage_charge: d.subaccount?.percentage_charge ?? null,
        split: d.split ?? null,
      },
      null,
      2
    )
  );
  return 0;
}

module.exports = { run };

if (require.main === module) {
  require('dotenv').config();
  const { knex, destroy } = require('../src/db');
  run({ db: knex(), env: process.env, out: (line) => console.log(line) })
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      // Never print the error object: stay conservative about anything that could carry a key.
      console.error(`Failed: ${error.code ?? error.message}`);
      process.exitCode = 1;
    })
    .finally(() => destroy());
}
