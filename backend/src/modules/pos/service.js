'use strict';

/**
 * POS module service — PLAN.md Phase 4's POS core (PRODUCT_REQUIREMENTS.md
 * §3.4): outlets, terminals, menu, order flow, cash-up, charge-to-room. QR
 * self-ordering and inventory/stock control are explicitly deferred to
 * Phase 6 (see this module's own `index.js` header) — nothing here
 * anticipates either.
 *
 * ── MONEY: SNAPSHOT AT ADD-TIME, TAX AT SETTLE-TIME ──────────────────────
 *
 * `pos_order_items.unit_price`/`modifiers` are snapshotted from the menu
 * item the moment it's added to a tab — the same `reservation_daily_rates`
 * convention this codebase already uses, so a later menu price change
 * never alters an already-open tab. Tax is resolved at SETTLE time, not
 * add time, per ARCHITECTURE.md §12 ("calculated against the version
 * effective on the charge's business_date") — a tab can sit open across a
 * tax-rate change; what matters is the rate in effect when it's paid.
 *
 * ── SETTLEMENT REUSES CASHIERING'S TAX ENGINE AND `postCharge`, UNCHANGED ─
 *
 * A `room_charge` settlement calls `cashieringService.postCharge({type:
 * 'pos_charge', ...})` directly — that function already accepts
 * `'pos_charge'` (confirmed by reading it), computes tax via the exact
 * same `taxes`/`applies_to` mechanism, and posts both the charge and its
 * tax lines to the folio. Zero changes needed in Cashiering. A `cash`/
 * `card` settlement has no folio to post to, so this module calls the
 * same pure `resolveApplicableTaxVersions`/`computeChargeWithTax`
 * directly, storing the result on `pos_order_settlements` itself instead.
 *
 * ── CONCURRENCY: "POS tab edit" (ARCHITECTURE.md §5) ─────────────────────
 *
 * Every mutation against an open tab (add item, void item, void order,
 * settle) takes a `SELECT ... FOR UPDATE` row lock on the `pos_orders` row
 * first, inside one transaction — the row-lock option ARCHITECTURE.md
 * names for this exact race, the same mechanism already used for the
 * last-room race (`room_type_inventory`) rather than a new optimistic-
 * versioning scheme.
 *
 * ── SPLIT BILLING: ITEM-GROUP, SETTLED ATOMICALLY IN ONE CALL ────────────
 *
 * `pos_order_items.split_group` (nullable int, null = the default single
 * group) tags an item into one of a tab's split groups —
 * `assignItemSplitGroup` moves an item between groups before settlement.
 * `settleOrder` requires the caller to submit exactly one settlement per
 * DISTINCT group actually present among the order's unvoided items in one
 * call — this session's confirmed scope (item-group splits, no drag-and-
 * drop) implemented as "settle the whole tab in one action, however many
 * ways it's split," rather than incremental partial settlements that
 * would need their own separate over/under-settlement bookkeeping.
 */

const { scopedDb } = require('../../db');
const { ValidationError, withDuplicateMapping } = require('../../shared/errors');
const { sumMoney, negateMoney, compareMoney, toCents, fromCents } = require('../../shared/money');
const { resolveApplicableTaxVersions, computeChargeWithTax } = require('../cashiering/tax-engine');
const cashieringService = require('../cashiering/service');
const reservationsService = require('../reservations/service');
const {
  OrderNotOpenError,
  OrderItemAlreadyVoidedError,
  RoomChargeRejectedError,
  SettlementGroupsMismatchError,
  ShiftAlreadyOpenError,
  OutletNotFoundError,
  TerminalNotFoundError,
  MenuItemNotFoundError,
  OrderNotFoundError,
  ShiftAlreadyClosedError,
  SettlementAlreadyVoidedError,
} = require('./errors');

// ---------------------------------------------------------------------
// Outlets
// ---------------------------------------------------------------------

async function listOutlets({ context }) {
  const db = scopedDb().for(context);
  return db.table('pos_outlets').where({ status: 'active' }).orderBy('code');
}

async function getOutlet({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_outlets').where({ id }).first();
}

async function createOutlet({ context, code, name, type }) {
  const db = scopedDb().for(context);
  return withDuplicateMapping('pos_outlets', `An outlet with code "${code}" already exists at this property.`, async () => {
    const [id] = await db.table('pos_outlets').insert({ code, name, type });
    return getOutlet({ context, id });
  });
}

async function updateOutlet({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('pos_outlets').where({ id }).update(changes);
  return getOutlet({ context, id });
}

async function archiveOutlet({ context, id }) {
  return updateOutlet({ context, id, changes: { status: 'archived' } });
}

// ---------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------

async function listTerminals({ context, outletId }) {
  const db = scopedDb().for(context);
  const query = db.table('pos_terminals').where({ status: 'active' });
  return (outletId ? query.where({ outlet_id: outletId }) : query).orderBy('device_ref');
}

async function getTerminal({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_terminals').where({ id }).first();
}

async function createTerminal({ context, outletId, deviceRef, supportsContactless }) {
  const db = scopedDb().for(context);
  const outlet = await getOutlet({ context, id: outletId });
  if (!outlet) throw new OutletNotFoundError();
  return withDuplicateMapping('pos_terminals', `A terminal with device ref "${deviceRef}" already exists at this outlet.`, async () => {
    const [id] = await db.table('pos_terminals').insert({ outlet_id: outletId, device_ref: deviceRef, supports_contactless: !!supportsContactless });
    return getTerminal({ context, id });
  });
}

async function updateTerminal({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('pos_terminals').where({ id }).update(changes);
  return getTerminal({ context, id });
}

async function archiveTerminal({ context, id }) {
  return updateTerminal({ context, id, changes: { status: 'archived' } });
}

// ---------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------

async function listMenuItems({ context, outletId }) {
  const db = scopedDb().for(context);
  const query = db.table('pos_menu_items').where({ status: 'active' });
  return (outletId ? query.where({ outlet_id: outletId }) : query).orderBy('category').orderBy('name');
}

async function getMenuItem({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_menu_items').where({ id }).first();
}

async function createMenuItem({ context, outletId, name, category, price, modifiers, isAvailable }) {
  const db = scopedDb().for(context);
  const outlet = await getOutlet({ context, id: outletId });
  if (!outlet) throw new OutletNotFoundError();
  const [id] = await db.table('pos_menu_items').insert({
    outlet_id: outletId,
    name,
    category,
    price,
    modifiers: modifiers ?? null,
    is_available: isAvailable ?? true,
  });
  return getMenuItem({ context, id });
}

async function updateMenuItem({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('pos_menu_items').where({ id }).update(changes);
  return getMenuItem({ context, id });
}

/** The stock-out toggle (PRODUCT_REQUIREMENTS.md §3.4) — staff mark an item unavailable without an admin edit. Same `pos.operate` grant as running the register, not `pos.manage` — see routes.js. */
async function setMenuItemAvailability({ context, id, isAvailable }) {
  return updateMenuItem({ context, id, changes: { is_available: isAvailable } });
}

async function archiveMenuItem({ context, id }) {
  return updateMenuItem({ context, id, changes: { status: 'archived' } });
}

// ---------------------------------------------------------------------
// In-house guest lookup (charge-to-room) — thin pass-through to
// reservations/service.js, the module that actually owns this concept.
// ---------------------------------------------------------------------

async function findInHouseForCharge({ context, query }) {
  return reservationsService.findInHouseForCharge({ context, query });
}

// ---------------------------------------------------------------------
// Orders (tabs)
// ---------------------------------------------------------------------

async function listOrders({ context, outletId, status }) {
  const db = scopedDb().for(context);
  let query = db.table('pos_orders');
  if (outletId) query = query.where({ outlet_id: outletId });
  if (status) query = query.where({ status });
  return query.orderBy('opened_at', 'desc');
}

async function getOrder({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_orders').where({ id }).first();
}

async function listOrderItems({ context, orderId }) {
  const db = scopedDb().for(context);
  return db.table('pos_order_items').where({ pos_order_id: orderId }).orderBy('id');
}

async function listOrderSettlements({ context, orderId }) {
  const db = scopedDb().for(context);
  return db.table('pos_order_settlements').where({ pos_order_id: orderId }).orderBy('id');
}

async function openOrder({ context, outletId, terminalId, openedByUserId, tableLabel }) {
  const db = scopedDb().for(context);
  const outlet = await getOutlet({ context, id: outletId });
  if (!outlet) throw new OutletNotFoundError();
  // Matched in the WHERE clause, not fetched-then-compared in JS — a
  // BIGINT id can come back from MySQL as a string while the caller's own
  // value is a JS number (or vice versa); letting the database compare
  // its own column values avoids that type mismatch entirely.
  const terminal = await db.table('pos_terminals').where({ id: terminalId, outlet_id: outletId }).first();
  if (!terminal) throw new TerminalNotFoundError();

  const [id] = await db.table('pos_orders').insert({
    outlet_id: outletId,
    terminal_id: terminalId,
    opened_by_user_id: openedByUserId,
    table_label: tableLabel ?? null,
  });
  return getOrder({ context, id });
}

/** Every menu-item price/modifier lookup and item-add goes through this exact cents math — no floats, ever (ARCHITECTURE.md §1). */
function computeItemLineTotal({ unit_price: unitPrice, quantity, modifiers }) {
  const modifierDeltaCents = (modifiers ?? []).reduce((sum, m) => sum + toCents(m.priceDelta ?? '0.00'), 0n);
  const perUnitCents = toCents(unitPrice) + modifierDeltaCents;
  return fromCents(perUnitCents * BigInt(quantity));
}

async function addItem({ context, orderId, menuItemId, quantity, modifiers }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw new OrderNotFoundError();
    if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);

    // Matched in the WHERE clause, not fetched-then-compared in JS — see
    // `openOrder`'s own comment on why.
    const menuItem = await trx.table('pos_menu_items').where({ id: menuItemId, outlet_id: order.outlet_id }).first();
    if (!menuItem) throw new MenuItemNotFoundError();
    if (!menuItem.is_available) {
      throw new ValidationError('POS_ITEM_UNAVAILABLE', `"${menuItem.name}" is currently marked unavailable.`);
    }

    await trx.table('pos_order_items').insert({
      pos_order_id: orderId,
      menu_item_id: menuItemId,
      quantity: quantity ?? 1,
      unit_price: menuItem.price,
      modifiers: modifiers ?? null,
    });
    return { order, items: await trx.table('pos_order_items').where({ pos_order_id: orderId }).orderBy('id') };
  });
}

/**
 * Locks the item's PARENT ORDER first, then re-reads the item under that
 * lock, before checking any of its state — the same "lock, then check,
 * then write" ordering `settleOrder`/`voidOrder` already use. Checking
 * `voided_at` on an unlocked read (the first draft of this function did)
 * lets two concurrent void requests for the same item both pass the check
 * before either writes, silently overwriting the audit trail (the original
 * voider/reason) with the second caller's — exactly the "POS tab edit"
 * race this module's own header names, for an item this pass's own
 * comments call "the single most common vector for staff theft."
 */
async function lockOrderAndItem({ trx, orderItemId }) {
  const item = await trx.table('pos_order_items').where({ id: orderItemId }).first();
  if (!item) throw new ValidationError('ORDER_ITEM_NOT_FOUND', 'The specified order item does not exist.');

  const order = await trx.table('pos_orders').where({ id: item.pos_order_id }).forUpdate().first();
  if (order.status !== 'open') throw new OrderNotOpenError(order.id, order.status);

  // Re-read the item under its OWN lock, not a plain SELECT — MySQL's
  // REPEATABLE READ isolation gives a plain read the transaction's
  // consistent snapshot from its FIRST read above (taken before the order
  // lock was even requested), not the latest committed row, so a plain
  // re-read here would still see the pre-void state even after blocking on
  // the order's lock and a concurrent voider committing in between. Only a
  // locking read (`forUpdate`) bypasses the snapshot and returns what was
  // actually just committed — without this, two concurrent voids can both
  // pass this check, exactly the bug this function exists to close.
  const lockedItem = await trx.table('pos_order_items').where({ id: orderItemId }).forUpdate().first();
  if (lockedItem.voided_at) throw new OrderItemAlreadyVoidedError(orderItemId);
  return { order, item: lockedItem };
}

async function voidOrderItem({ context, orderItemId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void an order item.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    await lockOrderAndItem({ trx, orderItemId });
    await trx.table('pos_order_items').where({ id: orderItemId }).update({
      voided_at: new Date(),
      void_reason: reason,
      voided_by_user_id: userId,
    });
    return trx.table('pos_order_items').where({ id: orderItemId }).first();
  });
}

async function assignItemSplitGroup({ context, orderItemId, splitGroup }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    await lockOrderAndItem({ trx, orderItemId });
    await trx.table('pos_order_items').where({ id: orderItemId }).update({ split_group: splitGroup ?? null });
    return trx.table('pos_order_items').where({ id: orderItemId }).first();
  });
}

async function voidOrder({ context, orderId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void an order.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
    if (!order) throw new OrderNotFoundError();
    if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);

    await trx.table('pos_orders').where({ id: orderId }).update({
      status: 'void',
      closed_at: new Date(),
      voided_at: new Date(),
      void_reason: reason,
      voided_by_user_id: userId,
    });
    return trx.table('pos_orders').where({ id: orderId }).first();
  });
}

// ---------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------

function groupKey(splitGroup) {
  return splitGroup === null || splitGroup === undefined ? 'null' : String(splitGroup);
}

/**
 * `trx`-based — called from `runIdempotentMutation`'s handler (financial
 * mutation, ARCHITECTURE.md §7). Locks the order, verifies the requested
 * settlements exactly partition its unvoided items by split_group — every
 * group covered exactly once, none missing, none requested twice (a
 * duplicate group key would otherwise charge/settle the same items once
 * per settlement entry, since processing iterates the raw request array,
 * not a dedup'd set) — then processes each settlement: `room_charge`
 * re-verifies the in-house reservation and its open folio FRESH (never
 * trusts an earlier search result), posts through `cashieringService.postCharge`,
 * and posts any nonzero tip/service charge as a separate, untaxed
 * `postAdjustment` line on the same folio; `cash`/`card` compute tax
 * directly and record the settlement with no folio involved at all.
 */
async function settleOrder({ trx, orderId, settledByUserId, settlements }) {
  if (!Array.isArray(settlements) || settlements.length === 0) {
    throw new ValidationError('MISSING_FIELD', 'At least one settlement is required.', [{ field: 'settlements', issue: 'missing' }]);
  }

  const order = await trx.table('pos_orders').where({ id: orderId }).forUpdate().first();
  if (!order) throw new OrderNotFoundError();
  if (order.status !== 'open') throw new OrderNotOpenError(orderId, order.status);

  const items = await trx.table('pos_order_items').where({ pos_order_id: orderId }).whereNull('voided_at');
  const groupsPresent = new Set(items.map((item) => groupKey(item.split_group)));
  const requestedKeys = settlements.map((s) => groupKey(s.splitGroup));
  const groupsRequested = new Set(requestedKeys);

  // Each group must be requested EXACTLY once: a duplicate key here would
  // charge/settle the same items twice (once per settlement entry) since
  // the processing loop below iterates the raw array, not this dedup'd
  // set — a real double-billing bug an earlier draft of this function had.
  if (requestedKeys.length !== groupsRequested.size) {
    throw new SettlementGroupsMismatchError('duplicate', { present: [...groupsPresent], requested: requestedKeys });
  }
  const sameGroups = groupsPresent.size === groupsRequested.size && [...groupsPresent].every((g) => groupsRequested.has(g));
  if (!sameGroups) {
    throw new SettlementGroupsMismatchError('uncovered', { present: [...groupsPresent], requested: requestedKeys });
  }

  const property = await trx.table('properties').where({ id: order.property_id }).first('current_business_date', 'base_currency');
  const businessDate = property?.current_business_date;
  const allTaxRows = await trx.table('taxes');

  const results = [];
  for (const settlement of settlements) {
    if (settlement.method !== 'room_charge' && settlement.method !== 'cash' && settlement.method !== 'card') {
      throw new ValidationError('INVALID_SETTLEMENT_METHOD', `"${settlement.method}" is not a supported settlement method — use "cash", "card", or "room_charge".`);
    }

    const groupItems = items.filter((item) => groupKey(item.split_group) === groupKey(settlement.splitGroup));
    const baseAmount = sumMoney(groupItems.map(computeItemLineTotal));
    const tipAmount = settlement.tipAmount ?? '0.00';
    const serviceCharge = settlement.serviceCharge ?? '0.00';

    const fields = {
      pos_order_id: orderId,
      split_group: settlement.splitGroup ?? null,
      method: settlement.method,
      tip_amount: tipAmount,
      service_charge: serviceCharge,
      settled_by_user_id: settledByUserId,
    };

    if (settlement.method === 'room_charge') {
      const roomCharge = settlement.roomCharge ?? {};
      const reservation = await trx.table('reservations').where({ id: roomCharge.reservationId }).first();
      if (!reservation || reservation.status !== 'checked_in') {
        throw new RoomChargeRejectedError('the room has no in-house reservation.');
      }
      const folio = await trx.table('folios').where({ reservation_id: reservation.id, status: 'open' }).orderBy('id', 'asc').first();
      if (!folio) throw new RoomChargeRejectedError('the folio is closed or does not exist.');
      if (!roomCharge.authMethod || !roomCharge.authReference) {
        throw new ValidationError(
          'MISSING_FIELD',
          'Room-charge authorization (method + reference) is required — a room number alone is not identification.',
          [{ field: 'roomCharge', issue: 'missing_authorization' }]
        );
      }

      const { chargeLine, taxLines } = await cashieringService.postCharge({
        trx,
        folioId: folio.id,
        type: 'pos_charge',
        description: `POS charge — order ${orderId}`,
        amount: baseAmount,
        businessDate,
        userId: settledByUserId,
      });

      // Tip/service charge post as a SEPARATE, untaxed adjustment — folded
      // into the main charge's own taxed base would tax the tip, and this
      // codebase's tax engine has no mechanism to tax only part of one
      // charge. Skipped entirely when both are zero, so a plain sale posts
      // no empty adjustment line.
      let tipLineId = null;
      const tipTotal = sumMoney([tipAmount, serviceCharge]);
      if (compareMoney(tipTotal, '0.00') > 0) {
        const tipLine = await cashieringService.postAdjustment({
          trx,
          folioId: folio.id,
          description: `POS tip/service charge — order ${orderId}`,
          amount: tipTotal,
          relatedLineItemId: chargeLine.id,
          businessDate,
          userId: settledByUserId,
          reason: 'POS tip/service charge',
        });
        tipLineId = tipLine.id;
      }

      Object.assign(fields, {
        subtotal: chargeLine.amount,
        tax_amount: sumMoney(taxLines.map((t) => t.amount)),
        currency: chargeLine.currency,
        folio_id: folio.id,
        folio_line_item_id: chargeLine.id,
        tip_service_charge_line_item_id: tipLineId,
        room_charge_auth_method: roomCharge.authMethod,
        room_charge_auth_reference: roomCharge.authReference,
      });
    } else {
      const taxVersions = resolveApplicableTaxVersions({ allTaxRows, businessDate, chargeType: 'pos_charge' });
      const { netAmount, taxLines } = computeChargeWithTax({ baseAmount, taxVersions });
      Object.assign(fields, {
        subtotal: netAmount,
        tax_amount: sumMoney(taxLines.map((t) => t.amount)),
        currency: property?.base_currency,
      });
    }

    const [settlementId] = await trx.table('pos_order_settlements').insert(fields);
    results.push(await trx.table('pos_order_settlements').where({ id: settlementId }).first());
  }

  await trx.table('pos_orders').where({ id: orderId }).update({ status: 'settled', closed_at: new Date() });
  return { order: await trx.table('pos_orders').where({ id: orderId }).first(), settlements: results };
}

/** Post-settlement void — PRODUCT_REQUIREMENTS.md §3.4's "Manager overrides ... require a manager PIN," gated on `pos.manage` at the route layer rather than a separate PIN-re-entry mechanism this codebase has no other example of. Voids the settlement record and, for a room charge, the underlying folio line via the existing `voidLineItem`. */
async function voidSettlement({ trx, settlementId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to void a settlement.', [{ field: 'reason', issue: 'missing' }]);
  const settlement = await trx.table('pos_order_settlements').where({ id: settlementId }).first();
  if (!settlement) throw new ValidationError('SETTLEMENT_NOT_FOUND', 'The specified settlement does not exist.');

  // Lock the parent order, then re-check voided_at under that lock — the
  // same reasoning `lockOrderAndItem` gives for pre-settlement item voids,
  // applied here so two concurrent void-settlement calls (each with its
  // own idempotency key, so idempotency replay does not dedupe them) can't
  // both pass the check before either writes.
  await trx.table('pos_orders').where({ id: settlement.pos_order_id }).forUpdate().first();
  // A locking read, not a plain SELECT — see `lockOrderAndItem`'s own
  // comment for why a plain re-read here would still see the pre-void
  // REPEATABLE-READ snapshot even after a concurrent voider committed.
  const lockedSettlement = await trx.table('pos_order_settlements').where({ id: settlementId }).forUpdate().first();
  if (lockedSettlement.voided_at) throw new SettlementAlreadyVoidedError(settlementId);

  if (settlement.folio_line_item_id) {
    await cashieringService.voidLineItem({ trx, lineItemId: settlement.folio_line_item_id, reason, userId });
  }
  // The tip/service-charge adjustment (if any) is a separate folio line —
  // void it too, so a voided settlement never leaves an orphaned tip
  // charge behind on the guest's folio.
  if (settlement.tip_service_charge_line_item_id) {
    await cashieringService.voidLineItem({ trx, lineItemId: settlement.tip_service_charge_line_item_id, reason, userId });
  }

  await trx.table('pos_order_settlements').where({ id: settlementId }).update({
    voided_at: new Date(),
    void_reason: reason,
    voided_by_user_id: userId,
  });
  return trx.table('pos_order_settlements').where({ id: settlementId }).first();
}

// ---------------------------------------------------------------------
// Shifts — blind cash-up
// ---------------------------------------------------------------------

async function listShifts({ context, terminalId }) {
  const db = scopedDb().for(context);
  const query = db.table('pos_shifts');
  return (terminalId ? query.where({ terminal_id: terminalId }) : query).orderBy('opened_at', 'desc');
}

async function getShift({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('pos_shifts').where({ id }).first();
}

/** No idempotency key required — retrying a rejected open is naturally safe (the gap-lock guard below either accepts a genuinely-new shift or rejects a duplicate), and opening carries no money yet. */
async function openShift({ context, terminalId, userId, openingFloat }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    // Gap lock: MySQL's unique-index semantics treat every NULL as distinct,
    // so no DB constraint alone can enforce "at most one open shift per
    // terminal" — see the migration's own header for the full reasoning.
    const existingOpen = await trx.table('pos_shifts').where({ terminal_id: terminalId }).whereNull('closed_at').forUpdate().first();
    if (existingOpen) throw new ShiftAlreadyOpenError(terminalId);

    const property = await trx.table('properties').where({ id: context.propertyId }).first('base_currency');
    const [id] = await trx.table('pos_shifts').insert({ terminal_id: terminalId, user_id: userId, opening_float: openingFloat, currency: property.base_currency });
    return trx.table('pos_shifts').where({ id }).first();
  });
}

/**
 * `trx`-based, called from `runIdempotentMutation` — closing a shift
 * records a fact (the counted cash) that must not double-process on a
 * retried request. `countedCash` is the caller's INPUT; `expected_cash`/
 * `variance` are computed here and returned in the SAME response — no
 * earlier read of an open shift ever exposes what the system expects
 * (PRODUCT_REQUIREMENTS.md §3.19's "blind cash-up," structural, not a UI
 * convention — see migration header).
 */
async function closeShift({ trx, shiftId, countedCash }) {
  const shift = await trx.table('pos_shifts').where({ id: shiftId }).forUpdate().first();
  if (!shift) throw new ValidationError('SHIFT_NOT_FOUND', 'The specified shift does not exist.');
  if (shift.closed_at) throw new ShiftAlreadyClosedError(shiftId);

  const cashSettlements = await trx
    .table('pos_order_settlements')
    .joinScoped('pos_orders', (join) => join.on('pos_orders.id', '=', 'pos_order_settlements.pos_order_id'))
    .where('pos_orders.terminal_id', shift.terminal_id)
    .where('pos_order_settlements.method', 'cash')
    .whereNull('pos_order_settlements.voided_at')
    .where('pos_order_settlements.settled_at', '>=', shift.opened_at)
    .select('pos_order_settlements.subtotal', 'pos_order_settlements.tax_amount', 'pos_order_settlements.tip_amount', 'pos_order_settlements.service_charge');

  const cashTaken = sumMoney(
    cashSettlements.map((s) => sumMoney([s.subtotal, s.tax_amount, s.tip_amount, s.service_charge]))
  );
  const expectedCash = sumMoney([shift.opening_float, cashTaken]);
  const variance = sumMoney([countedCash, negateMoney(expectedCash)]);

  await trx.table('pos_shifts').where({ id: shiftId }).update({
    counted_cash: countedCash,
    expected_cash: expectedCash,
    variance,
    closed_at: new Date(),
  });
  return trx.table('pos_shifts').where({ id: shiftId }).first();
}

module.exports = {
  listOutlets,
  getOutlet,
  createOutlet,
  updateOutlet,
  archiveOutlet,
  listTerminals,
  getTerminal,
  createTerminal,
  updateTerminal,
  archiveTerminal,
  listMenuItems,
  getMenuItem,
  createMenuItem,
  updateMenuItem,
  setMenuItemAvailability,
  archiveMenuItem,
  findInHouseForCharge,
  listOrders,
  getOrder,
  listOrderItems,
  listOrderSettlements,
  openOrder,
  addItem,
  voidOrderItem,
  assignItemSplitGroup,
  voidOrder,
  computeItemLineTotal,
  settleOrder,
  voidSettlement,
  listShifts,
  getShift,
  openShift,
  closeShift,
};
