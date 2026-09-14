'use strict';

/**
 * POS Sales report — what the Register actually took over a business-date
 * range: totals per tender, top-selling items, and every settled tab.
 * `pos.manage` only (a reconciliation report, not a till action — see
 * `routes.js`).
 *
 * Filters on `pos_order_settlements.business_date` (ARCHITECTURE.md §6),
 * never the wall clock. Voided settlements are excluded everywhere: a
 * voided check was reversed and took no money. On a split tab, only the
 * items of checks that still stand count toward top sellers.
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
const { sumMoney, compareMoney } = require('../../shared/money');
const { computeItemLineTotal } = require('../../shared/pos-pricing');

const TENDERS = ['cash', 'card', 'nqr', 'room_charge'];
const TOP_ITEMS_LIMIT = 20;

function groupKey(splitGroup) {
  return splitGroup === null || splitGroup === undefined ? 'null' : String(splitGroup);
}

function cashierName(row) {
  const name = [row.cashier_first_name, row.cashier_last_name].filter(Boolean).join(' ');
  return name || null;
}

async function listStandingSettlements({ db, dateFrom, dateTo, outletId }) {
  let query = db
    .table('pos_order_settlements')
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'pos_order_settlements.pos_order_id'))
    .joinScoped('users', (join) => join.on('users.id', '=', 'pos_order_settlements.settled_by_user_id'), { type: 'left' })
    .joinScoped('payments', (join) => join.on('payments.id', '=', 'pos_order_settlements.payment_id'), { type: 'left' })
    .whereNull('pos_order_settlements.voided_at')
    .whereBetween('pos_order_settlements.business_date', [dateFrom, dateTo]);
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  return query
    .select(
      'pos_order_settlements.id as id',
      'pos_order_settlements.pos_order_id as pos_order_id',
      'pos_order_settlements.split_group as split_group',
      'pos_order_settlements.method as method',
      'pos_order_settlements.tender as tender',
      'pos_order_settlements.subtotal as subtotal',
      'pos_order_settlements.tax_amount as tax_amount',
      'pos_order_settlements.tip_amount as tip_amount',
      'pos_order_settlements.service_charge as service_charge',
      'pos_order_settlements.settled_at as settled_at',
      'pos_order_settlements.business_date as business_date',
      'pos_order_settlements.folio_id as folio_id',
      'payments.provider_channel as provider_channel',
      'pos_orders.table_label as table_label',
      'pos_orders.source as source',
      'pos_orders.outlet_id as outlet_id',
      'users.first_name as cashier_first_name',
      'users.last_name as cashier_last_name'
    )
    .orderBy('pos_order_settlements.settled_at', 'desc');
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
    .where({ 'payments.status': 'CAPTURED' });
  if (outletId) query = query.where('pos_orders.outlet_id', outletId);
  const payments = await query
    .select(
      'payments.id as id',
      'payments.pos_order_id as pos_order_id',
      'payments.tender as tender',
      'payments.amount as amount',
      'payments.currency as currency',
      'payments.captured_at as captured_at',
      'pos_orders.table_label as table_label',
      'pos_orders.status as order_status'
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
      tender: p.tender,
      amount: p.amount,
      currency: p.currency,
      capturedAt: p.captured_at,
    }));
}

async function computeSalesReport({ context, dateFrom, dateTo, outletId }) {
  const db = scopedDb().for(context);
  const property = await db.table('properties').where({ id: context.propertyId }).first('base_currency');
  const settlements = await listStandingSettlements({ db, dateFrom, dateTo, outletId });
  const roomTargets = await roomChargeTargets({ db, settlements });

  const byTender = new Map(TENDERS.map((tender) => [tender, { tender, checks: 0, amounts: [] }]));
  const tabs = new Map();
  for (const row of settlements) {
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
      });
    }
    const tab = tabs.get(key);
    if (!tab.tenders.includes(tender)) tab.tenders.push(tender);
    // One entry per check: how it was paid, the Paystack channel the guest
    // actually used (a Card checkout can be paid by USSD or transfer), and,
    // for a room charge, which room and guest it was billed to.
    const target = row.folio_id ? roomTargets.get(String(row.folio_id)) : null;
    tab.payments.push({
      tender,
      channel: row.provider_channel ?? null,
      roomNumber: target?.roomNumber ?? null,
      guestName: target?.guestName ?? null,
      total,
    });
    tab.amounts.push(total);
    tab.groups.add(groupKey(row.split_group));
  }

  const items = tabs.size === 0
    ? []
    : await db
      .table('pos_order_items')
      .joinScoped('pos_menu_items', (join) => join.on('pos_menu_items.id', '=', 'pos_order_items.menu_item_id'), { type: 'left' })
      .whereIn('pos_order_items.pos_order_id', [...tabs.values()].map((tab) => tab.orderId))
      .whereNull('pos_order_items.voided_at')
      .select(
        'pos_order_items.pos_order_id as pos_order_id',
        'pos_order_items.menu_item_id as menu_item_id',
        'pos_order_items.split_group as split_group',
        'pos_order_items.quantity as quantity',
        'pos_order_items.unit_price as unit_price',
        'pos_order_items.modifiers as modifiers',
        'pos_menu_items.name as name'
      );

  const itemTotals = new Map();
  for (const item of items) {
    const tab = tabs.get(String(item.pos_order_id));
    if (!tab.groups.has(groupKey(item.split_group))) continue; // that check was voided
    tab.itemCount = (tab.itemCount ?? 0) + item.quantity;
    const key = String(item.menu_item_id);
    if (!itemTotals.has(key)) itemTotals.set(key, { menuItemId: item.menu_item_id, name: item.name ?? `#${item.menu_item_id}`, quantity: 0, amounts: [] });
    const entry = itemTotals.get(key);
    entry.quantity += item.quantity;
    entry.amounts.push(computeItemLineTotal(item));
  }

  const topItems = [...itemTotals.values()]
    .map(({ menuItemId, name, quantity, amounts }) => ({ menuItemId, name, quantity, sales: sumMoney(amounts) }))
    .sort((a, b) => b.quantity - a.quantity || compareMoney(b.sales, a.sales) || a.name.localeCompare(b.name))
    .slice(0, TOP_ITEMS_LIMIT);

  const tenderRows = [...byTender.values()].map(({ tender, checks, amounts }) => ({ tender, checks, total: sumMoney(amounts) }));

  return {
    dateFrom,
    dateTo,
    outletId: outletId ?? null,
    currency: property?.base_currency ?? null,
    summary: {
      tabs: tabs.size,
      checks: settlements.length,
      subtotal: sumMoney(settlements.map((row) => row.subtotal)),
      tax: sumMoney(settlements.map((row) => row.tax_amount)),
      serviceCharge: sumMoney(settlements.map((row) => row.service_charge)),
      tips: sumMoney(settlements.map((row) => row.tip_amount)),
      total: sumMoney(tenderRows.map((row) => row.total)),
    },
    byTender: tenderRows,
    topItems,
    tabs: [...tabs.values()].map(({ amounts, groups, itemCount, ...tab }) => ({ ...tab, itemCount: itemCount ?? 0, total: sumMoney(amounts) })),
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
      'pos_order_items.pos_order_id as pos_order_id',
      'pos_order_items.menu_item_id as menu_item_id',
      'pos_order_items.split_group as split_group',
      'pos_order_items.quantity as quantity',
      'pos_order_items.unit_price as unit_price',
      'pos_order_items.modifiers as modifiers',
      'pos_menu_items.name as name'
    );

  const itemTotals = new Map();
  for (const item of items) {
    const groups = standingGroupsByOrder.get(String(item.pos_order_id));
    if (!groups.has(groupKey(item.split_group))) continue; // that check's own split group was voided
    const key = String(item.menu_item_id);
    if (!itemTotals.has(key)) itemTotals.set(key, { menuItemId: item.menu_item_id, name: item.name ?? `#${item.menu_item_id}`, quantity: 0, amounts: [] });
    const entry = itemTotals.get(key);
    entry.quantity += item.quantity;
    entry.amounts.push(computeItemLineTotal(item));
  }

  return [...itemTotals.values()].map(({ menuItemId, name, quantity, amounts }) => ({ menuItemId, name, quantity, revenue: sumMoney(amounts) }));
}

module.exports = { computeSalesReport, computeMenuItemSalesTotals, TENDERS };
