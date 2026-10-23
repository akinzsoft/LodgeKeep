'use strict';

/**
 * POS Sales report — what the Register actually took over a business-date
 * range: totals per tender, top-selling items, and every settled tab.
 * `pos.manage` only (a reconciliation report, not a till action — see
 * `routes.js`).
 *
 * Filters on `pos_order_settlements.business_date` (ARCHITECTURE.md §6),
 * never the wall clock. A settlement voided by hand was reversed and took no
 * money, so it is excluded everywhere. A settlement voided by a full card
 * refund is different: the sale really happened, so it stays in the money
 * totals (tenders, outlets, settled tabs) on its own business date, and the
 * refund is a separate negative line (`refunds`) on the day it was processed
 * (`shared/refund-date.js`). Net = sales settled in the range minus refunds
 * processed in the range, so a closed day never changes after the fact.
 * Item rows follow the same rule (so they add up to the summary); PROFIT and
 * margin are worked out only on checks that still stand (the refund reversed
 * that stock, so there is no cost to set against a refunded sale). On a split
 * tab, only the items of checks that were not hand-voided count toward top
 * sellers.
 *
 * Money is summed exactly (`shared/money.js`), never as floats. Totals are
 * in the property's `base_currency` — POS rows carry no currency of their
 * own beyond the settlement's.
 *
 * `unsettledCardPayments` is deliberately NOT date-filtered: it lists every
 * POS card/NQR payment Paystack captured (Register or guest QR order) that
 * no standing settlement uses — e.g. paid after its tab was voided —
 * however old. Each one is money that needs refunding.
 */

const { scopedDb } = require('../../db');
const { sumMoney, negateMoney, compareMoney, toCents, fromCents } = require('../../shared/money');
const { computeItemLineTotal } = require('../../shared/pos-pricing');
const { isPointOfSaleOutlet, SUPERMARKET_OUTLET_TYPE } = require('../../shared/outlet-types');
const { allocateLineNetAndTax } = require('../../shared/line-allocation');
const { applyDiscounts } = require('../../shared/discount-pricing');
const cashieringService = require('../cashiering/service');
const { refundDates } = require('../../shared/refund-date');

const TENDERS = ['cash', 'card', 'nqr', 'terminal', 'room_charge'];
const TOP_ITEMS_LIMIT = 20;

function groupKey(splitGroup) {
  return splitGroup === null || splitGroup === undefined ? 'null' : String(splitGroup);
}

/** Exact `unit cost × whole quantity` — money never goes through a float. */
function multiplyMoneyByCount(moneyStr, count) {
  return fromCents(toCents(moneyStr) * BigInt(count));
}

/** `profit / revenue` as a percentage for display only, or null when there is no revenue to divide by. */
function marginPercent(profit, revenue) {
  return revenue === '0.00' ? null : (Number(profit) / Number(revenue)) * 100;
}

function cashierName(row) {
  const name = [row.cashier_first_name, row.cashier_last_name].filter(Boolean).join(' ');
  return name || null;
}

async function listStandingSettlements({ db, dateFrom, dateTo, outletId, refundedOriginals = false }) {
  let query = db
    .table('pos_order_settlements')
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'pos_order_settlements.pos_order_id'))
    .joinScoped('pos_outlets', (join) => join.on('pos_outlets.id', '=', 'pos_orders.outlet_id'), { type: 'left' })
    .joinScoped('users', (join) => join.on('users.id', '=', 'pos_order_settlements.settled_by_user_id'), { type: 'left' })
    .joinScoped('payments', (join) => join.on('payments.id', '=', 'pos_order_settlements.payment_id'), { type: 'left' })
    .whereBetween('pos_order_settlements.business_date', [dateFrom, dateTo]);
  // Only a gateway-paid settlement is ever voided by a refund (a hand void of one is refused), so a voided settlement
  // whose payment is REFUNDED is a sale that was refunded in full.
  query = refundedOriginals ? query.whereNotNull('pos_order_settlements.voided_at').where('payments.status', 'REFUNDED') : query.whereNull('pos_order_settlements.voided_at');
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  const rows = await query
    .select(
      'pos_order_settlements.id as id',
      'pos_order_settlements.pos_order_id as pos_order_id',
      'pos_order_settlements.split_group as split_group',
      'pos_order_settlements.method as method',
      'pos_order_settlements.tender as tender',
      'pos_order_settlements.terminal_provider as terminal_provider',
      'pos_order_settlements.terminal_reference as terminal_reference',
      'pos_order_settlements.terminal_account_label as terminal_account_label',
      'pos_order_settlements.terminal_account_last4 as terminal_account_last4',
      'pos_order_settlements.subtotal as subtotal',
      'pos_order_settlements.tax_amount as tax_amount',
      'pos_order_settlements.tip_amount as tip_amount',
      'pos_order_settlements.service_charge as service_charge',
      'pos_order_settlements.currency as currency',
      'pos_order_settlements.settled_at as settled_at',
      'pos_order_settlements.business_date as business_date',
      'pos_order_settlements.folio_id as folio_id',
      'payments.id as payment_id',
      'payments.provider as payment_provider',
      'payments.provider_reference as provider_reference',
      'payments.provider_payment_id as provider_payment_id',
      'payments.provider_channel as provider_channel',
      'payments.subaccount_code as subaccount_code',
      'payments.platform_fee_percentage as platform_fee_percentage',
      'pos_orders.table_label as table_label',
      'pos_orders.source as source',
      'pos_orders.outlet_id as outlet_id',
      'pos_outlets.name as outlet_name',
      'pos_outlets.type as outlet_type',
      'users.first_name as cashier_first_name',
      'users.last_name as cashier_last_name'
    )
    .orderBy('pos_order_settlements.settled_at', 'desc');
  if (refundedOriginals) return rows.map((row) => ({ ...row, refunded: true }));
  return withPartialRefunds({ db, rows });
}

/**
 * Full card refunds of Register / guest-order sales PROCESSED in the range, each as a negative line on the day the
 * refund was captured (never the sale's day). A refund is only a line here when its sale's settlement was voided by it
 * (a full refund); a partial refund leaves the sale standing and stays a `partiallyRefunded` note on the payment.
 * Amounts are negative; the components (before tax, tax, service, tip) are the refunded sale's own.
 */
async function listRefundLines({ db, dateFrom, dateTo, outletId, timeZone }) {
  const day = 24 * 60 * 60 * 1000;
  // A refund counts on the business date recorded when it was processed, else on its capture date in the property's
  // timezone. So fetch the refunds recorded in range, plus those captured near it (a day either side), then settle each one's date.
  const from = new Date(Date.parse(`${dateFrom}T00:00:00Z`) - day);
  const to = new Date(Date.parse(`${dateTo}T00:00:00Z`) + 2 * day);
  const recordedIds = (await db.table('refund_reconciliations').whereBetween('business_date', [dateFrom, dateTo]).select('payment_id')).map((row) => row.payment_id);
  const refunds = await db
    .table('payments')
    .whereIn('settlement_target', ['pos_register', 'pos_order', 'supermarket_sale'])
    .whereNotNull('parent_payment_id')
    .where({ status: 'CAPTURED' })
    .where((group) => (recordedIds.length ? group.whereBetween('captured_at', [from, to]).orWhereIn('id', recordedIds) : group.whereBetween('captured_at', [from, to])))
    .select('id', 'parent_payment_id', 'tender', 'amount', 'currency', 'captured_at', 'provider_reference');
  const dateOf = await refundDates({ db, refunds, timeZone });
  const dated = refunds.map((refund) => ({ refund, date: dateOf.get(String(refund.id)) })).filter(({ date }) => date >= dateFrom && date <= dateTo);
  if (dated.length === 0) return [];

  const parentIds = [...new Set(dated.map(({ refund }) => String(refund.parent_payment_id)))];
  let settlementQuery = db
    .table('pos_order_settlements')
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'pos_order_settlements.pos_order_id'))
    .joinScoped('pos_outlets', (join) => join.on('pos_outlets.id', '=', 'pos_orders.outlet_id'), { type: 'left' })
    .whereIn('pos_order_settlements.payment_id', parentIds)
    .whereNotNull('pos_order_settlements.voided_at');
  if (outletId) settlementQuery = settlementQuery.where('pos_orders.outlet_id', outletId);
  const settlements = await settlementQuery.select(
    'pos_order_settlements.payment_id as payment_id',
    'pos_order_settlements.pos_order_id as pos_order_id',
    'pos_order_settlements.business_date as business_date',
    'pos_order_settlements.tender as tender',
    'pos_order_settlements.method as method',
    'pos_order_settlements.subtotal as subtotal',
    'pos_order_settlements.tax_amount as tax_amount',
    'pos_order_settlements.tip_amount as tip_amount',
    'pos_order_settlements.service_charge as service_charge',
    'pos_orders.table_label as table_label',
    'pos_orders.outlet_id as outlet_id',
    'pos_outlets.name as outlet_name'
  );
  const settlementsByPayment = new Map();
  for (const row of settlements) settlementsByPayment.set(String(row.payment_id), [...(settlementsByPayment.get(String(row.payment_id)) ?? []), row]);

  const reconciliations = await db.table('refund_reconciliations').whereIn('payment_id', dated.map(({ refund }) => refund.id)).select('payment_id', 'reason');
  const reasonByRefund = new Map(reconciliations.map((row) => [String(row.payment_id), row.reason]));

  return dated
    .filter(({ refund }) => settlementsByPayment.has(String(refund.parent_payment_id)))
    .map(({ refund, date }) => {
      const rows = settlementsByPayment.get(String(refund.parent_payment_id));
      const first = rows[0];
      return {
        refundPaymentId: refund.id,
        paymentId: refund.parent_payment_id,
        orderId: first.pos_order_id,
        tableLabel: first.table_label,
        outletId: first.outlet_id,
        outletName: first.outlet_name,
        tender: first.tender ?? first.method ?? refund.tender,
        currency: refund.currency,
        providerReference: refund.provider_reference,
        refundedAt: refund.captured_at,
        refundDate: date,
        originalBusinessDate: first.business_date,
        reason: reasonByRefund.get(String(refund.id)) ?? null,
        amount: negateMoney(refund.amount),
        subtotal: negateMoney(sumMoney(rows.map((row) => row.subtotal))),
        tax: negateMoney(sumMoney(rows.map((row) => row.tax_amount))),
        serviceCharge: negateMoney(sumMoney(rows.map((row) => row.service_charge))),
        tips: negateMoney(sumMoney(rows.map((row) => row.tip_amount))),
      };
    })
    .sort((a, b) => String(b.refundedAt).localeCompare(String(a.refundedAt)));
}

/**
 * A card payment can be refunded in part while the sale it paid for stays standing (a full refund voids the sale and
 * drops it from this report). Each standing row whose payment has settled refunds gets `partially_refunded`, the sum of
 * them, so the report shows money went back; rows with no refund are left exactly as they were.
 */
async function withPartialRefunds({ db, rows }) {
  const paymentIds = [...new Set(rows.filter((row) => row.payment_id).map((row) => String(row.payment_id)))];
  if (paymentIds.length === 0) return rows;
  const refunds = await db.table('payments').whereIn('parent_payment_id', paymentIds).where({ status: 'CAPTURED' }).select('parent_payment_id', 'amount');
  const totals = new Map();
  for (const refund of refunds) {
    const key = String(refund.parent_payment_id);
    totals.set(key, sumMoney([totals.get(key) ?? '0.00', refund.amount]));
  }
  // A refund Paystack accepted (or that may have gone out) but never confirmed: shown on the payment so it is not lost.
  const inFlight = await db.table('payments').whereIn('parent_payment_id', paymentIds).where({ provider: 'paystack' }).whereIn('status', ['INITIATED', 'PENDING']);
  const stuckByPayment = new Map();
  if (inFlight.length > 0) {
    for (const refund of await cashieringService.annotateStuckRefunds({ db, payments: inFlight })) {
      stuckByPayment.set(String(refund.parent_payment_id), {
        refundPaymentId: String(refund.id),
        amount: refund.amount,
        status: refund.status,
        note: refund.failure_reason ?? null,
        ...(refund.refundReconciliation ?? {}),
      });
    }
  }
  if (totals.size === 0 && stuckByPayment.size === 0) return rows;
  return rows.map((row) => {
    const key = row.payment_id ? String(row.payment_id) : null;
    if (!key || (!totals.has(key) && !stuckByPayment.has(key))) return row;
    return {
      ...row,
      ...(totals.has(key) ? { partially_refunded: totals.get(key) } : {}),
      ...(stuckByPayment.has(key) ? { refund_in_flight: stuckByPayment.get(key) } : {}),
    };
  });
}

/**
 * Room and guest for each charge-to-room settlement: folio → reservation →
 * the room the guest occupied when the charge posted (falling back to the
 * latest assignment), plus the guest's name. Keyed by folio id.
 */
async function roomChargeTargets({ db, settlements }) {
  const folioIds = [...new Set(settlements.filter((row) => row.folio_id).map((row) => String(row.folio_id)))];
  if (folioIds.length === 0) return new Map();

  const folios = await db
    .table('folios')
    .joinScoped('reservations', (join) => join.on('reservations.id', '=', 'folios.reservation_id'))
    .joinScoped('guests', (join) => join.on('guests.id', '=', 'reservations.guest_id'), { type: 'left' })
    .whereIn('folios.id', folioIds)
    .select('folios.id as folio_id', 'folios.reservation_id as reservation_id', 'guests.first_name as first_name', 'guests.last_name as last_name');
  const reservationIds = [...new Set(folios.map((row) => String(row.reservation_id)))];
  const assignments = reservationIds.length === 0
    ? []
    : await db
      .table('reservation_rooms')
      .joinScoped('rooms', (join) => join.on('rooms.id', '=', 'reservation_rooms.room_id'))
      .whereIn('reservation_rooms.reservation_id', reservationIds)
      .select('reservation_rooms.reservation_id as reservation_id', 'reservation_rooms.effective_from as effective_from', 'reservation_rooms.effective_to as effective_to', 'rooms.room_number as room_number')
      .orderBy('reservation_rooms.effective_from', 'desc');

  const settledAtByFolio = new Map(settlements.filter((row) => row.folio_id).map((row) => [String(row.folio_id), new Date(row.settled_at)]));
  const targets = new Map();
  for (const folio of folios) {
    const settledAt = settledAtByFolio.get(String(folio.folio_id));
    const rooms = assignments.filter((a) => String(a.reservation_id) === String(folio.reservation_id));
    const atCharge = rooms.find((a) => new Date(a.effective_from) <= settledAt && (!a.effective_to || new Date(a.effective_to) > settledAt));
    const room = atCharge ?? rooms[0];
    const guestName = [folio.first_name, folio.last_name].filter(Boolean).join(' ') || null;
    targets.set(String(folio.folio_id), { roomNumber: room?.room_number ?? null, guestName });
  }
  return targets;
}

async function listUnsettledCardPayments({ db, outletId }) {
  let query = db
    .table('payments')
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'payments.pos_order_id'))
    // Register checkouts and guest QR-order card payments both fund a POS tab
    // with no folio; either can end up captured with no settlement using it.
    .whereIn('payments.settlement_target', ['pos_register', 'pos_order'])
    .where({ 'payments.status': 'CAPTURED' })
    // Excludes a refund's OWN payments row (real, if minor, correctness fix
    // this pass found: a completed POS refund inherits settlement_target
    // from its parent but is never itself referenced by any settlement's
    // payment_id, so before this exclusion it would have shown up here as
    // "still needs a refund" even though it IS the refund — the payment
    // reconciliation report's own `listPosRefundLines` is where a refund
    // belongs instead).
    .whereNull('payments.parent_payment_id');
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  const payments = await query
    .select(
      'payments.id as id',
      'payments.pos_order_id as pos_order_id',
      'payments.tender as tender',
      'payments.amount as amount',
      'payments.currency as currency',
      'payments.captured_at as captured_at',
      'payments.provider_reference as provider_reference',
      'payments.provider_payment_id as provider_payment_id',
      'payments.provider_channel as provider_channel',
      'payments.platform_fee_percentage as platform_fee_percentage',
      'pos_orders.table_label as table_label',
      'pos_orders.status as order_status',
      'pos_orders.outlet_id as outlet_id',
      'pos_orders.source as source'
    )
    .orderBy('payments.captured_at', 'desc');
  if (payments.length === 0) return [];

  const linked = await db
    .table('pos_order_settlements')
    .whereIn('payment_id', payments.map((p) => p.id))
    .whereNull('voided_at')
    .select('payment_id');
  const linkedIds = new Set(linked.map((row) => String(row.payment_id)));
  return payments
    .filter((p) => !linkedIds.has(String(p.id)))
    .map((p) => ({
      paymentId: p.id,
      orderId: p.pos_order_id,
      tableLabel: p.table_label,
      orderStatus: p.order_status,
      outletId: p.outlet_id,
      source: p.source,
      tender: p.tender,
      amount: p.amount,
      currency: p.currency,
      capturedAt: p.captured_at,
      providerReference: p.provider_reference,
      providerPaymentId: p.provider_payment_id,
      providerChannel: p.provider_channel,
      platformFeePercentage: p.platform_fee_percentage,
    }));
}

/**
 * One row per point-of-sale outlet: what it took over the range. Every
 * active selling outlet appears, a quiet one with zeros, so "nothing sold
 * at the pool bar" is visible rather than missing. An archived outlet only
 * appears if it sold something in the range. Stores never sell and are
 * left out. `total` is the same figure as the report's `summary.total`
 * (items + tax + tip + service charge), so the rows add up to it.
 */
async function buildOutletRows({ db, settlements, outletId, refundLines = [] }) {
  let query = db.table('pos_outlets').select('id', 'name', 'type', 'status');
  if (outletId) query = query.where({ id: outletId });
  const outlets = (await query).filter(isPointOfSaleOutlet);

  const byOutlet = new Map();
  const rowFor = (id, name) => {
    const key = String(id);
    if (!byOutlet.has(key)) byOutlet.set(key, { outletId: id, name, orders: new Set(), checks: 0, subtotal: [], tax: [], serviceCharge: [], tips: [] });
    return byOutlet.get(key);
  };
  for (const outlet of outlets) {
    if (outlet.status === 'active') rowFor(outlet.id, outlet.name);
  }
  for (const row of settlements) {
    const outlet = outlets.find((candidate) => String(candidate.id) === String(row.outlet_id));
    if (!outlet) continue; // a store, or an outlet outside the filter
    const entry = rowFor(row.outlet_id, outlet.name);
    entry.orders.add(String(row.pos_order_id));
    entry.checks += 1;
    entry.subtotal.push(row.subtotal);
    entry.tax.push(row.tax_amount);
    entry.serviceCharge.push(row.service_charge);
    entry.tips.push(row.tip_amount);
  }
  // Refunds processed in the range come off the outlet that made the sale (an outlet with only refunds still gets a row).
  const refundsByOutlet = new Map();
  for (const line of refundLines) {
    const outlet = outlets.find((candidate) => String(candidate.id) === String(line.outletId));
    if (!outlet) continue;
    rowFor(line.outletId, outlet.name);
    refundsByOutlet.set(String(line.outletId), [...(refundsByOutlet.get(String(line.outletId)) ?? []), line.amount]);
  }
  return [...byOutlet.values()]
    .map((entry) => {
      const subtotal = sumMoney(entry.subtotal);
      const tax = sumMoney(entry.tax);
      const serviceCharge = sumMoney(entry.serviceCharge);
      const tips = sumMoney(entry.tips);
      const total = sumMoney([subtotal, tax, serviceCharge, tips]);
      const refunded = refundsByOutlet.has(String(entry.outletId)) ? sumMoney(refundsByOutlet.get(String(entry.outletId))) : null;
      // `refunded`/`net` exist only on an outlet that had a refund in the range, so every other row keeps its old shape.
      return { outletId: entry.outletId, name: entry.name, tabs: entry.orders.size, checks: entry.checks, subtotal, tax, serviceCharge, tips, total, ...(refunded === null ? {} : { refunded, net: sumMoney([total, refunded]) }) };
    })
    .sort((a, b) => compareMoney(b.total, a.total) || a.name.localeCompare(b.name));
}

/**
 * Scales item lines to their settlement so item rows add up to the summary. Two kinds of sale need it: a supermarket
 * sale (an item's own price is gross of an inclusive VAT row, the settlement's subtotal is net of it; only when
 * `includeSupermarket`) and any sale that carried a discount (the settlement is net of the discount, the item prices
 * are not). Sets `item.netLineTotal`. A sale with neither keeps its item amounts exactly as before.
 */
async function attachNetLineTotals({ db, settlements, items, orderIds, includeSupermarket }) {
  const appliedDiscounts = orderIds.length === 0 ? [] : await db.table('discounts').whereIn('pos_order_id', orderIds).where({ status: 'applied' });
  const discountsByOrder = new Map();
  for (const row of appliedDiscounts) {
    const list = discountsByOrder.get(String(row.pos_order_id)) ?? [];
    list.push(row);
    discountsByOrder.set(String(row.pos_order_id), list);
  }
  const pricingByOrder = new Map();
  for (const [orderId, rows] of discountsByOrder) {
    pricingByOrder.set(orderId, applyDiscounts({ items: items.filter((item) => String(item.pos_order_id) === orderId), discounts: rows }));
  }
  const scaledGroups = new Map();
  for (const row of settlements) {
    if ((includeSupermarket && row.outlet_type === SUPERMARKET_OUTLET_TYPE) || pricingByOrder.has(String(row.pos_order_id))) {
      scaledGroups.set(`${row.pos_order_id}|${groupKey(row.split_group)}`, { subtotal: row.subtotal, taxAmount: row.tax_amount, items: [] });
    }
  }
  for (const item of items) scaledGroups.get(`${item.pos_order_id}|${groupKey(item.split_group)}`)?.items.push(item);
  for (const group of scaledGroups.values()) {
    const weight = (item) => pricingByOrder.get(String(item.pos_order_id))?.lines[String(item.id)]?.base ?? computeItemLineTotal(item);
    const split = allocateLineNetAndTax({ lineTotals: group.items.map(weight), subtotal: group.subtotal, taxAmount: group.taxAmount });
    group.items.forEach((item, index) => {
      item.netLineTotal = split[index].net;
    });
  }
}

async function computeSalesReport({ context, dateFrom, dateTo, outletId, unitCostByMenuItem }) {
  // Profit is only computed when the caller supplies each menu item's unit
  // cost (the controller takes it from the stock margin report — this file
  // cannot require `stock/reporting.js` itself, which already requires this
  // one). Without it the report is exactly what it was before profit existed.
  const withProfit = unitCostByMenuItem instanceof Map;
  const db = scopedDb().for(context);
  const property = await db.table('properties').where({ id: context.propertyId }).first('base_currency', 'timezone');
  // `settlements` = checks that still stand (items, profit and discounts are worked out on these). Sales that were
  // refunded in full stay in the money totals on their own day (`allSettlements`); the refund itself is a separate line.
  const settlements = await listStandingSettlements({ db, dateFrom, dateTo, outletId });
  const refundedOriginals = await listStandingSettlements({ db, dateFrom, dateTo, outletId, refundedOriginals: true });
  const refundLines = await listRefundLines({ db, dateFrom, dateTo, outletId, timeZone: property?.timezone });
  const allSettlements = refundedOriginals.length === 0 ? settlements : [...settlements, ...refundedOriginals].sort((a, b) => new Date(b.settled_at) - new Date(a.settled_at));
  const roomTargets = await roomChargeTargets({ db, settlements });

  const byTender = new Map(TENDERS.map((tender) => [tender, { tender, checks: 0, amounts: [] }]));
  const tabs = new Map();
  for (const row of allSettlements) {
    const tender = row.tender ?? row.method;
    const total = sumMoney([row.subtotal, row.tax_amount, row.tip_amount, row.service_charge]);
    if (!byTender.has(tender)) byTender.set(tender, { tender, checks: 0, amounts: [] });
    const bucket = byTender.get(tender);
    bucket.checks += 1;
    bucket.amounts.push(total);

    const key = String(row.pos_order_id);
    if (!tabs.has(key)) {
      // Rows arrive newest settlement first, so the first row seen carries the tab's settle time.
      tabs.set(key, {
        orderId: row.pos_order_id,
        tableLabel: row.table_label,
        source: row.source,
        outletId: row.outlet_id,
        businessDate: row.business_date,
        settledAt: row.settled_at,
        cashier: cashierName(row),
        tenders: [],
        payments: [],
        amounts: [],
        groups: new Set(),
        checks: 0,
        refundedChecks: 0,
        refundedGroups: new Set(),
      });
    }
    const tab = tabs.get(key);
    tab.checks += 1;
    if (row.refunded) tab.refundedChecks += 1;
    if (!tab.tenders.includes(tender)) tab.tenders.push(tender);
    // One entry per check: how it was paid, the Paystack channel the guest
    // actually used (a Card checkout can be paid by USSD or transfer), and,
    // for a room charge, which room and guest it was billed to.
    const target = row.folio_id ? roomTargets.get(String(row.folio_id)) : null;
    tab.payments.push({
      tender,
      channel: row.provider_channel ?? null,
      // Only a terminal sale carries one; every other tender's entry is unchanged.
      ...(tender === 'terminal'
        ? {
            terminalProvider: row.terminal_provider ?? null,
            terminalAccountLabel: row.terminal_account_label ?? null,
            terminalAccountLast4: row.terminal_account_last4 ?? null,
          }
        : {}),
      roomNumber: target?.roomNumber ?? null,
      guestName: target?.guestName ?? null,
      total,
      // Only a sale refunded in full carries this; its refund is a separate negative line (`refunds`).
      ...(row.refunded ? { refunded: true } : {}),
      // Only a payment that was partly refunded carries this; every other entry keeps its old shape.
      ...(row.partially_refunded ? { partiallyRefunded: row.partially_refunded } : {}),
      // Only a payment with a card refund still waiting on Paystack carries this.
      ...(row.refund_in_flight ? { refundInFlight: row.refund_in_flight } : {}),
    });
    tab.amounts.push(total);
    tab.groups.add(groupKey(row.split_group));
    if (row.refunded) tab.refundedGroups.add(groupKey(row.split_group)); // its items are sold, but carry no profit
  }

  const items = tabs.size === 0
    ? []
    : await db
      .table('pos_order_items')
      .joinScoped('pos_menu_items', (join) => join.on('pos_menu_items.id', '=', 'pos_order_items.menu_item_id'), { type: 'left' })
      .whereIn('pos_order_items.pos_order_id', [...tabs.values()].map((tab) => tab.orderId))
      .whereNull('pos_order_items.voided_at')
      .select(
        'pos_order_items.id as id',
        'pos_order_items.pos_order_id as pos_order_id',
        'pos_order_items.menu_item_id as menu_item_id',
        'pos_order_items.split_group as split_group',
        'pos_order_items.quantity as quantity',
        'pos_order_items.unit_price as unit_price',
        'pos_order_items.modifiers as modifiers',
        'pos_menu_items.name as name'
      );

  await attachNetLineTotals({ db, settlements: allSettlements, items, orderIds: [...tabs.values()].map((tab) => tab.orderId), includeSupermarket: true });

  const itemTotals = new Map();
  for (const item of items) {
    const tab = tabs.get(String(item.pos_order_id));
    if (!tab.groups.has(groupKey(item.split_group))) continue; // that check was voided
    tab.itemCount = (tab.itemCount ?? 0) + item.quantity;
    const key = String(item.menu_item_id);
    if (!itemTotals.has(key)) itemTotals.set(key, { menuItemId: item.menu_item_id, name: item.name ?? `#${item.menu_item_id}`, quantity: 0, amounts: [], standing: [], costs: [], costKnown: true });
    const entry = itemTotals.get(key);
    entry.quantity += item.quantity;
    const lineTotal = item.netLineTotal ?? computeItemLineTotal(item);
    entry.amounts.push(lineTotal);

    // A check refunded in full is sold (it is in the figures) but has no cost to set against it: no profit on it.
    if (!tab.refundedGroups.has(groupKey(item.split_group))) entry.standing.push(lineTotal);
    if (withProfit && !tab.refundedGroups.has(groupKey(item.split_group))) {
      const unitCost = unitCostByMenuItem.get(key) ?? null;
      tab.knownRevenue = tab.knownRevenue ?? [];
      tab.costs = tab.costs ?? [];
      if (unitCost === null) {
        // No recipe and no cost price — an unknown cost is never treated as free.
        entry.costKnown = false;
        tab.unknownCostLines = (tab.unknownCostLines ?? 0) + 1;
      } else {
        const lineCost = multiplyMoneyByCount(unitCost, item.quantity);
        entry.costs.push(lineCost);
        tab.knownRevenue.push(lineTotal);
        tab.costs.push(lineCost);
      }
    }
  }

  const itemRows = [...itemTotals.values()].map(({ menuItemId, name, quantity, amounts, standing, costs, costKnown }) => {
    const sales = sumMoney(amounts);
    const standingSales = sumMoney(standing);
    const row = { menuItemId, name, quantity, sales };
    if (withProfit) {
      const cost = costKnown ? sumMoney(costs) : null;
      const profit = cost === null ? null : sumMoney([standingSales, negateMoney(cost)]);
      Object.assign(row, { cost, profit, marginPct: profit === null ? null : marginPercent(profit, standingSales) });
    }
    Object.defineProperty(row, 'standingSales', { value: standingSales, enumerable: false });
    return row;
  });

  const topItems = itemRows
    .slice()
    .sort((a, b) => b.quantity - a.quantity || compareMoney(b.sales, a.sales) || a.name.localeCompare(b.name))
    .slice(0, TOP_ITEMS_LIMIT);

  // Profit over EVERY item sold (not just the top-N shown), counting only
  // items whose cost is known so an unpriced item can't inflate it.
  let profitSummary = null;
  if (withProfit) {
    const known = itemRows.filter((row) => row.cost !== null);
    if (known.length === 0 && itemRows.length > 0) {
      // Everything that sold has an unknown cost — profit is unknown, not a false zero.
      profitSummary = { revenue: null, cost: null, profit: null, marginPct: null, itemsWithUnknownCost: itemRows.length };
    } else {
      const revenue = sumMoney(known.map((row) => row.standingSales));
      const cost = sumMoney(known.map((row) => row.cost));
      const profit = sumMoney([revenue, negateMoney(cost)]);
      profitSummary = { revenue, cost, profit, marginPct: marginPercent(profit, revenue), itemsWithUnknownCost: itemRows.length - known.length };
    }
  }

  // Discounts and comps given on these checks, from the amounts frozen on each settlement. Only present when there were
  // any, so a report without discounts keeps its old shape.
  const frozenDiscounts = allSettlements.length ? await db.table('settlement_discounts').whereIn('settlement_id', allSettlements.map((row) => row.id)) : [];
  const orderOfSettlement = new Map(allSettlements.map((row) => [String(row.id), String(row.pos_order_id)]));
  const discountByOrder = new Map();
  for (const row of frozenDiscounts) {
    const orderKey = orderOfSettlement.get(String(row.settlement_id));
    discountByOrder.set(orderKey, [...(discountByOrder.get(orderKey) ?? []), row.amount]);
  }

  const tenderRows = [...byTender.values()].map(({ tender, checks, amounts }) => ({ tender, checks, total: sumMoney(amounts) }));

  // Refunds processed in the range, only when there were any (a report without refunds keeps its old shape).
  let refunds = null;
  if (refundLines.length > 0) {
    const refundTenders = new Map();
    for (const line of refundLines) refundTenders.set(line.tender, [...(refundTenders.get(line.tender) ?? []), line.amount]);
    refunds = {
      count: refundLines.length,
      total: sumMoney(refundLines.map((line) => line.amount)),
      subtotal: sumMoney(refundLines.map((line) => line.subtotal)),
      tax: sumMoney(refundLines.map((line) => line.tax)),
      serviceCharge: sumMoney(refundLines.map((line) => line.serviceCharge)),
      tips: sumMoney(refundLines.map((line) => line.tips)),
      byTender: [...refundTenders.entries()].map(([tender, amounts]) => ({ tender, checks: amounts.length, total: sumMoney(amounts) })),
      lines: refundLines,
    };
  }
  const grossTotal = sumMoney(tenderRows.map((row) => row.total));

  return {
    dateFrom,
    dateTo,
    outletId: outletId ?? null,
    currency: property?.base_currency ?? null,
    summary: {
      tabs: tabs.size,
      checks: allSettlements.length,
      subtotal: sumMoney(allSettlements.map((row) => row.subtotal)),
      tax: sumMoney(allSettlements.map((row) => row.tax_amount)),
      serviceCharge: sumMoney(allSettlements.map((row) => row.service_charge)),
      tips: sumMoney(allSettlements.map((row) => row.tip_amount)),
      total: grossTotal,
      // Sales settled in the range minus refunds processed in it.
      ...(refunds ? { refunds: { count: refunds.count, total: refunds.total }, netTotal: sumMoney([grossTotal, refunds.total]) } : {}),
      ...(frozenDiscounts.length
        ? { discounts: { count: frozenDiscounts.length, total: sumMoney(frozenDiscounts.map((row) => row.amount)), comps: sumMoney(frozenDiscounts.filter((row) => row.kind === 'comp').map((row) => row.amount)) } }
        : {}),
      ...(withProfit ? { profit: profitSummary } : {}),
    },
    byTender: tenderRows,
    byOutlet: await buildOutletRows({ db, settlements: allSettlements, outletId, refundLines }),
    ...(refunds ? { refunds } : {}),
    topItems,
    tabs: [...tabs.values()].map(({ amounts, groups, itemCount, knownRevenue, costs, unknownCostLines, checks, refundedChecks, refundedGroups, ...tab }) => {
      const row = { ...tab, itemCount: itemCount ?? 0, total: sumMoney(amounts), ...(refundedChecks > 0 && refundedChecks === checks ? { refunded: true } : {}), ...(discountByOrder.has(String(tab.orderId)) ? { discountTotal: sumMoney(discountByOrder.get(String(tab.orderId))) } : {}) };
      if (withProfit) {
        // Profit on the items whose cost is known; `costComplete` says whether that was every item on the tab.
        // A tab with NO priced item has an unknown profit (null), not a false zero.
        const anyKnown = (costs ?? []).length > 0;
        const cost = anyKnown ? sumMoney(costs) : null;
        Object.assign(row, { cost, profit: anyKnown ? sumMoney([sumMoney(knownRevenue), negateMoney(cost)]) : null, costComplete: (unknownCostLines ?? 0) === 0 });
      }
      return row;
    }),
    unsettledCardPayments: await listUnsettledCardPayments({ db, outletId }),
  };
}

/**
 * Real per-menu-item quantity and revenue for every standing (non-voided)
 * item on a standing (non-voided) settlement in range — gap closure, for
 * `stock/reporting.js`'s cost-of-sales margin report (a cross-module
 * caller: `stock` already depends on `pos` the other way, via
 * `pos/service.js`'s own `stockService` import for recipe deduction, so
 * this direction is safe — no cycle results).
 *
 * Deliberately NOT a refactor of `computeSalesReport`'s own `topItems`
 * block above, even though the two compute the same underlying fact
 * ("what actually sold, excluding voided checks/items"): that block also
 * tracks each tab's own `itemCount` as a side effect of the same loop, and
 * disentangling the two safely was judged not worth risking a regression
 * in that already-shipped, tested report for. This function reuses
 * `listStandingSettlements` (avoiding that half of the duplication) and
 * returns EVERY item, never sliced to `TOP_ITEMS_LIMIT` — that slicing is
 * `computeSalesReport`'s own presentation choice, not a fact about what
 * sold.
 */
async function computeMenuItemSalesTotals({ db, dateFrom, dateTo, outletId }) {
  const settlements = await listStandingSettlements({ db, dateFrom, dateTo, outletId });
  const standingGroupsByOrder = new Map();
  const orderIds = [];
  for (const row of settlements) {
    const key = String(row.pos_order_id);
    if (!standingGroupsByOrder.has(key)) {
      standingGroupsByOrder.set(key, new Set());
      orderIds.push(row.pos_order_id);
    }
    standingGroupsByOrder.get(key).add(groupKey(row.split_group));
  }
  if (orderIds.length === 0) return [];

  const items = await db
    .table('pos_order_items')
    .joinScoped('pos_menu_items', (join) => join.on('pos_menu_items.id', '=', 'pos_order_items.menu_item_id'), { type: 'left' })
    .whereIn('pos_order_items.pos_order_id', orderIds)
    .whereNull('pos_order_items.voided_at')
    .select(
      'pos_order_items.id as id',
      'pos_order_items.pos_order_id as pos_order_id',
      'pos_order_items.menu_item_id as menu_item_id',
      'pos_order_items.split_group as split_group',
      'pos_order_items.quantity as quantity',
      'pos_order_items.unit_price as unit_price',
      'pos_order_items.modifiers as modifiers',
      'pos_menu_items.name as name'
    );

  // A discounted sale's revenue is its net, not the shelf price (nothing changes for a sale with no discount).
  await attachNetLineTotals({ db, settlements, items, orderIds, includeSupermarket: false });

  const itemTotals = new Map();
  for (const item of items) {
    const groups = standingGroupsByOrder.get(String(item.pos_order_id));
    if (!groups.has(groupKey(item.split_group))) continue; // that check's own split group was voided
    const key = String(item.menu_item_id);
    if (!itemTotals.has(key)) itemTotals.set(key, { menuItemId: item.menu_item_id, name: item.name ?? `#${item.menu_item_id}`, quantity: 0, amounts: [] });
    const entry = itemTotals.get(key);
    entry.quantity += item.quantity;
    entry.amounts.push(item.netLineTotal ?? computeItemLineTotal(item));
  }

  return [...itemTotals.values()].map(({ menuItemId, name, quantity, amounts }) => ({ menuItemId, name, quantity, revenue: sumMoney(amounts) }));
}

/**
 * Standing item lines WITH the settlement each one was settled under —
 * `[{settlementId, menuItemId, name, quantity}]`, one entry per order line.
 * The cost-price fallback in `stock/reporting.js` needs this because the
 * question "did this sale deplete stock?" is answered per settlement
 * (`stock_movements.pos_order_settlement_id`). Same exclusions as
 * `computeMenuItemSalesTotals` (voided settlements, voided lines, voided
 * split groups); kept as its own function rather than changing that one.
 */
async function listSettledItemLines({ db, dateFrom, dateTo, outletId }) {
  const settlements = await listStandingSettlements({ db, dateFrom, dateTo, outletId });
  const settlementByOrderGroup = new Map();
  const outletBySettlement = new Map();
  const orderIds = new Set();
  for (const row of settlements) {
    settlementByOrderGroup.set(`${row.pos_order_id}:${groupKey(row.split_group)}`, row.id);
    outletBySettlement.set(String(row.id), row.outlet_id ?? null);
    orderIds.add(row.pos_order_id);
  }
  if (orderIds.size === 0) return [];

  const items = await db
    .table('pos_order_items')
    .joinScoped('pos_menu_items', (join) => join.on('pos_menu_items.id', '=', 'pos_order_items.menu_item_id'), { type: 'left' })
    .whereIn('pos_order_items.pos_order_id', [...orderIds])
    .whereNull('pos_order_items.voided_at')
    .select(
      'pos_order_items.pos_order_id as pos_order_id',
      'pos_order_items.menu_item_id as menu_item_id',
      'pos_order_items.split_group as split_group',
      'pos_order_items.quantity as quantity',
      'pos_menu_items.name as name'
    );

  const lines = [];
  for (const item of items) {
    const settlementId = settlementByOrderGroup.get(`${item.pos_order_id}:${groupKey(item.split_group)}`);
    if (settlementId === undefined) continue; // that check's own split group was voided
    lines.push({ settlementId, outletId: outletBySettlement.get(String(settlementId)) ?? null, menuItemId: item.menu_item_id, name: item.name ?? `#${item.menu_item_id}`, quantity: item.quantity });
  }
  return lines;
}

/**
 * Real per-day POS revenue over a date range — gap closure, for
 * `expenses/reporting.js`'s composed profit view (a cross-module caller:
 * `expenses` depends on `pos`, the same one-way direction `stock` already
 * established for its own margin report; `pos` never depends back on
 * either). Sums each standing settlement's own `subtotal` (pre-tax,
 * pre-tip, pre-service — the real product-revenue figure, matching
 * `computeSalesReport`'s own `summary.subtotal`), bucketed by
 * `business_date`. Reuses `listStandingSettlements` — the voided-check and
 * split-group exclusion is already correct there, no duplication needed.
 *
 * Deliberately NOT read from `daily_reports.pos_revenue` — that column has
 * been permanently stuck at `0.00` since Phase 2.5 and was never wired up
 * even after POS shipped (a real, separately-flagged staleness); this
 * function always computes live, for every day in range, audited or not.
 */
async function computeDailyPosRevenueTotals({ db, dateFrom, dateTo, outletId }) {
  const settlements = await listStandingSettlements({ db, dateFrom, dateTo, outletId });
  const amountsByDate = new Map();
  for (const row of settlements) {
    const key = String(row.business_date);
    if (!amountsByDate.has(key)) amountsByDate.set(key, []);
    amountsByDate.get(key).push(row.subtotal);
  }
  return new Map([...amountsByDate.entries()].map(([date, amounts]) => [date, sumMoney(amounts)]));
}

/**
 * What each outlet earned over the range, before tax, service charge and tips: the SAME standing settlements and
 * the same `subtotal` as `computeDailyPosRevenueTotals`, grouped by outlet instead of by day, so the outlets add up
 * to the POS revenue figure to the kobo. A tab charged to a room counts for the outlet that sold it. An outlet id
 * of `null` (a settlement whose outlet cannot be resolved) is its own group.
 */
async function computeOutletRevenueTotals({ db, dateFrom, dateTo }) {
  const settlements = await listStandingSettlements({ db, dateFrom, dateTo });
  const amountsByOutlet = new Map();
  for (const row of settlements) {
    const key = row.outlet_id === null || row.outlet_id === undefined ? '' : String(row.outlet_id);
    if (!amountsByOutlet.has(key)) amountsByOutlet.set(key, []);
    amountsByOutlet.get(key).push(row.subtotal);
  }
  return new Map([...amountsByOutlet.entries()].map(([outlet, amounts]) => [outlet, sumMoney(amounts)]));
}

module.exports = {
  computeSalesReport,
  computeOutletRevenueTotals,
  computeMenuItemSalesTotals,
  listSettledItemLines,
  computeDailyPosRevenueTotals,
  TENDERS,
  // `listStandingSettlements`/`listUnsettledCardPayments` are exported for
  // `src/modules/reconciliation/service.js`'s own union of folio- and
  // POS-settled payments — the identical "promote a one-off once a second
  // caller needs it" pattern `postRoomChargesForStay`/`resolvePropertyBySlug`
  // already established in this codebase, rather than re-deriving the same
  // pos_order_settlements/pos_orders/pos_outlets/payments join a second time.
  listStandingSettlements,
  listUnsettledCardPayments,
  listRefundLines,
};
