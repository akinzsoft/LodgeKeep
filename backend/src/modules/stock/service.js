'use strict';

/**
 * Stock module service — PLAN.md Phase 6's "POS inventory & stock
 * control" (PRODUCT_REQUIREMENTS.md §3.4). See this module's own
 * `index.js` for the full scope summary and confirmed deliberate gaps.
 *
 * ── NEGATIVE STOCK IS ALLOWED, NEVER BLOCKED ──────────────────────────────
 *
 * This session's confirmed decision: settlement/deduction (`deductStockForSettlement`)
 * ALWAYS completes, even if it takes a component negative (a genuine race,
 * or ordinary bookkeeping drift, is a real possibility this module does
 * not paper over by refusing a sale already in flight). The oversell guard
 * is proactive only — `applyStockAvailabilityEffects` flips a dependent
 * menu item's `is_available` to `false` the moment any of its recipe
 * components hits ≤ 0, preventing NEW orders; it never blocks or reverses
 * one already settling.
 *
 * ── ONE SHARED LOCK-ORDERING HELPER, USED BY EVERY MUTATING FUNCTION ─────
 *
 * `lockStockItemsSorted` is the ONE place this module locks a
 * `stock_items` row — always sorted ascending by id, always before any
 * other read or write in the calling function, mirroring `ar/service.js`'s
 * own `applyPaymentApplications` fix exactly ("lock every target row
 * first, sorted ascending by id, BEFORE any other read or write" — the
 * documented fix for a real two-connection MySQL deadlock that function's
 * own header explains).
 *
 * ── THE LOCK SET MUST BE THE FULL CLOSURE, COMPUTED BEFORE ANY LOCK ──────
 *
 * A real two-connection MySQL deadlock was found and fixed by this pass's
 * own CONC-STOCK-6 test, not shipped: every mutating function below first
 * locked only the stock item(s) it directly touches, and ONLY LATER, inside
 * `applyStockAvailabilityEffects`, expanded that lock to also cover every
 * SIBLING stock item in the same menu item's recipe. That two-phase shape
 * defeats the "always sorted ascending" guarantee, because the FIRST,
 * narrower lock two concurrent transactions each take can already differ:
 * a `receiveA` call locks {A} first, a concurrent `receiveB` call locks
 * {B} first — neither is a subset of the other, so by the time each
 * reaches its own later, correctly-sorted {A, B} expansion, `receiveA`
 * already holds A and blocks waiting for B, while `receiveB` already holds
 * B and blocks waiting for A. A genuine deadlock, not merely a slow
 * serialization, because the two transactions' FIRST locks were never
 * drawn from one shared, pre-computed closure.
 *
 * The fix: `resolveLockClosure` computes the FULL set — every id the
 * caller names, plus every sibling stock item that shares a menu item's
 * recipe with any of them — BEFORE any row is locked at all, and every
 * mutating function locks that whole closure, sorted ascending, in ONE
 * `lockStockItemsSorted` call, as its very first database operation. There
 * is no longer a narrower "just what I'm touching" lock that precedes it —
 * two transactions touching overlapping recipes now always converge on
 * locking the identical closure, in the identical ascending order,
 * regardless of which item either one happens to touch directly.
 * `applyStockAvailabilityEffects` still recomputes and re-locks that same
 * closure internally (needed so it can also decide availability from the
 * post-mutation values) — by the time it runs, every row it asks for is
 * already held by this same transaction, so that second `forUpdate()` is a
 * free, instant re-acquisition, never a new wait.
 *
 * `applyStockAvailabilityEffects` locks the AFFECTED `pos_menu_items` rows
 * too, FOR UPDATE, sorted ascending by id, AFTER every stock_items lock in
 * the same call chain — the same global ordering discipline, one level up
 * the dependency graph (stock items always lock before the menu items that
 * depend on them).
 *
 * ── QUANTITY, NEVER MONEY, DRIVES `current_quantity` ─────────────────────
 *
 * `stock_items.current_quantity` is never trusted as an independently
 * updated running total — every mutation recomputes it from scratch as
 * `sumQuantity` of every `stock_movements` row for that item
 * (`recomputeStockItemQuantity`), then writes the result back. The
 * identical "one source of truth, always re-derived" discipline
 * `recomputeFolioBalance`/`recomputeArAccountBalance` already establish,
 * applied to a quantity ledger instead of a money one.
 *
 * ── UNIT-SAME, LAST-COST, NO MODIFIER-CONDITIONAL RECIPE ─────────────────
 *
 * Three more confirmed, deliberate scope reductions, all documented at
 * their own point in the schema rather than repeated here: `stock_items.unit`
 * has no conversion table (`stock_items` migration header); `purchase_cost`
 * is wholesale-replaced by the most recent delivery, never a weighted
 * average (same migration); a recipe's quantity is fixed regardless of
 * which modifier option an order line chose (`pos_menu_item_components`
 * migration header).
 *
 * ── ONE-WAY DEPENDENCY ────────────────────────────────────────────────────
 *
 * This module NEVER requires `pos/service.js`, `cashiering/service.js`, or
 * `qr-ordering/service.js` — it reads/writes `pos_menu_items`/`pos_orders`/
 * `pos_order_settlements`/`pos_menu_item_components` directly via the
 * scoped table accessor. Those three modules require THIS one (for the
 * settlement-side deduction/reversal hooks), never the reverse — the same
 * one-way-dependency discipline `qr-ordering/service.js`'s own header
 * already establishes for its relationship with `cashiering/service.js`.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { sumQuantity, negateQuantity, multiplyQuantityByInteger, compareQuantity, extendedCost } = require('../../shared/quantity');
const {
  StockItemNotFoundError,
  OutletNotFoundError,
  MenuItemNotFoundError,
  OutletMismatchError,
  MissingWastageReasonError,
  StockTakeNotFoundError,
  StockTakeNotOpenError,
  StockTakeAlreadyCompletedError,
  StockTakeAlreadyCancelledError,
} = require('./errors');

const ZERO_QTY = '0.000';

// ---------------------------------------------------------------------
// The shared lock-ordering helper
// ---------------------------------------------------------------------

/**
 * Locks every named `stock_items` row FOR UPDATE, sorted ascending by id,
 * BEFORE any other read or write — the one mechanism every mutating
 * function in this module calls, so two transactions touching overlapping
 * stock items in different orders can never deadlock (see file header).
 * Throws `StockItemNotFoundError` for any id that doesn't resolve within
 * this context's own scope (cross-tenant/cross-property ids never lock
 * silently).
 *
 * @returns {Promise<Map<string, object>>} locked rows keyed by `String(id)`.
 */
async function lockStockItemsSorted({ trx, stockItemIds }) {
  const uniqueSortedIds = [...new Set(stockItemIds.map((id) => Number(id)))].sort((a, b) => a - b);
  const locked = new Map();
  for (const id of uniqueSortedIds) {
    const row = await trx.table('stock_items').where({ id }).forUpdate().first();
    if (!row) throw new StockItemNotFoundError();
    locked.set(String(id), row);
  }
  return locked;
}

/**
 * A pure, non-locking lookup: the full closure of stock item ids that must
 * be locked TOGETHER for a mutation touching `stockItemIds` to be
 * deadlock-free against a concurrent mutation touching a sibling component
 * of the same menu item(s) — see file header ("the lock set must be the
 * full closure, computed before any lock"). Every mutating function below
 * calls this FIRST, before taking any `stock_items` lock at all, then
 * locks the returned closure in one `lockStockItemsSorted` call.
 */
async function resolveLockClosure({ trx, stockItemIds }) {
  const uniqueIds = [...new Set(stockItemIds.map((id) => Number(id)))];
  if (uniqueIds.length === 0) return uniqueIds;

  const componentRows = await trx.table('pos_menu_item_components').whereIn('stock_item_id', uniqueIds).select('menu_item_id');
  const menuItemIds = [...new Set(componentRows.map((row) => Number(row.menu_item_id)))];
  if (menuItemIds.length === 0) return uniqueIds;

  const allComponentRows = await trx.table('pos_menu_item_components').whereIn('menu_item_id', menuItemIds).select('stock_item_id');
  return [...new Set([...uniqueIds, ...allComponentRows.map((row) => Number(row.stock_item_id))])];
}

/**
 * The one writer of `stock_items.current_quantity` — always re-derived,
 * never incremented in place. See file header.
 *
 * A real two-connection concurrency bug, found and fixed by this pass's
 * own CONC-STOCK-1/CONC-STOCK-4 tests, not shipped: the read below MUST
 * be a LOCKING read (`.forUpdate()`), not a plain `SELECT` — the exact
 * bug class `ar/service.js`'s `applyPaymentApplications` header already
 * documents fixing once for `existingForPayment`/`existingForInvoice`.
 * By the time this function runs, the CALLER has already taken a
 * `SELECT ... FOR UPDATE` lock on this item's `stock_items` row
 * (`lockStockItemsSorted`) — but this transaction's own REPEATABLE READ
 * snapshot was already established much earlier (the very first plain
 * read anywhere in the surrounding transaction, e.g. `settleOrder`'s own
 * `pos_order_items` read), long before that lock was even acquired. A
 * plain `SELECT` here would silently reuse that STALE snapshot — missing
 * a concurrent transaction's own already-committed movement even though
 * the row lock genuinely serialized the two transactions in real time —
 * and overwrite `current_quantity` with a sum that drops the other
 * transaction's contribution entirely. `.forUpdate()` bypasses the
 * snapshot and reads what was actually just committed.
 */
async function recomputeStockItemQuantity({ trx, stockItemId }) {
  const movements = await trx.table('stock_movements').where({ stock_item_id: stockItemId }).forUpdate().select('quantity');
  const currentQuantity = sumQuantity(movements.map((row) => row.quantity));
  await trx.table('stock_items').where({ id: stockItemId }).update({ current_quantity: currentQuantity });
  return currentQuantity;
}

/**
 * The proactive oversell guard — see file header. Locks every menu item
 * that depends on any of `stockItemIds` (sorted ascending, AFTER every
 * stock_items lock already taken by the caller), then re-reads ALL of
 * that menu item's own recipe components' current quantities (not just
 * the ones that just changed — every component must be above zero for
 * the item to stay sellable) before deciding whether to flip
 * `is_available`.
 *
 * Never touches a manually-disabled item (`stock_auto_unavailable: false`)
 * in either direction — an explicit staff action always wins over this
 * automatic mechanism's own bookkeeping.
 */
async function applyStockAvailabilityEffects({ trx, stockItemIds }) {
  const uniqueIds = [...new Set(stockItemIds.map((id) => Number(id)))];
  if (uniqueIds.length === 0) return;

  const componentRows = await trx.table('pos_menu_item_components').whereIn('stock_item_id', uniqueIds).select('menu_item_id');
  const menuItemIds = [...new Set(componentRows.map((row) => Number(row.menu_item_id)))].sort((a, b) => a - b);
  if (menuItemIds.length === 0) return;

  // Every recipe component of every AFFECTED menu item — not just the ones
  // in `stockItemIds` — must be locked before deciding availability, since
  // a menu item needs ALL of its components above zero to stay sellable.
  // A component this call didn't itself touch (a sibling changed by a
  // *different*, concurrent transaction) still needs locking here, sorted
  // into the SAME ascending global order as every other stock_items lock
  // in this module (see file header) — and, critically, locked BEFORE any
  // pos_menu_items row below, never after. Locking a sibling only once a
  // pos_menu_items row is already held (the bug this replaces) inverts
  // that global order for exactly this call path: a concurrent transaction
  // that legitimately locks that same sibling stock item FIRST (via its
  // own lockStockItemsSorted) and only reaches this same pos_menu_items
  // row afterward would then deadlock against this one — each holding
  // what the other waits for. Locking every needed stock_items row up
  // front, before any pos_menu_items row, avoids that cycle entirely.
  const allComponentRows = await trx.table('pos_menu_item_components').whereIn('menu_item_id', menuItemIds).select('stock_item_id');
  const allStockItemIds = [...new Set([...uniqueIds, ...allComponentRows.map((row) => Number(row.stock_item_id))])];
  await lockStockItemsSorted({ trx, stockItemIds: allStockItemIds });

  for (const menuItemId of menuItemIds) {
    const menuItem = await trx.table('pos_menu_items').where({ id: menuItemId }).forUpdate().first();
    if (!menuItem) continue;

    const components = await trx.table('pos_menu_item_components').where({ menu_item_id: menuItemId }).select('stock_item_id');
    const componentStockItemIds = components.map((row) => row.stock_item_id);
    // Every id here was already locked, in the correct global order,
    // above — re-asserting `.forUpdate()` is a no-op wait (this
    // transaction already holds the lock) but still bypasses the
    // transaction's own REPEATABLE READ snapshot, the same reason
    // `recomputeStockItemQuantity`'s own header documents needing it: a
    // plain SELECT here could still return data from a snapshot
    // established earlier in this same transaction, predating whichever
    // concurrent transaction's committed change this lock just serialized
    // against.
    const stockRows = componentStockItemIds.length
      ? await trx.table('stock_items').whereIn('id', componentStockItemIds).forUpdate().select('current_quantity')
      : [];
    const anyDepleted = stockRows.some((row) => compareQuantity(row.current_quantity, ZERO_QTY) <= 0);

    if (anyDepleted && menuItem.is_available) {
      await trx.table('pos_menu_items').where({ id: menuItemId }).update({ is_available: false, stock_auto_unavailable: true });
    } else if (!anyDepleted && !menuItem.is_available && menuItem.stock_auto_unavailable) {
      await trx.table('pos_menu_items').where({ id: menuItemId }).update({ is_available: true, stock_auto_unavailable: false });
    }
  }
}

// ---------------------------------------------------------------------
// Settlement hooks — called from pos/service.js and cashiering/service.js
// ---------------------------------------------------------------------

/**
 * The real settlement-side deduction — called from BOTH real settlement
 * writers this codebase has (`pos/service.js`'s `settleOrder`, once per
 * settlement covering `items`; `cashiering/service.js`'s
 * `finalizePosOrderCardCapture`, covering the whole order's unvoided
 * items in one call). `items` is the caller's own already-fetched,
 * unvoided `pos_order_items` rows for whatever this ONE settlement
 * covers — a menu item with no recipe at all costs nothing beyond one
 * cheap lookup (empty `pos_menu_item_components` result, immediate
 * return).
 */
async function deductStockForSettlement({ trx, orderId, settlementId, items, businessDate, userId }) {
  if (!items || items.length === 0) return;

  const orderedQtyByMenuItem = new Map();
  for (const item of items) {
    const menuItemId = Number(item.menu_item_id);
    const existing = orderedQtyByMenuItem.get(menuItemId) ?? 0;
    orderedQtyByMenuItem.set(menuItemId, existing + Number(item.quantity));
  }
  const menuItemIds = [...orderedQtyByMenuItem.keys()];
  if (menuItemIds.length === 0) return;

  const components = await trx.table('pos_menu_item_components').whereIn('menu_item_id', menuItemIds).select('menu_item_id', 'stock_item_id', 'quantity');
  if (components.length === 0) return; // No recipe anywhere in this settlement — zero further overhead.

  const deductionByStockItem = new Map();
  for (const component of components) {
    const orderedQty = orderedQtyByMenuItem.get(Number(component.menu_item_id)) ?? 0;
    const deduction = multiplyQuantityByInteger(component.quantity, orderedQty);
    const key = Number(component.stock_item_id);
    deductionByStockItem.set(key, sumQuantity([deductionByStockItem.get(key) ?? ZERO_QTY, deduction]));
  }

  const stockItemIds = [...deductionByStockItem.keys()];
  const lockClosure = await resolveLockClosure({ trx, stockItemIds });
  const lockedById = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });

  for (const stockItemId of stockItemIds) {
    const stockItem = lockedById.get(String(stockItemId));
    const deduction = deductionByStockItem.get(stockItemId);
    const movementQuantity = negateQuantity(deduction); // Always deducts — never blocked by an insufficient balance, see file header.
    const totalCost = extendedCost(stockItem.purchase_cost, movementQuantity);

    await trx.table('stock_movements').insert({
      outlet_id: stockItem.outlet_id,
      stock_item_id: stockItemId,
      type: 'sold',
      quantity: movementQuantity,
      unit_cost: stockItem.purchase_cost,
      total_cost: totalCost,
      business_date: businessDate,
      pos_order_id: orderId,
      pos_order_settlement_id: settlementId,
      user_id: userId ?? null,
    });
    await recomputeStockItemQuantity({ trx, stockItemId });
  }

  await applyStockAvailabilityEffects({ trx, stockItemIds });
}

/**
 * The direct counterpart of `deductStockForSettlement`, called from
 * `pos/service.js`'s `voidSettlement` (a post-settlement, manager-gated
 * void). Finds every `sold` movement this settlement originally posted,
 * reverses each one with its OWN original cost basis and OWN original
 * `business_date` (restating the period the original sale affected, never
 * today's — the same "a correction is a new offsetting row, not an edit"
 * discipline ARCHITECTURE.md §8 already requires for money).
 */
async function reverseStockForSettlement({ trx, settlementId, userId }) {
  const originalMovements = await trx.table('stock_movements').where({ pos_order_settlement_id: settlementId, type: 'sold' }).select();
  if (originalMovements.length === 0) return;

  const stockItemIds = [...new Set(originalMovements.map((row) => Number(row.stock_item_id)))];
  const lockClosure = await resolveLockClosure({ trx, stockItemIds });
  const lockedById = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });

  for (const movement of originalMovements) {
    const stockItemId = Number(movement.stock_item_id);
    const stockItem = lockedById.get(String(stockItemId));
    const reverseQuantity = negateQuantity(movement.quantity); // The original was negative; the reversal restores it.
    const totalCost = extendedCost(movement.unit_cost, reverseQuantity);

    await trx.table('stock_movements').insert({
      outlet_id: stockItem.outlet_id,
      stock_item_id: stockItemId,
      type: 'sale_reversal',
      quantity: reverseQuantity,
      unit_cost: movement.unit_cost, // Preserve the ORIGINAL cost basis, not today's purchase_cost.
      total_cost: totalCost,
      business_date: movement.business_date, // Restates the period the original sale affected — never today's.
      pos_order_id: movement.pos_order_id,
      pos_order_settlement_id: movement.pos_order_settlement_id,
      reversed_movement_id: movement.id,
      user_id: userId ?? null,
    });
    await recomputeStockItemQuantity({ trx, stockItemId });
  }

  // Reversal only ever increases quantity, so only the re-enable branch
  // of applyStockAvailabilityEffects can fire here — still routed through
  // the same shared function rather than a bespoke re-enable-only path.
  await applyStockAvailabilityEffects({ trx, stockItemIds });
}

// ---------------------------------------------------------------------
// Stock items — CRUD
// ---------------------------------------------------------------------

async function listStockItems({ context, outletId, lowStockOnly }) {
  const db = scopedDb().for(context);
  let query = db.table('stock_items').where({ status: 'active' });
  if (outletId) query = query.where({ outlet_id: outletId });
  const rows = await query.orderBy('name');
  if (!lowStockOnly) return rows;
  // Filtered in JS via the exact-decimal comparison helper, never a raw
  // SQL column-to-column comparison — the same "no floats, ever" rule
  // this module's quantity arithmetic already follows throughout.
  return rows.filter((row) => compareQuantity(row.current_quantity, row.reorder_level) <= 0);
}

async function getStockItem({ context, id }) {
  const db = scopedDb().for(context);
  return db.table('stock_items').where({ id }).first();
}

async function createStockItem({ context, outletId, name, unit, purchaseCost, supplier, reorderLevel }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet) throw new OutletNotFoundError();
  const [id] = await db.table('stock_items').insert({
    outlet_id: outletId,
    name,
    unit,
    purchase_cost: purchaseCost ?? '0.00',
    supplier: supplier ?? null,
    reorder_level: reorderLevel ?? ZERO_QTY,
  });
  return getStockItem({ context, id });
}

async function updateStockItem({ context, id, changes }) {
  const db = scopedDb().for(context);
  await db.table('stock_items').where({ id }).update(changes);
  return getStockItem({ context, id });
}

async function archiveStockItem({ context, id }) {
  return updateStockItem({ context, id, changes: { status: 'archived' } });
}

// ---------------------------------------------------------------------
// Recipe / BOM
// ---------------------------------------------------------------------

async function listMenuItemComponents({ context, menuItemId }) {
  const db = scopedDb().for(context);
  return db.table('pos_menu_item_components').where({ menu_item_id: menuItemId }).orderBy('id');
}

/** Full replace-all upsert for one menu item's recipe — plain config, no history to preserve (see `pos_menu_item_components`' own migration header). */
async function upsertMenuItemComponents({ context, menuItemId, components }) {
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const menuItem = await trx.table('pos_menu_items').where({ id: menuItemId }).first();
    if (!menuItem) throw new MenuItemNotFoundError();

    const rows = components ?? [];
    const stockItemIds = [...new Set(rows.map((row) => Number(row.stockItemId)))];
    const stockItems = stockItemIds.length ? await trx.table('stock_items').whereIn('id', stockItemIds) : [];
    const stockItemsById = new Map(stockItems.map((row) => [Number(row.id), row]));
    for (const id of stockItemIds) {
      const stockItem = stockItemsById.get(id);
      if (!stockItem) throw new StockItemNotFoundError();
      if (Number(stockItem.outlet_id) !== Number(menuItem.outlet_id)) {
        throw new OutletMismatchError('The stock item and the menu item must belong to the same outlet.');
      }
    }

    await trx.table('pos_menu_item_components').where({ menu_item_id: menuItemId }).delete();
    for (const row of rows) {
      await trx.table('pos_menu_item_components').insert({
        menu_item_id: menuItemId,
        stock_item_id: row.stockItemId,
        quantity: row.quantity,
      });
    }

    return trx.table('pos_menu_item_components').where({ menu_item_id: menuItemId }).orderBy('id');
  });
}

// ---------------------------------------------------------------------
// Goods received
// ---------------------------------------------------------------------

/**
 * `trx`-based, called from `runIdempotentMutation` — a real delivery,
 * financial in effect (it moves `purchase_cost`, ARCHITECTURE.md §7).
 * `lines`: `[{stockItemId, quantity, unitCost}]`. Every referenced stock
 * item must belong to `outletId` — checked against the locked rows
 * themselves, never a separate unlocked read.
 */
async function recordGoodsReceived({ trx, outletId, lines, reference, userId, businessDate }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('MISSING_FIELD', 'At least one line is required.', [{ field: 'lines', issue: 'missing' }]);
  }

  const stockItemIds = [...new Set(lines.map((line) => Number(line.stockItemId)))];
  const lockClosure = await resolveLockClosure({ trx, stockItemIds });
  const lockedById = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });

  // Checked only against the lines actually being received, never the
  // whole lock closure — a sibling stock item pulled in purely to keep the
  // lock ordering deadlock-free may legitimately belong to a different
  // outlet than this delivery; it is not itself part of this call.
  for (const stockItemId of stockItemIds) {
    const stockItem = lockedById.get(String(stockItemId));
    if (Number(stockItem.outlet_id) !== Number(outletId)) {
      throw new OutletMismatchError();
    }
  }

  for (const line of lines) {
    const stockItemId = Number(line.stockItemId);
    const stockItem = lockedById.get(String(stockItemId));
    const totalCost = extendedCost(line.unitCost, line.quantity);

    await trx.table('stock_movements').insert({
      outlet_id: stockItem.outlet_id,
      stock_item_id: stockItemId,
      type: 'received',
      quantity: line.quantity,
      unit_cost: line.unitCost,
      total_cost: totalCost,
      business_date: businessDate,
      reference: reference ?? null,
      user_id: userId ?? null,
    });
    // Last-cost only, wholesale-replaced — never a weighted average (see
    // `stock_items` migration header).
    await trx.table('stock_items').where({ id: stockItemId }).update({ purchase_cost: line.unitCost });
    await recomputeStockItemQuantity({ trx, stockItemId });
  }

  await applyStockAvailabilityEffects({ trx, stockItemIds });
  return trx.table('stock_items').whereIn('id', stockItemIds).orderBy('id');
}

// ---------------------------------------------------------------------
// Wastage
// ---------------------------------------------------------------------

/** `trx`-based, called from `runIdempotentMutation`. `quantity` is the caller's positive "amount lost" — always posts as a decrease. Reason is mandatory (PLAN.md Phase 6's confirmed `pos.stock_view` grant: "a floor action with a mandatory reason"). */
async function recordWastage({ trx, stockItemId, quantity, reason, userId, businessDate }) {
  if (!reason) throw new MissingWastageReasonError();

  const lockClosure = await resolveLockClosure({ trx, stockItemIds: [stockItemId] });
  const lockedById = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });
  const stockItem = lockedById.get(String(Number(stockItemId)));

  const movementQuantity = negateQuantity(quantity);
  const totalCost = extendedCost(stockItem.purchase_cost, movementQuantity);

  await trx.table('stock_movements').insert({
    outlet_id: stockItem.outlet_id,
    stock_item_id: stockItemId,
    type: 'wastage',
    quantity: movementQuantity,
    unit_cost: stockItem.purchase_cost,
    total_cost: totalCost,
    business_date: businessDate,
    reason,
    user_id: userId ?? null,
  });
  await recomputeStockItemQuantity({ trx, stockItemId });
  await applyStockAvailabilityEffects({ trx, stockItemIds: [stockItemId] });

  return trx.table('stock_items').where({ id: stockItemId }).first();
}

// ---------------------------------------------------------------------
// Stock takes — blind counting, the same structural guarantee
// `pos_shifts`' own cash-up already establishes
// ---------------------------------------------------------------------

async function listStockTakes({ context, outletId, status }) {
  const db = scopedDb().for(context);
  let query = db.table('stock_takes');
  if (outletId) query = query.where({ outlet_id: outletId });
  if (status) query = query.where({ status });
  return query.orderBy('opened_at', 'desc');
}

async function getStockTake({ context, id }) {
  const db = scopedDb().for(context);
  const stockTake = await db.table('stock_takes').where({ id }).first();
  if (!stockTake) return null;
  const lines = await db.table('stock_take_lines').where({ stock_take_id: id }).orderBy('id');
  return { stockTake, lines };
}

/** No idempotency key required — opening carries no stock effect yet, mirroring `pos/service.js`'s own `openShift` reasoning. */
async function openStockTake({ context, outletId, userId }) {
  const db = scopedDb().for(context);
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet) throw new OutletNotFoundError();
  const [id] = await db.table('stock_takes').insert({ outlet_id: outletId, opened_by_user_id: userId });
  return db.table('stock_takes').where({ id }).first();
}

/**
 * Blind — never reveals `theoretical_quantity`/`variance` (both stay
 * `null` until `completeStockTake`). A plain upsert on the
 * `(stock_take_id, stock_item_id)` unique key, naturally idempotent on
 * retry — recounting the same item before completion is a normal
 * correction, not a duplicate.
 */
async function recordStockTakeCount({ context, stockTakeId, stockItemId, countedQuantity }) {
  const db = scopedDb().for(context);
  const stockTake = await db.table('stock_takes').where({ id: stockTakeId }).first();
  if (!stockTake) throw new StockTakeNotFoundError();
  if (stockTake.status !== 'open') {
    throw new StockTakeNotOpenError(stockTakeId, stockTake.status);
  }

  // Same existence + outlet-match check `recordGoodsReceived`/
  // `upsertMenuItemComponents` already make before writing — without it, a
  // garbage id hits the raw FK constraint as a bare 500 instead of a
  // friendly error, and a real-but-wrong-outlet stock item is silently
  // accepted into a take that has no business counting it, contaminating
  // this take's own variance report with another outlet's stock.
  const stockItem = await db.table('stock_items').where({ id: stockItemId }).first();
  if (!stockItem) throw new StockItemNotFoundError();
  if (Number(stockItem.outlet_id) !== Number(stockTake.outlet_id)) {
    throw new OutletMismatchError();
  }

  try {
    await db.table('stock_take_lines').insert({ stock_take_id: stockTakeId, stock_item_id: stockItemId, counted_quantity: countedQuantity });
  } catch (error) {
    if (!(error && error.code === 'ER_DUP_ENTRY')) throw error;
    await db.table('stock_take_lines').where({ stock_take_id: stockTakeId, stock_item_id: stockItemId }).update({ counted_quantity: countedQuantity });
  }
  return db.table('stock_take_lines').where({ stock_take_id: stockTakeId, stock_item_id: stockItemId }).first();
}

/**
 * `trx`-based, called from `runIdempotentMutation`. Locks the take first,
 * then every counted item (shared lock-ordering helper), reads each
 * item's live `current_quantity` under that same lock as the
 * `theoretical_quantity`, and posts a `count_adjustment` movement for any
 * nonzero variance — the real "wholesale undo" for a discrepancy this
 * pass builds, not an automatic reflex to one anomalous line.
 */
async function completeStockTake({ trx, stockTakeId, userId }) {
  const stockTake = await trx.table('stock_takes').where({ id: stockTakeId }).forUpdate().first();
  if (!stockTake) throw new StockTakeNotFoundError();
  if (stockTake.status === 'completed') throw new StockTakeAlreadyCompletedError(stockTakeId);
  if (stockTake.status === 'cancelled') throw new StockTakeAlreadyCancelledError(stockTakeId);

  const lines = await trx.table('stock_take_lines').where({ stock_take_id: stockTakeId }).select();
  const stockItemIds = [...new Set(lines.map((line) => Number(line.stock_item_id)))];
  const lockClosure = stockItemIds.length ? await resolveLockClosure({ trx, stockItemIds }) : [];
  const lockedById = lockClosure.length ? await lockStockItemsSorted({ trx, stockItemIds: lockClosure }) : new Map();

  const property = await trx.table('properties').first('current_business_date');
  const businessDate = property?.current_business_date ?? null;

  const changedStockItemIds = [];
  for (const line of lines) {
    const stockItemId = Number(line.stock_item_id);
    const stockItem = lockedById.get(String(stockItemId));
    const theoreticalQuantity = stockItem.current_quantity;
    const variance = sumQuantity([line.counted_quantity, negateQuantity(theoreticalQuantity)]);

    await trx.table('stock_take_lines').where({ id: line.id }).update({ theoretical_quantity: theoreticalQuantity, variance });

    if (compareQuantity(variance, ZERO_QTY) !== 0) {
      const totalCost = extendedCost(stockItem.purchase_cost, variance);
      await trx.table('stock_movements').insert({
        outlet_id: stockItem.outlet_id,
        stock_item_id: stockItemId,
        type: 'count_adjustment',
        quantity: variance,
        unit_cost: stockItem.purchase_cost,
        total_cost: totalCost,
        business_date: businessDate,
        stock_take_id: stockTakeId,
        user_id: userId ?? null,
      });
      await recomputeStockItemQuantity({ trx, stockItemId });
      changedStockItemIds.push(stockItemId);
    }
  }

  if (changedStockItemIds.length) await applyStockAvailabilityEffects({ trx, stockItemIds: changedStockItemIds });

  await trx.table('stock_takes').where({ id: stockTakeId }).update({
    status: 'completed',
    completed_at: new Date(),
    completed_by_user_id: userId,
    business_date: businessDate,
  });

  const updatedLines = await trx.table('stock_take_lines').where({ stock_take_id: stockTakeId }).orderBy('id');
  return { stockTake: await trx.table('stock_takes').where({ id: stockTakeId }).first(), lines: updatedLines };
}

async function cancelStockTake({ context, stockTakeId, reason, userId }) {
  if (!reason) throw new ValidationError('MISSING_FIELD', '"reason" is required to cancel a stock take.', [{ field: 'reason', issue: 'missing' }]);
  const db = scopedDb().for(context);
  return db.transaction(async (trx) => {
    const stockTake = await trx.table('stock_takes').where({ id: stockTakeId }).forUpdate().first();
    if (!stockTake) throw new StockTakeNotFoundError();
    if (stockTake.status === 'completed') throw new StockTakeAlreadyCompletedError(stockTakeId);
    if (stockTake.status === 'cancelled') throw new StockTakeAlreadyCancelledError(stockTakeId);

    await trx.table('stock_takes').where({ id: stockTakeId }).update({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancel_reason: reason,
      cancelled_by_user_id: userId,
    });
    return trx.table('stock_takes').where({ id: stockTakeId }).first();
  });
}

// ---------------------------------------------------------------------
// Movement history
// ---------------------------------------------------------------------

async function listStockMovements({ context, stockItemId, type, dateFrom, dateTo }) {
  const db = scopedDb().for(context);
  let query = db.table('stock_movements').where({ stock_item_id: stockItemId });
  if (type) query = query.where({ type });
  if (dateFrom) query = query.where('business_date', '>=', dateFrom);
  if (dateTo) query = query.where('business_date', '<=', dateTo);
  return query.orderBy('id', 'desc');
}

module.exports = {
  lockStockItemsSorted,
  resolveLockClosure,
  recomputeStockItemQuantity,
  applyStockAvailabilityEffects,
  deductStockForSettlement,
  reverseStockForSettlement,
  listStockItems,
  getStockItem,
  createStockItem,
  updateStockItem,
  archiveStockItem,
  listMenuItemComponents,
  upsertMenuItemComponents,
  recordGoodsReceived,
  recordWastage,
  listStockTakes,
  getStockTake,
  openStockTake,
  recordStockTakeCount,
  completeStockTake,
  cancelStockTake,
  listStockMovements,
};
