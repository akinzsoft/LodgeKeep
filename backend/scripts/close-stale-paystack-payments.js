'use strict';

/**
 * Closes Paystack payments that were started before a test-to-live key swap and never finished. After the swap,
 * Paystack live answers "transaction not found" for every one of them (they were created with the test key), and
 * nothing in the app expires them, so a stale PENDING Register payment would keep failing `verifyPayment`.
 *
 * Matches payments with provider = 'paystack', parent_payment_id IS NULL (never a refund), status INITIATED or
 * PENDING, and created_at BEFORE the required --before timestamp (so nothing created after the swap is touched).
 * Each is moved to CANCELLED with failure_reason "Closed before live cutover (test-mode)", with one `audit_log` row
 * (action gateway_payment_closed, before/after status) in the same transaction, one transaction per payment. The
 * update is conditional on the payment still being INITIATED/PENDING, so a payment captured meanwhile is never
 * overwritten. No other table changes (an unpaid payment has no folio line, balance or settlement).
 *
 * Special cases:
 *  - A supermarket online sale whose intent is still inside its time window is EXCLUDED. One whose intent has run out
 *    is cancelled through the existing `cancelLocally` path (payment and intent together), not directly.
 *  - A payment that funds a tentative portal booking releases that hold through `abandonUnpaidBooking`.
 *  - The Register / QR tabs that now have a closed payment are listed so a person can void or settle them.
 *
 * Dry run by default; --apply writes. --before=<ISO timestamp> is REQUIRED and may not be in the future. Run in the
 * backend container (it carries the DB settings), like the other scripts:
 *
 *   docker compose --env-file .env.production -f docker-compose.prod.yml exec -T backend \
 *     node scripts/close-stale-paystack-payments.js --before=2026-10-22T09:00:00Z
 *   ... same command with --apply to write ...
 *
 * Output is limited to payment ids and counts. No secret is read or printed.
 */

const REASON = 'Closed before live cutover (test-mode)';
const OPEN_STATUSES = ['INITIATED', 'PENDING'];

function age(createdAt, now) {
  const hours = Math.floor((now.getTime() - new Date(createdAt).getTime()) / 3600000);
  return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}

function parseArgs(argv) {
  const flags = { apply: false, before: null, errors: [] };
  for (const arg of argv) {
    if (arg === '--apply') flags.apply = true;
    else if (arg.startsWith('--before=')) flags.before = arg.slice('--before='.length);
    else flags.errors.push(arg.split('=')[0]);
  }
  return flags;
}

/**
 * @param {{ db: import('knex').Knex, argv: string[], out: (line: string) => void, now?: Date,
 *           hooks?: { beforeClose?: (payment: object) => Promise<void>, afterUpdate?: (payment: object) => Promise<void> } }} io  `hooks` exists for tests (to race a capture).
 * @returns {Promise<number>} process exit code
 */
async function run({ db, argv, out, now = new Date(), hooks = {} }) {
  const flags = parseArgs(argv);
  if (flags.errors.length) {
    out(`Unknown option(s): ${flags.errors.join(' ')}. Usage: --before=<ISO timestamp> [--apply]`);
    return 2;
  }
  if (!flags.before) {
    out('Refused: --before=<ISO timestamp> is required, so nothing created after the key swap is touched. Nothing was changed.');
    return 2;
  }
  const before = new Date(flags.before);
  if (Number.isNaN(before.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(flags.before)) {
    out('Refused: --before is not a valid ISO timestamp. Nothing was changed.');
    return 2;
  }
  if (before.getTime() > now.getTime()) {
    out('Refused: --before is in the future, which would match payments still in progress. Nothing was changed.');
    return 2;
  }

  const candidates = await db('payments')
    .where({ provider: 'paystack' })
    .whereNull('parent_payment_id')
    .whereIn('status', OPEN_STATUSES)
    .where('created_at', '<', before)
    .orderBy('id');

  // Loaded lazily: the service modules are only needed once there is something to close.
  const { scopedDb } = require('../src/db');
  const { workerContext } = require('../src/modules/tenancy');
  const { recordAuditEntry } = require('../src/audit');

  const plan = [];
  for (const payment of candidates) {
    let action = 'close';
    let note = '';
    let intent = null;
    let reservation = null;
    if (payment.settlement_target === 'supermarket_sale') {
      intent = await db('supermarket_sale_intents').where({ payment_id: payment.id }).first();
      if (intent && intent.status === 'pending') {
        if (new Date(intent.expires_at).getTime() > now.getTime()) {
          action = 'exclude';
          note = 'sale intent still inside its time window';
        } else {
          action = 'cancel-intent';
          note = `sale intent #${intent.id}`;
        }
      }
    } else if (payment.settlement_target === 'folio') {
      const folio = await db('folios').where({ id: payment.folio_id }).first();
      reservation = folio ? await db('reservations').where({ id: folio.reservation_id }).first() : null;
      if (reservation && reservation.status === 'tentative') {
        const captured = await db('payments').where({ folio_id: payment.folio_id, status: 'CAPTURED' }).first('id');
        if (!captured) {
          action = 'release-booking';
          note = `portal booking, reservation #${reservation.id}`;
        } else {
          reservation = null;
        }
      } else {
        reservation = null;
      }
    }
    plan.push({ payment, action, note, intent, reservation });
  }

  out(`${flags.apply ? 'APPLY' : 'DRY RUN'}: ${plan.length} candidate payment(s) created before ${before.toISOString()}.`);
  for (const { payment, action, note } of plan) {
    const tab = payment.pos_order_id ? ` pos_order=${payment.pos_order_id}` : '';
    out(`  payment ${payment.id} tenant=${payment.tenant_id} target=${payment.settlement_target} status=${payment.status} amount=${payment.amount} age=${age(payment.created_at, now)}${tab} -> ${action}${note ? ` (${note})` : ''}`);
  }
  if (!flags.apply) {
    out('Dry run: nothing was changed. Re-run with --apply to write.');
    return 0;
  }

  let closed = 0;
  let skipped = 0;
  let failed = 0;
  const closedTabs = new Set();
  const releasedBookings = [];
  for (const { payment, action, intent, reservation } of plan) {
    if (action === 'exclude') {
      skipped += 1;
      continue;
    }
    const context = workerContext({ tenantId: String(payment.tenant_id), propertyId: String(payment.property_id) });
    try {
      if (hooks.beforeClose) await hooks.beforeClose(payment);
      if (action === 'cancel-intent') {
        const { cancelLocally } = require('../src/modules/supermarket/paystack-sale');
        await cancelLocally({ context, intentId: intent.id, reason: REASON, userId: null });
        const now2 = await db('payments').where({ id: payment.id }).first('status');
        if (now2.status === 'CANCELLED') closed += 1;
        else skipped += 1;
        continue;
      }
      const didClose = await scopedDb().for(context).transaction(async (trx) => {
        const updated = await trx
          .table('payments')
          .where({ id: payment.id, provider: 'paystack' })
          .whereNull('parent_payment_id')
          .whereIn('status', OPEN_STATUSES)
          .update({ status: 'CANCELLED', failure_reason: REASON });
        if (updated === 0) return false;
        if (hooks.afterUpdate) await hooks.afterUpdate(payment);
        await recordAuditEntry(trx, {
          entityType: 'payments',
          entityId: payment.id,
          propertyId: payment.property_id,
          userId: null,
          action: 'gateway_payment_closed',
          source: 'job',
          beforeState: { status: payment.status },
          afterState: { status: 'CANCELLED' },
          reason: REASON,
        });
        if (action === 'release-booking') {
          const { abandonUnpaidBooking } = require('../src/modules/portal/service');
          await abandonUnpaidBooking({ trx, reservationId: reservation.id, reason: REASON });
        }
        return true;
      });
      if (didClose) {
        closed += 1;
        if (payment.pos_order_id) closedTabs.add(String(payment.pos_order_id));
        if (action === 'release-booking') releasedBookings.push(reservation.id);
      } else {
        skipped += 1;
        out(`  payment ${payment.id}: no longer INITIATED/PENDING, left as it is.`);
      }
    } catch (error) {
      failed += 1;
      out(`  payment ${payment.id}: FAILED, rolled back (${error.code ?? error.message}).`);
    }
  }

  out(`closed: ${closed}, left alone: ${skipped}, failed: ${failed}`);
  if (releasedBookings.length) out(`portal bookings released: ${releasedBookings.join(', ')}`);
  if (closedTabs.size) out(`POS tabs with a closed payment (void or settle them): ${[...closedTabs].join(', ')}`);
  return failed ? 1 : 0;
}

module.exports = { run, REASON };

if (require.main === module) {
  const { knex, destroy } = require('../src/db');
  run({ db: knex(), argv: process.argv.slice(2), out: (line) => console.log(line) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Failed: ${error.code ?? error.message}`);
      process.exitCode = 1;
    })
    .finally(() => destroy());
}
