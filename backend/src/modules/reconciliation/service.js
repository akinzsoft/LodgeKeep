'use strict';

/**
 * Payment reconciliation report — gap closure: guest card payments now
 * settle into each property's own Paystack Subaccount
 * (`property_payment_subaccounts`), and a hotel needs one view of every
 * payment it has taken to tick against its Paystack settlement/bank
 * statement, regardless of which module actually recorded the money (a
 * room folio, a bar/restaurant tab, a guest QR order, or a guest-portal
 * booking — all four fund the SAME underlying `payments` ledger, just
 * reached through different tables around it).
 *
 * New module, not folded into `cashiering` or `pos` — `payments` has no
 * single owning module (written by `cashiering`, `pos`, and indirectly
 * `qr-ordering` via `pos`'s own guest-order settlement path); mirrors the
 * precedent `expenses/reporting.js` already established for "a report
 * whose subject spans modules with no natural single owner": lives in its
 * own home and reaches one-way into the modules it composes
 * (`pos/sales-report.js`'s `listStandingSettlements`/
 * `listUnsettledCardPayments`) — neither of those modules requires
 * anything from this one, so no cycle results.
 *
 * ── THE UNION, AND A REAL CORRECTION MADE DURING IMPLEMENTATION ─────────
 *
 * Two structurally different query shapes, merged in application code —
 * not a SQL UNION (the two sides need genuinely different joins: the folio
 * side needs `reservations`/`guests`/`booking_sources`; the POS side needs
 * `pos_outlets`/`pos_orders`), matching how `pos/sales-report.js` itself
 * already assembles a report from several queries in app code rather than
 * one giant join.
 *
 * The FOLIO side queries FROM `payments` — every folio-settled payment
 * gets its own `folio_line_items` row (`type`: `payment` or `refund`,
 * `payment_id` set) the moment it's captured, so an inner join through
 * that column naturally excludes anything that never became real money
 * (INITIATED/PENDING/FAILED/etc.) with no extra status filter needed.
 *
 * The POS side does NOT query from `payments`. The original design for
 * this report did, and it was wrong — verified directly against the real
 * `settleOrder` code (`pos/service.js`) before writing this: a cash tender
 * at a POS terminal never creates a `payments` row at all (only
 * `card`/`nqr` tenders claim one, via `claimRegisterPaymentForCheck`).
 * Querying FROM `payments` filtered to `settlement_target IN ('pos_order',
 * 'pos_register')` would silently drop every cash POS sale from this
 * report — the one failure mode a bank-reconciliation report must never
 * have. The POS side instead queries FROM `pos_order_settlements`
 * (`listStandingSettlements`, reused), the same base every cash/card/nqr
 * tender already lands on regardless of how it was paid, left-joining
 * `payments` only for the gateway-specific fields a card/nqr row carries.
 *
 * A `room_charge` POS settlement (a bar tab billed to the guest's room) is
 * excluded from the POS side entirely — no money has moved yet; it is
 * unpaid, folio-owed debt until the guest later settles that folio, at
 * which point it correctly appears on the FOLIO side as an ordinary folio
 * payment. Including it here too would double-count the same money twice.
 *
 * ── REFUNDS ──────────────────────────────────────────────────────────────
 *
 * Verified directly against the real refund code (`refundPayment`,
 * `cashiering/service.js`) before relying on it, per explicit instruction
 * — not assumed from a migration comment:
 *
 * - A FOLIO-target refund (cash or Paystack) gets its OWN
 *   `folio_line_items` row (`type: 'refund'`, `payment_id` set to the
 *   refund's own `payments.id`) — it is picked up by the folio-side query
 *   automatically, with no special-casing, the same as any other folio
 *   payment.
 *
 * - A POS-target refund inherits `settlement_target`/`pos_order_id` from
 *   its parent EXPLICITLY (`refundPayment`'s `isPosOrderTarget` branch),
 *   but does NOT get a new `pos_order_settlements` row — the ORIGINAL
 *   settlement is voided instead (a real gap found while writing this
 *   report's own tests, not assumed: this happens even for a PARTIAL
 *   refund — there is no partial-settlement-adjustment concept for POS).
 *   Once voided, the ORIGINAL captured payment vanishes from BOTH
 *   `listStandingSettlements` (excluded, now voided) AND
 *   `listUnsettledCardPayments` (its own status has since moved off
 *   `CAPTURED`) — showing only the refund's negative line would silently
 *   drop a real charge that also hit the bank. `listPosRefundLines` below
 *   resolves both: the refund's own negative-signed line, AND a
 *   reconstructed positive line for the now-otherwise-invisible original
 *   charge, both keyed against the voided parent settlement (found by the
 *   refund's own `parent_payment_id`, regardless of `voided_at`) purely for
 *   display context (outlet, original business date). A cash POS refund
 *   does not exist — a cash POS settlement never has a `payments` row to
 *   refund through
 *   `refundPayment` at all; reversing one voids the settlement directly.
 *
 * ── UNMATCHED / ORPHANED CAPTURES ────────────────────────────────────────
 *
 * `listUnsettledCardPayments` (reused) already exists for exactly the
 * reason this report needs it: a captured Register/QR card payment that no
 * standing settlement ever claimed (e.g. paid after its tab was voided).
 * Silently omitting these would make this report disagree with Paystack's
 * own settlement export by exactly that amount. A refund payment's own
 * "unsettled" row is excluded from that function now (see its own
 * comment) so a refund is never listed twice — once as a refund, once as
 * "still needs a refund."
 *
 * ── GROSS / NET ──────────────────────────────────────────────────────────
 *
 * `payments.platform_fee_percentage` (new column, this pass) is a snapshot
 * taken at checkout time — never re-derived from the property's current,
 * mutable subaccount config (confirmed decision, matching the identical
 * reasoning `subaccount_code`'s own migration already established). A
 * refund's OWN `payments` row is never stamped with one — it's created
 * directly by `refundPayment`, not through `startPaystackCheckout` — so
 * its fee is resolved from its PARENT payment's own snapshot instead, and
 * a refund of a fee-bearing charge is reported net of the same fee the
 * original charge was. A missing/null percentage (cash, or any payment
 * predating this column) is treated as `0.00`, never a crash or a
 * fabricated figure.
 *
 * Cash rows are included (the hotel's own stated goal is "one view of
 * every payment... never look in two places") but carry no fee/reference/
 * channel data — `feeAmount: '0.00'`, `netAmount` equal to `grossAmount`,
 * `providerReference`/`providerPaymentId`/`providerChannel` all `null`.
 *
 * ── SOURCE ───────────────────────────────────────────────────────────────
 *
 * A structured object, not a flat string (confirmed decision) — "bar"/
 * "restaurant" (an outlet's own free-text name) and "QR" (`pos_orders.source`
 * — staff vs guest, an independent axis; a QR order can happen at any
 * outlet) are two genuinely different facts, not one taxonomy. `kind` is
 * `'room_folio'` or `'pos'`; `label` is the resolved booking source's name
 * ("Guest Portal", "Direct", "OTA" — or a plain "Room folio" fallback when
 * none is set) for a folio line, or the outlet's own name for a POS line;
 * `channel` is `null` for a folio line, `'staff'`/`'guest'` for a POS line.
 *
 * ── MULTI-CURRENCY ───────────────────────────────────────────────────────
 *
 * Totals are grouped by currency, never blended (ARCHITECTURE.md §1) —
 * `summary` is an array with one entry per currency present in range
 * (almost always exactly one, matching the property's own `base_currency`),
 * and `bySource`/`byMethod` rows each carry their own `currency` too.
 */

const { scopedDb } = require('../../db');
const { sumMoney, negateMoney, percentOfMoney, compareMoney } = require('../../shared/money');
const { ValidationError } = require('../../shared/errors');
const { listStandingSettlements, listUnsettledCardPayments } = require('../pos/sales-report');

const MAX_RANGE_DAYS = 92;

function daysBetween(dateFrom, dateTo) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/** A reconciliation report is inherently a bounded-period activity (one Paystack settlement batch, one bank statement) — this caps an accidentally-huge range before it turns into an unbounded, every-payment-ever query. */
function assertReasonableRange(dateFrom, dateTo) {
  if (daysBetween(dateFrom, dateTo) > MAX_RANGE_DAYS) {
    throw new ValidationError('RECONCILIATION_RANGE_TOO_WIDE', `The date range must not exceed ${MAX_RANGE_DAYS} days.`, [
      { field: 'date_to', issue: 'range_too_wide' },
    ]);
  }
}

/** Money moved on a folio — every night's room charge paid, a checkout settlement, a guest-portal booking payment, and both folio-side refund shapes (cash and Paystack) — see file header. */
async function listFolioPaymentLines({ db, dateFrom, dateTo }) {
  return db
    .table('payments')
    .joinScoped('folio_line_items', (join) => join.on('folio_line_items.payment_id', '=', 'payments.id'))
    .joinScoped('folios', (join) => join.on('folios.id', '=', 'payments.folio_id'))
    .joinScoped('reservations', (join) => join.on('reservations.id', '=', 'folios.reservation_id'))
    .joinScoped('guests', (join) => join.on('guests.id', '=', 'reservations.guest_id'), { type: 'left' })
    .joinScoped('booking_sources', (join) => join.on('booking_sources.id', '=', 'reservations.booking_source_id'), { type: 'left' })
    .where('payments.settlement_target', 'folio')
    .whereNull('folio_line_items.voided_at')
    .whereBetween('folio_line_items.business_date', [dateFrom, dateTo])
    .select(
      'payments.id as payment_id',
      'payments.provider as provider',
      'payments.provider_reference as provider_reference',
      'payments.provider_payment_id as provider_payment_id',
      'payments.provider_channel as provider_channel',
      'payments.parent_payment_id as parent_payment_id',
      'payments.platform_fee_percentage as platform_fee_percentage',
      'payments.amount as amount',
      'payments.currency as currency',
      'payments.captured_at as captured_at',
      'folio_line_items.type as line_type',
      'folio_line_items.business_date as business_date',
      'reservations.id as reservation_id',
      'guests.first_name as guest_first_name',
      'guests.last_name as guest_last_name',
      'booking_sources.name as booking_source_name'
    )
    .orderBy('folio_line_items.business_date', 'desc');
}

/** The most recently assigned room for each reservation, purely presentational context — not a legal record of who occupied it at the exact moment of payment (`roomChargeTargets` in `pos/sales-report.js` does that finer-grained resolution for POS charge-to-room specifically; this report's own folio lines don't need that precision). */
async function resolveRoomNumbers({ db, reservationIds }) {
  if (reservationIds.length === 0) return new Map();
  const rows = await db
    .table('reservation_rooms')
    .joinScoped('rooms', (join) => join.on('rooms.id', '=', 'reservation_rooms.room_id'))
    .whereIn('reservation_rooms.reservation_id', reservationIds)
    .select('reservation_rooms.reservation_id as reservation_id', 'rooms.room_number as room_number')
    .orderBy('reservation_rooms.effective_from', 'desc');
  const map = new Map();
  for (const row of rows) {
    const key = String(row.reservation_id);
    if (!map.has(key)) map.set(key, row.room_number); // rows arrive newest-assignment-first; the first one seen per reservation wins.
  }
  return map;
}

/**
 * A POS-target refund payment AND its own now-unlisted parent — real
 * correctness gap found while writing this report's own tests, not
 * assumed from the migration comments: `refundPayment`'s `isPosOrderTarget`
 * branch voids the ENTIRE original settlement regardless of whether the
 * refund is full or partial (there is no partial-settlement-adjustment
 * concept for POS). Once voided, the original captured payment vanishes
 * from BOTH `listStandingSettlements` (excluded, now voided) AND
 * `listUnsettledCardPayments` (its own status has since moved off
 * `CAPTURED` to `REFUNDED`/`PARTIALLY_REFUNDED`) — a report that only
 * showed the refund's own negative line would silently drop the original
 * charge that genuinely also hit the bank/Paystack settlement, which is
 * exactly the kind of gap this report exists to never have. Both the
 * original charge (its own POSITIVE line, reconstructed here since no
 * other query surfaces it once voided) and the refund (its own NEGATIVE
 * line) are returned.
 */
async function listPosRefundLines({ db, dateFrom, dateTo }) {
  const refunds = await db
    .table('payments')
    .whereIn('settlement_target', ['pos_order', 'pos_register'])
    .whereNotNull('parent_payment_id')
    .where('status', 'CAPTURED')
    .select(
      'id as payment_id',
      'pos_order_id',
      'tender',
      'amount',
      'currency',
      'captured_at',
      'provider_reference',
      'provider_payment_id',
      'provider_channel',
      'parent_payment_id'
    );
  if (refunds.length === 0) return [];

  const parentIds = [...new Set(refunds.map((row) => String(row.parent_payment_id)))];
  const parents = await db
    .table('payments')
    .whereIn('id', parentIds)
    .select('id', 'tender', 'amount', 'currency', 'captured_at', 'provider_reference', 'provider_payment_id', 'provider_channel', 'platform_fee_percentage');
  const parentById = new Map(parents.map((row) => [String(row.id), row]));

  const parentSettlements = await db
    .table('pos_order_settlements')
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'pos_order_settlements.pos_order_id'))
    .whereIn('pos_order_settlements.payment_id', parentIds)
    .select(
      'pos_order_settlements.payment_id as parent_payment_id',
      'pos_order_settlements.business_date as business_date',
      'pos_orders.outlet_id as outlet_id',
      'pos_orders.source as source'
    );
  const settlementByParentId = new Map(parentSettlements.map((row) => [String(row.parent_payment_id), row]));

  const outletIds = [...new Set(parentSettlements.map((row) => String(row.outlet_id)).filter(Boolean))];
  const outlets = outletIds.length ? await db.table('pos_outlets').whereIn('id', outletIds).select('id', 'name') : [];
  const outletNameById = new Map(outlets.map((row) => [String(row.id), row.name]));

  const lines = [];
  const reconstructedParentIds = new Set();
  for (const refund of refunds) {
    const settlement = settlementByParentId.get(String(refund.parent_payment_id));
    const outletName = settlement?.outlet_id ? outletNameById.get(String(settlement.outlet_id)) ?? null : null;
    // A refund's own resolved business_date always prefers the ORIGINAL
    // settlement's — the day the money was actually earned/owed — falling
    // back to the refund's own capture date only if that settlement can no
    // longer be found at all (should not happen in practice: voiding a
    // settlement never deletes it).
    const businessDate = settlement?.business_date ?? new Date(refund.captured_at).toISOString().slice(0, 10);

    const parent = parentById.get(String(refund.parent_payment_id));
    if (parent && !reconstructedParentIds.has(String(parent.id))) {
      reconstructedParentIds.add(String(parent.id));
      if (businessDate >= dateFrom && businessDate <= dateTo) {
        lines.push({
          isOriginalOfVoidedSettlement: true,
          paymentId: parent.id,
          businessDate,
          capturedAt: parent.captured_at,
          amount: parent.amount,
          currency: parent.currency,
          tender: parent.tender,
          providerReference: parent.provider_reference,
          providerPaymentId: parent.provider_payment_id,
          providerChannel: parent.provider_channel,
          platformFeePercentage: parent.platform_fee_percentage,
          outletId: settlement?.outlet_id ?? null,
          outletName,
          source: settlement?.source ?? null,
        });
      }
    }

    if (businessDate < dateFrom || businessDate > dateTo) continue;
    lines.push({
      paymentId: refund.payment_id,
      businessDate,
      capturedAt: refund.captured_at,
      amount: refund.amount,
      currency: refund.currency,
      tender: refund.tender,
      providerReference: refund.provider_reference,
      providerPaymentId: refund.provider_payment_id,
      providerChannel: refund.provider_channel,
      parentPaymentId: refund.parent_payment_id,
      platformFeePercentage: parentById.get(String(refund.parent_payment_id))?.platform_fee_percentage ?? null,
      outletId: settlement?.outlet_id ?? null,
      outletName,
      source: settlement?.source ?? null,
    });
  }
  return lines;
}

function feeAndNet(grossAmount, feePercentage) {
  const feeAmount = percentOfMoney(grossAmount, feePercentage ?? '0.00');
  const netAmount = sumMoney([grossAmount, negateMoney(feeAmount)]);
  return { feeAmount, netAmount };
}

function folioSourceLabel(row) {
  return row.booking_source_name ?? 'Room folio';
}

function toFolioLine(row, roomNumberByReservation, parentFeeById) {
  const isRefund = row.line_type === 'refund';
  const grossAmount = isRefund ? negateMoney(row.amount) : row.amount;
  const method = row.provider === 'paystack' ? 'card' : 'cash';
  // A refund's OWN `payments` row is created directly by `refundPayment`,
  // never through `startPaystackCheckout` — it carries no snapshot of its
  // own, so its fee is resolved from its PARENT payment's snapshot instead
  // (see file header — the identical fallback `listPosRefundLines` already
  // needs for the POS side of this same report).
  const feePercentage = row.platform_fee_percentage ?? (row.parent_payment_id ? parentFeeById.get(String(row.parent_payment_id)) ?? null : null);
  const { feeAmount, netAmount } = row.provider === 'paystack' ? feeAndNet(grossAmount, feePercentage) : { feeAmount: '0.00', netAmount: grossAmount };
  return {
    paymentId: row.payment_id,
    businessDate: String(row.business_date),
    capturedAt: row.captured_at,
    grossAmount,
    feeAmount,
    netAmount,
    currency: row.currency,
    method,
    providerChannel: row.provider === 'paystack' ? row.provider_channel ?? null : null,
    providerReference: row.provider === 'paystack' ? row.provider_reference ?? null : null,
    providerPaymentId: row.provider === 'paystack' ? row.provider_payment_id ?? null : null,
    source: { kind: 'room_folio', label: folioSourceLabel(row), channel: null },
    guestName: [row.guest_first_name, row.guest_last_name].filter(Boolean).join(' ') || null,
    roomNumber: roomNumberByReservation.get(String(row.reservation_id)) ?? null,
    isRefund,
    parentPaymentId: row.parent_payment_id ?? null,
  };
}

function toPosSettlementLine(row) {
  const grossAmount = sumMoney([row.subtotal, row.tax_amount, row.tip_amount, row.service_charge]);
  const isCard = row.tender !== 'cash';
  const { feeAmount, netAmount } = isCard ? feeAndNet(grossAmount, row.platform_fee_percentage) : { feeAmount: '0.00', netAmount: grossAmount };
  return {
    paymentId: row.payment_id ?? null,
    businessDate: String(row.business_date),
    capturedAt: row.settled_at,
    grossAmount,
    feeAmount,
    netAmount,
    currency: row.currency,
    method: row.tender,
    providerChannel: isCard ? row.provider_channel ?? null : null,
    providerReference: isCard ? row.provider_reference ?? null : null,
    providerPaymentId: isCard ? row.provider_payment_id ?? null : null,
    source: { kind: 'pos', label: row.outlet_name ?? `Outlet #${row.outlet_id}`, channel: row.source ?? null },
    guestName: null,
    roomNumber: null,
    isRefund: false,
    parentPaymentId: null,
  };
}

function toOrphanedCaptureLine(row, outletNameById) {
  const isCard = row.tender !== 'cash';
  const { feeAmount, netAmount } = isCard ? feeAndNet(row.amount, row.platformFeePercentage) : { feeAmount: '0.00', netAmount: row.amount };
  return {
    paymentId: row.paymentId,
    businessDate: new Date(row.capturedAt).toISOString().slice(0, 10),
    capturedAt: row.capturedAt,
    grossAmount: row.amount,
    feeAmount,
    netAmount,
    currency: row.currency,
    method: row.tender ?? 'card',
    providerChannel: isCard ? row.providerChannel ?? null : null,
    providerReference: isCard ? row.providerReference ?? null : null,
    providerPaymentId: isCard ? row.providerPaymentId ?? null : null,
    source: { kind: 'pos', label: outletNameById.get(String(row.outletId)) ?? 'Unmatched POS payment', channel: row.source ?? null },
    guestName: null,
    roomNumber: null,
    isRefund: false,
    parentPaymentId: null,
    note: 'No standing settlement references this payment — verify it against Paystack directly.',
  };
}

function toPosRefundLine(row) {
  // `isOriginalOfVoidedSettlement`: the reconstructed POSITIVE line for a
  // charge whose settlement was voided by a later refund — see
  // `listPosRefundLines`'s own header. Everything else here is the
  // refund's own NEGATIVE line.
  const grossAmount = row.isOriginalOfVoidedSettlement ? row.amount : negateMoney(row.amount);
  const { feeAmount, netAmount } = feeAndNet(grossAmount, row.platformFeePercentage);
  return {
    paymentId: row.paymentId,
    businessDate: row.businessDate,
    capturedAt: row.capturedAt,
    grossAmount,
    feeAmount,
    netAmount,
    currency: row.currency,
    method: row.tender ?? 'card',
    providerChannel: row.providerChannel ?? null,
    providerReference: row.providerReference ?? null,
    providerPaymentId: row.providerPaymentId ?? null,
    source: { kind: 'pos', label: row.outletName ?? 'Unmatched POS payment', channel: row.source ?? null },
    guestName: null,
    roomNumber: null,
    isRefund: !row.isOriginalOfVoidedSettlement,
    parentPaymentId: row.isOriginalOfVoidedSettlement ? null : row.parentPaymentId,
  };
}

function groupBy(lines, keyFn) {
  const groups = new Map();
  for (const line of lines) {
    const key = keyFn(line);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  return groups;
}

function summarizeByCurrency(lines) {
  const groups = groupBy(lines, (line) => line.currency);
  return [...groups.entries()]
    .map(([currency, rows]) => ({
      currency,
      count: rows.length,
      grossTotal: sumMoney(rows.map((row) => row.grossAmount)),
      feeTotal: sumMoney(rows.map((row) => row.feeAmount)),
      netTotal: sumMoney(rows.map((row) => row.netAmount)),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function summarizeBySource(lines) {
  const groups = groupBy(lines, (line) => `${line.currency}\u0000${line.source.kind}\u0000${line.source.label}\u0000${line.source.channel ?? ''}`);
  return [...groups.values()]
    .map((rows) => ({
      currency: rows[0].currency,
      source: rows[0].source,
      count: rows.length,
      grossTotal: sumMoney(rows.map((row) => row.grossAmount)),
      netTotal: sumMoney(rows.map((row) => row.netAmount)),
    }))
    .sort((a, b) => compareMoney(b.grossTotal, a.grossTotal));
}

function summarizeByMethod(lines) {
  const groups = groupBy(lines, (line) => `${line.currency}\u0000${line.method}`);
  return [...groups.values()]
    .map((rows) => ({
      currency: rows[0].currency,
      method: rows[0].method,
      count: rows.length,
      grossTotal: sumMoney(rows.map((row) => row.grossAmount)),
    }))
    .sort((a, b) => compareMoney(b.grossTotal, a.grossTotal));
}

async function computePaymentReconciliation({ context, dateFrom, dateTo }) {
  assertReasonableRange(dateFrom, dateTo);
  const db = scopedDb().for(context);
  const property = await db.table('properties').where({ id: context.propertyId }).first('base_currency');

  const folioRows = await listFolioPaymentLines({ db, dateFrom, dateTo });
  const reservationIds = [...new Set(folioRows.map((row) => String(row.reservation_id)))];
  const roomNumberByReservation = await resolveRoomNumbers({ db, reservationIds });
  const folioParentIds = [...new Set(folioRows.filter((row) => row.line_type === 'refund' && row.parent_payment_id).map((row) => String(row.parent_payment_id)))];
  const folioParentFeeById = folioParentIds.length
    ? new Map((await db.table('payments').whereIn('id', folioParentIds).select('id', 'platform_fee_percentage')).map((row) => [String(row.id), row.platform_fee_percentage]))
    : new Map();
  const folioLines = folioRows.map((row) => toFolioLine(row, roomNumberByReservation, folioParentFeeById));

  const settlementRows = await listStandingSettlements({ db, dateFrom, dateTo });
  const posSettlementLines = settlementRows.filter((row) => row.method !== 'room_charge').map(toPosSettlementLine);

  const unsettled = await listUnsettledCardPayments({ db });
  const unsettledOutletIds = [...new Set(unsettled.map((row) => String(row.outletId)).filter(Boolean))];
  const unsettledOutlets = unsettledOutletIds.length ? await db.table('pos_outlets').whereIn('id', unsettledOutletIds).select('id', 'name') : [];
  const unsettledOutletNameById = new Map(unsettledOutlets.map((row) => [String(row.id), row.name]));
  const orphanedLines = unsettled
    .filter((row) => {
      const businessDate = new Date(row.capturedAt).toISOString().slice(0, 10);
      return businessDate >= dateFrom && businessDate <= dateTo;
    })
    .map((row) => toOrphanedCaptureLine(row, unsettledOutletNameById));

  const posRefundRows = await listPosRefundLines({ db, dateFrom, dateTo });
  const posRefundLines = posRefundRows.map(toPosRefundLine);

  const lines = [...folioLines, ...posSettlementLines, ...orphanedLines, ...posRefundLines].sort((a, b) => {
    if (a.businessDate !== b.businessDate) return a.businessDate < b.businessDate ? 1 : -1;
    return new Date(b.capturedAt) - new Date(a.capturedAt);
  });

  return {
    dateFrom,
    dateTo,
    currency: property?.base_currency ?? null,
    summary: summarizeByCurrency(lines),
    bySource: summarizeBySource(lines),
    byMethod: summarizeByMethod(lines),
    lines,
  };
}

const CSV_COLUMNS = [
  'businessDate',
  'capturedAt',
  'sourceLabel',
  'sourceChannel',
  'method',
  'providerChannel',
  'grossAmount',
  'feeAmount',
  'netAmount',
  'currency',
  'providerReference',
  'providerPaymentId',
  'guestName',
  'roomNumber',
  'isRefund',
];

function toCsvRows(lines) {
  return lines.map((line) => ({
    ...line,
    sourceLabel: line.source.label,
    sourceChannel: line.source.channel ?? '',
  }));
}

module.exports = { computePaymentReconciliation, CSV_COLUMNS, toCsvRows, MAX_RANGE_DAYS };
