'use strict';

/**
 * Read-only sandbox check: prints amount, fees and the subaccount share Paystack reports for ONE transaction, so a
 * payment made before the PAYSTACK_FEE_BEARER change can be compared with one made after it.
 *
 *   docker compose exec -T -e REF=<reference> backend node scripts/paystack-verify-fees.js
 *
 * Reads the active NGN integration key from the database and refuses anything but a TEST key (sk_test_). Makes one
 * GET to /transaction/verify. Writes nothing. Never prints a key. Amounts are shown in naira (Paystack sends kobo).
 */

require('dotenv').config();
const { scopedDb, destroy } = require('../src/db');
const { systemContext } = require('../src/modules/tenancy');
const { decrypt } = require('../src/shared/encryption');

async function main() {
  const reference = process.env.REF;
  if (!reference) throw new Error('Set REF to the transaction reference (payments.provider_reference).');

  const db = scopedDb.for(systemContext());
  try {
    const row = await db.table('platform_payment_integrations').where({ currency: 'NGN', is_active: true }).first();
    if (!row) throw new Error('No active NGN Paystack integration row.');
    const key = decrypt(row.secret_key_encrypted);
    if (!key.startsWith('sk_test_')) throw new Error('Refusing: the NGN key is not a TEST key.');

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const json = await response.json();
    if (!json.status) throw new Error(`Paystack: ${json.message}`);
    const d = json.data;
    const naira = (kobo) => (kobo == null ? null : (Number(kobo) / 100).toFixed(2));
    console.log(
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
  } finally {
    await destroy();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
