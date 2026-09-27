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
 * (`recomputeStockLevel`), then writes the result back. The
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
const { createCategoryCatalogue } = require('../../shared/category-catalogue');
const { notifyStaff } = require('../notifications/staff-notifications');
const { recordAuditEntry } = require('../../audit');
const outletMenu = require('../../shared/outlet-menu');
const { sumQuantity, negateQuantity, multiplyQuantityByInteger, compareQuantity, extendedCost } = require('../../shared/quantity');
const {
  StockItemNotFoundError,
  OutletNotFoundError,
  MenuItemNotFoundError,
  MissingWastageReasonError,
  StockTakeNotFoundError,
  StockTakeNotOpenError,
  StockTakeAlreadyCompletedError,
  StockTakeAlreadyCancelledError,
  StockCategoryInUseError,
  InsufficientStockOverrideRequiredError,
  InsufficientStockForTransferError,
  SameOutletTransferError,
} = require('./errors');
const { generateUlid } = require('../../shared/ulid');

const ZERO_QTY = '0.000';

// ---------------------------------------------------------------------
// Gap closure — the stock-out override guard's fixed, system-supplied
// reasons for the three settlement writers that have no human present to
// type one (a room-charge OTP already single-use-claimed, and a payment
// already captured by a gateway webhook) plus the guest QR acknowledgment,
// which is a yes/no prompt, not a free-text field. See
// `assertStockAvailableOrOverridden`'s own header for how these are used.
// ---------------------------------------------------------------------
const AUTOMATIC_OVERRIDE_REASON_GUEST_ACKNOWLEDGED = 'Guest acknowledged a low-stock warning before placing the order.';
const AUTOMATIC_OVERRIDE_REASON_ROOM_CHARGE_OTP = 'Automatically approved — a verified room-charge confirmation cannot be blocked; flagged for review.';
const AUTOMATIC_OVERRIDE_REASON_CARD_CAPTURE = 'Automatically approved — payment was already captured by the gateway before settlement could be blocked; flagged for review.';

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
 * An outlet's level row for a stock item, locked (ARCHITECTURE.md §5),
 * or null when that outlet has never stocked it.
 */
function lockedLevel(trx, outletId, stockItemId) {
  return trx.table('stock_levels').where({ outlet_id: outletId, stock_item_id: stockItemId }).forUpdate().first();
}

/** Writes an outlet's level for a stock item, creating the row on first use. */
async function upsertLevel(trx, outletId, stockItemId, changes) {
  const existing = await lockedLevel(trx, outletId, stockItemId);
  if (existing) {
    await trx.table('stock_levels').where({ id: existing.id }).update(changes);
    return;
  }
  const item = await trx.table('stock_items').where({ id: stockItemId }).first('reorder_level');
  try {
    await trx.table('stock_levels').insert({ outlet_id: outletId, stock_item_id: stockItemId, reorder_level: item?.reorder_level ?? ZERO_QTY, ...changes });
  } catch (error) {
    // A concurrent first write created the row — apply ours on top of it.
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
    await trx.table('stock_levels').where({ outlet_id: outletId, stock_item_id: stockItemId }).update(changes);
  }
}

/**
 * The one writer of on-hand quantities — always re-derived, never
 * incremented in place. See file header. Shared catalogue (migration
 * 20261108090000): a stock item is shared by the property and each outlet
 * keeps its own quantity (`stock_levels.current_quantity` = the sum of that
 * outlet's movements); `stock_items.current_quantity` is the property-wide
 * total of every movement.
 *
 * A real two-connection concurrency bug, found and fixed by the
 * CONC-STOCK-1/CONC-STOCK-4 tests, not shipped: these reads MUST be
 * LOCKING reads (`.forUpdate()`), not plain `SELECT`s. By the time this
 * runs, the CALLER already holds this item's `stock_items` row lock
 * (`lockStockItemsSorted`), but this transaction's REPEATABLE READ snapshot
 * was taken earlier (its first plain read); a plain `SELECT` would reuse
 * that stale snapshot, miss a concurrent transaction's committed movement,
 * and overwrite the quantity with a sum that drops it. `.forUpdate()` reads
 * what was actually committed.
 */
async function recomputeStockLevel({ trx, stockItemId, outletId }) {
  const item = await trx.table('stock_items').where({ id: stockItemId }).forUpdate().first();
  const before = await lockedLevel(trx, outletId, stockItemId);
  const outletMovements = await trx.table('stock_movements').where({ stock_item_id: stockItemId, outlet_id: outletId }).forUpdate().select('quantity');
  const currentQuantity = sumQuantity(outletMovements.map((row) => row.quantity));
  await upsertLevel(trx, outletId, stockItemId, { current_quantity: currentQuantity });

  const allMovements = await trx.table('stock_movements').where({ stock_item_id: stockItemId }).forUpdate().select('quantity');
  await trx.table('stock_items').where({ id: stockItemId }).update({ current_quantity: sumQuantity(allMovements.map((row) => row.quantity)) });

  if (item) {
    await notifyStockThresholdCrossings({
      trx,
      item,
      outletId,
      beforeQuantity: before?.current_quantity ?? ZERO_QTY,
      reorderLevel: before?.reorder_level ?? item.reorder_level,
      currentQuantity,
    });
  }
  return currentQuantity;
}

/**
 * Gap closure (staff notifications): alert on the CROSSING only — the one
 * movement that takes an item at an outlet from above its reorder level to
 * at-or-below it (or from above zero to at-or-below zero), never on every
 * later decrement while it stays low. A restock back above the line
 * re-arms it. This is the single writer of on-hand quantities, so every
 * path (sales, reversals, wastage, deliveries, stock takes) is covered here.
 */
async function notifyStockThresholdCrossings({ trx, item, outletId, beforeQuantity, reorderLevel, currentQuantity }) {
  const outlet = await trx.table('pos_outlets').where({ id: outletId }).first('name');
  const payload = {
    stockItemId: item.id,
    name: item.name,
    unit: item.unit,
    outletId,
    outletName: outlet?.name ?? null,
    quantity: currentQuantity,
    reorderLevel,
  };
  const wasOut = compareQuantity(beforeQuantity, ZERO_QTY) <= 0;
  const isOut = compareQuantity(currentQuantity, ZERO_QTY) <= 0;
  if (!wasOut && isOut) {
    await notifyStaff({ trx, eventType: 'stock.out_of_stock', payload });
    return; // out of stock already says more than "at reorder level"
  }
  const reorderLevelSet = compareQuantity(reorderLevel, ZERO_QTY) > 0;
  if (reorderLevelSet && !isOut && compareQuantity(beforeQuantity, reorderLevel) > 0 && compareQuantity(currentQuantity, reorderLevel) <= 0) {
    await notifyStaff({ trx, eventType: 'stock.reorder_level_reached', payload });
  }
}

/**
 * The proactive oversell guard — see file header — at ONE outlet: the menu
 * items that depend on any of `stockItemIds` and are sold at `outletId` are
 * switched off there when any recipe component is at or below zero AT THAT
 * OUTLET, and back on when every component is above zero again (only if it
 * was this mechanism that switched it off). Other outlets are untouched —
 * selling out at the bar must not stop the restaurant.
 *
 * Locks every stock item any affected menu item needs, sorted ascending,
 * BEFORE any `pos_menu_items` row (the file header's global lock order),
 * then each menu item row, then its per-outlet setting row.
 *
 * Never touches a manually-disabled item (`stock_auto_unavailable: false`)
 * in either direction — an explicit staff action always wins.
 */
async function applyStockAvailabilityEffects({ trx, stockItemIds, outletId }) {
  const uniqueIds = [...new Set(stockItemIds.map((id) => Number(id)))];
  if (uniqueIds.length === 0 || !outletId) return;

  const componentRows = await trx.table('pos_menu_item_components').whereIn('stock_item_id', uniqueIds).select('menu_item_id');
  const menuItemIds = [...new Set(componentRows.map((row) => Number(row.menu_item_id)))].sort((a, b) => a - b);
  if (menuItemIds.length === 0) return;

  // Every component of every affected menu item is locked up front, before
  // any pos_menu_items row, in the one global ascending order — see file
  // header (locking a sibling only after a menu item row is held inverts
  // that order and can deadlock).
  const allComponentRows = await trx.table('pos_menu_item_components').whereIn('menu_item_id', menuItemIds).select('stock_item_id');
  const allStockItemIds = [...new Set([...uniqueIds, ...allComponentRows.map((row) => Number(row.stock_item_id))])];
  await lockStockItemsSorted({ trx, stockItemIds: allStockItemIds });

  const soldHere = new Set((await outletMenu.carriedCategoryNames(trx, outletId)).map((name) => name.trim().toLowerCase()));

  for (const menuItemId of menuItemIds) {
    const menuItem = await trx.table('pos_menu_items').where({ id: menuItemId }).forUpdate().first();
    if (!menuItem || menuItem.status !== 'active' || !soldHere.has(String(menuItem.category).trim().toLowerCase())) continue;

    const components = await trx.table('pos_menu_item_components').where({ menu_item_id: menuItemId }).select('stock_item_id');
    const componentStockItemIds = components.map((row) => row.stock_item_id);
    // Locking reads, for the same snapshot reason as `recomputeStockLevel`.
    const levels = componentStockItemIds.length
      ? await trx.table('stock_levels').where({ outlet_id: outletId }).whereIn('stock_item_id', componentStockItemIds).forUpdate().select('stock_item_id', 'current_quantity')
      : [];
    const quantityByItem = new Map(levels.map((row) => [String(row.stock_item_id), row.current_quantity]));
    // An outlet that has never stocked a component has none of it.
    const anyDepleted = componentStockItemIds.some((id) => compareQuantity(quantityByItem.get(String(id)) ?? ZERO_QTY, ZERO_QTY) <= 0);

    const setting = await trx.table('pos_outlet_menu_items').where({ outlet_id: outletId, menu_item_id: menuItemId }).forUpdate().first();
    const available = setting ? Boolean(setting.is_available) : true;
    const autoOff = setting ? Boolean(setting.stock_auto_unavailable) : false;

    if (anyDepleted && available) {
      await outletMenu.upsertOutletMenuSetting(trx, outletId, menuItemId, { is_available: false, stock_auto_unavailable: true });
    } else if (!anyDepleted && !available && autoOff) {
      await outletMenu.upsertOutletMenuSetting(trx, outletId, menuItemId, { is_available: true, stock_auto_unavailable: false });
    }
  }
}

// ---------------------------------------------------------------------
// Settlement hooks — called from pos/service.js and cashiering/service.js
// ---------------------------------------------------------------------

/**
 * Pure aggregation, shared by `deductStockForSettlement` and the stock-out
 * override guard below, so the real deduction and the pre-write check that
 * gates it are always computed from the identical recipe math and can never
 * silently disagree. `lines`: `[{menuItemId, quantity}]` — a smaller, more
 * general shape than a raw `pos_order_items` row, so a caller with only a
 * cart of `{menuItemId, quantity}` pairs (add-time, before any order row
 * exists) can call this too.
 *
 * @returns {Promise<Map<number, string>>} deduction quantity (a positive
 *   decimal string — the amount that would be CONSUMED, not yet negated)
 *   keyed by stock item id. Empty when none of `lines` has a recipe.
 */
async function computeStockDeductionsForLines({ trx, lines }) {
  const orderedQtyByMenuItem = new Map();
  for (const line of lines) {
    const menuItemId = Number(line.menuItemId);
    const existing = orderedQtyByMenuItem.get(menuItemId) ?? 0;
    orderedQtyByMenuItem.set(menuItemId, existing + Number(line.quantity));
  }
  const menuItemIds = [...orderedQtyByMenuItem.keys()];
  if (menuItemIds.length === 0) return new Map();

  const components = await trx.table('pos_menu_item_components').whereIn('menu_item_id', menuItemIds).select('menu_item_id', 'stock_item_id', 'quantity');
  if (components.length === 0) return new Map(); // No recipe anywhere in these lines — zero further overhead.

  const deductionByStockItem = new Map();
  for (const component of components) {
    const orderedQty = orderedQtyByMenuItem.get(Number(component.menu_item_id)) ?? 0;
    const deduction = multiplyQuantityByInteger(component.quantity, orderedQty);
    const key = Number(component.stock_item_id);
    deductionByStockItem.set(key, sumQuantity([deductionByStockItem.get(key) ?? ZERO_QTY, deduction]));
  }
  return deductionByStockItem;
}

/**
 * Gap closure — the stock-out override guard (user-reported: the Register
 * let an item sell at zero stock with no proactive check at all). A plain,
 * NON-LOCKING read of each affected stock item's `current_quantity` — this
 * is a check, not a mutation, and this module's own "negative stock is
 * allowed, never blocked" rule (file header) still governs the real
 * deduction regardless of what this function decides. Under this
 * transaction's REPEATABLE READ isolation a plain read sees its own
 * consistent-read snapshot (established at the transaction's first
 * ordinary SELECT), not necessarily the true instantaneous value — a
 * narrower version of the same tolerated race below, not a separate one.
 * Two concurrent calls that both pass this check are accepted, not closed
 * against, the same tolerated-race philosophy this module already applies
 * to the analogous settlement-vs-availability-flip race — a
 * reservation/pessimistic-lock mechanism was deliberately not introduced
 * here.
 *
 * Confirmed decision: adding/settling an item that would take (or has
 * already taken) a linked stock component to <= 0 is ALLOWED, never
 * blocked outright, but requires a caller-supplied override reason —
 * mirroring `ar/service.js`'s credit-limit override shape, with one real
 * improvement: unlike that precedent (whose override reason is never
 * durably persisted anywhere), every override here writes a real
 * `audit_log` row, one per affected stock item.
 *
 * `overrideReason` may be a human-typed string (the staff Register's
 * `ConfirmDialog`), or one of this file's own `AUTOMATIC_OVERRIDE_REASON_*`
 * constants for a call site with no human present to ask (a guest's
 * already-claimed room-charge OTP, a card payment the gateway already
 * captured) — the SAME rule and the SAME error code apply to every channel;
 * only how each frontend responds to the rejection differs.
 *
 * @returns {Promise<{affectedStockItemIds: number[]}>}
 */
async function assertStockAvailableOrOverridden({ trx, lines, overrideReason, userId, propertyId, outletId, source = 'api' }) {
  if (!outletId) throw new Error('assertStockAvailableOrOverridden: outletId is required — stock is counted per outlet.');
  const deductionByStockItem = await computeStockDeductionsForLines({ trx, lines });
  if (deductionByStockItem.size === 0) return { affectedStockItemIds: [] };

  const stockItemIds = [...deductionByStockItem.keys()];
  // What THIS outlet has on hand (an outlet that never stocked it has none).
  const items = await trx.table('stock_items').whereIn('id', stockItemIds).select('id', 'name', 'unit');
  const levels = await trx.table('stock_levels').where({ outlet_id: outletId }).whereIn('stock_item_id', stockItemIds).select('stock_item_id', 'current_quantity');
  const quantityByItem = new Map(levels.map((row) => [String(row.stock_item_id), row.current_quantity]));
  const stockRows = items.map((item) => ({ ...item, current_quantity: quantityByItem.get(String(item.id)) ?? ZERO_QTY }));

  const affected = [];
  for (const row of stockRows) {
    const deduction = deductionByStockItem.get(Number(row.id));
    const projectedQuantity = sumQuantity([row.current_quantity, negateQuantity(deduction)]);
    if (compareQuantity(projectedQuantity, ZERO_QTY) <= 0) {
      affected.push({ stockItemId: Number(row.id), name: row.name, unit: row.unit, projectedQuantity });
    }
  }
  if (affected.length === 0) return { affectedStockItemIds: [] };

  const reason = typeof overrideReason === 'string' ? overrideReason.trim() : '';
  if (!reason) throw new InsufficientStockOverrideRequiredError(affected);

  for (const item of affected) {
    await recordAuditEntry(trx, {
      entityType: 'stock_items',
      entityId: item.stockItemId,
      propertyId: propertyId ?? null,
      userId: userId ?? null,
      action: 'stock_override_applied',
      source,
      afterState: { projectedQuantity: item.projectedQuantity, unit: item.unit },
      reason,
    });
  }
  await notifyStaff({ trx, eventType: 'pos.stock_override_applied', payload: { items: affected, reason } });

  return { affectedStockItemIds: affected.map((item) => item.stockItemId) };
}

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
 *
 * `overrideReasonsByStockItemId` (optional `Map<number, string>`): when the
 * caller's own `assertStockAvailableOrOverridden` call found this
 * settlement's items required an override, the SAME reason is stamped onto
 * the specific `sold` movement row(s) that triggered it — a display
 * convenience for reading a stock item's raw movement history directly;
 * `audit_log` remains the authoritative record regardless of whether a
 * caller supplies this.
 */
async function deductStockForSettlement({ trx, orderId, settlementId, items, businessDate, userId, overrideReasonsByStockItemId }) {
  if (!items || items.length === 0) return;

  const lines = items.map((item) => ({ menuItemId: item.menu_item_id, quantity: item.quantity }));
  const deductionByStockItem = await computeStockDeductionsForLines({ trx, lines });
  if (deductionByStockItem.size === 0) return;

  const stockItemIds = [...deductionByStockItem.keys()];
  // Deducted from the outlet where it was sold.
  const { outlet_id: outletId } = await trx.table('pos_orders').where({ id: orderId }).first('outlet_id');
  const lockClosure = await resolveLockClosure({ trx, stockItemIds });
  const lockedById = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });

  for (const stockItemId of stockItemIds) {
    const stockItem = lockedById.get(String(stockItemId));
    const deduction = deductionByStockItem.get(stockItemId);
    const movementQuantity = negateQuantity(deduction); // Always deducts — never blocked by an insufficient balance, see file header.
    const totalCost = extendedCost(stockItem.purchase_cost, movementQuantity);

    await trx.table('stock_movements').insert({
      outlet_id: outletId,
      stock_item_id: stockItemId,
      type: 'sold',
      quantity: movementQuantity,
      unit_cost: stockItem.purchase_cost,
      total_cost: totalCost,
      business_date: businessDate,
      pos_order_id: orderId,
      pos_order_settlement_id: settlementId,
      user_id: userId ?? null,
      reason: overrideReasonsByStockItemId?.get(stockItemId) ?? null,
    });
    await recomputeStockLevel({ trx, stockItemId, outletId });
  }

  await applyStockAvailabilityEffects({ trx, stockItemIds, outletId });
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
  await lockStockItemsSorted({ trx, stockItemIds: lockClosure });

  for (const movement of originalMovements) {
    const stockItemId = Number(movement.stock_item_id);
    const reverseQuantity = negateQuantity(movement.quantity); // The original was negative; the reversal restores it.
    const totalCost = extendedCost(movement.unit_cost, reverseQuantity);

    await trx.table('stock_movements').insert({
      outlet_id: movement.outlet_id, // Back to the outlet it was sold from.
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
    await recomputeStockLevel({ trx, stockItemId, outletId: movement.outlet_id });
  }

  // Reversal only ever increases quantity, so only the re-enable branch
  // of applyStockAvailabilityEffects can fire here — still routed through
  // the same shared function rather than a bespoke re-enable-only path.
  for (const outletId of [...new Set(originalMovements.map((row) => String(row.outlet_id)))]) {
    const outletItemIds = originalMovements.filter((row) => String(row.outlet_id) === outletId).map((row) => Number(row.stock_item_id));
    await applyStockAvailabilityEffects({ trx, stockItemIds: outletItemIds, outletId });
  }
}

// ---------------------------------------------------------------------
// Stock item categories — the property's shared list (migration
// 20261108090000), kept holding the same names as the menu categories
// (user-requested; `mirror` in both configs). `stock_items.category` keeps
// holding the category name, so every reader is unchanged. An outlet shows
// the stock categories matching the menu categories it carries.
// ---------------------------------------------------------------------

const stockCategoryCatalogue = createCategoryCatalogue({
  table: 'stock_item_categories',
  resolveMode: 'name',
  optional: true,
  cascadeRename: { table: 'stock_items', matchColumn: 'category' },
  mirror: { table: 'pos_menu_categories', cascadeRename: { table: 'pos_menu_items', matchColumn: 'category' } },
  inUseChecks: [{ table: 'stock_items', matchColumn: 'category', matchBy: 'name', filter: (q) => q.where({ status: 'active' }) }],
  errors: {
    categoryNotFound: () =>
      new ValidationError('CATEGORY_NOT_FOUND', 'Choose a category from the list — register new categories first.', [{ field: 'category', issue: 'not_registered' }]),
    categoryInUse: (name, itemCount) => new StockCategoryInUseError(name, itemCount),
  },
});

const nameKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

async function assertOutlet(db, outletId) {
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first();
  if (!outlet || outlet.status !== 'active') throw new OutletNotFoundError();
  return outlet;
}

/** With `outletId`, only the categories that outlet carries (by name, from its menu categories). */
async function listStockItemCategories({ context, includeArchived, outletId }) {
  const rows = await stockCategoryCatalogue.listCategories({ context, includeArchived });
  if (!outletId) return rows;
  const db = scopedDb().for(context);
  const carried = new Set((await outletMenu.carriedCategoryNames(db, outletId)).map(nameKey));
  return rows.filter((row) => carried.has(nameKey(row.name)));
}
const getStockItemCategory = stockCategoryCatalogue.getCategory;

/** Registers a shared stock category (and its matching menu category); `outletId` (optional) makes that outlet carry it. */
async function createStockItemCategory({ context, outletId, name, sortOrder }) {
  const db = scopedDb().for(context);
  if (outletId) await assertOutlet(db, outletId);
  const category = await stockCategoryCatalogue.createCategory({ context, name, sortOrder });
  if (outletId) await carryCategoryByName(db, outletId, category.name);
  return category;
}
const updateStockItemCategory = stockCategoryCatalogue.updateCategory;
const archiveStockItemCategory = stockCategoryCatalogue.archiveCategory;
/** The active stock category matching `name`; `null`/empty stays null — category is optional. */
function resolveStockCategoryName({ db, name }) {
  return stockCategoryCatalogue.resolveByName({ db, name });
}

/** The outlet carries the menu category of this name (the stock list mirrors it), when one exists. */
async function carryCategoryByName(db, outletId, categoryName) {
  if (!categoryName) return;
  const menuCategory = await db.table('pos_menu_categories').where({ name: String(categoryName).trim() }).first('id');
  if (menuCategory) await outletMenu.carryCategory(db, outletId, menuCategory.id);
}

// ---------------------------------------------------------------------
// Stock items — shared by the property; quantities and reorder levels are
// per outlet (`stock_levels`).
// ---------------------------------------------------------------------

/** Adds `outlet_id`, and that outlet's `current_quantity`/`reorder_level` (0 / the item default when it has never stocked it). */
function withLevel(item, level, outletId) {
  return {
    ...item,
    outlet_id: outletId,
    total_quantity: item.current_quantity,
    current_quantity: level?.current_quantity ?? ZERO_QTY,
    reorder_level: level?.reorder_level ?? item.reorder_level,
  };
}

/**
 * Without `outletId`: every active stock item, `current_quantity` being the
 * property-wide total and `reorder_level` the default. With `outletId`: the
 * items that outlet deals in — those filed under a category it carries,
 * and any it already stocks (has a level for, e.g. an uncategorized item
 * added from it) — each with that
 * outlet's own quantity and reorder level.
 */
async function listStockItems({ context, outletId, lowStockOnly }) {
  const db = scopedDb().for(context);
  const items = await db.table('stock_items').where({ status: 'active' }).orderBy('name');
  let rows = items;
  if (outletId) {
    const carried = new Set((await outletMenu.carriedCategoryNames(db, outletId)).map(nameKey));
    const levels = await db.table('stock_levels').where({ outlet_id: outletId });
    const levelByItem = new Map(levels.map((row) => [String(row.stock_item_id), row]));
    rows = items
      .filter((item) => (item.category && carried.has(nameKey(item.category))) || levelByItem.has(String(item.id)))
      .map((item) => withLevel(item, levelByItem.get(String(item.id)), outletId));
  }
  if (!lowStockOnly) return rows;
  // Filtered in JS via the exact-decimal comparison helper, never a raw
  // SQL column-to-column comparison — the same "no floats, ever" rule
  // this module's quantity arithmetic already follows throughout.
  return rows.filter((row) => compareQuantity(row.current_quantity, row.reorder_level) <= 0);
}

/** Every outlet's level for the given items (or all active items). */
async function listStockLevels({ context, stockItemId }) {
  const db = scopedDb().for(context);
  let query = db.table('stock_levels');
  if (stockItemId) query = query.where({ stock_item_id: stockItemId });
  return query.orderBy('stock_item_id').orderBy('outlet_id');
}

async function getStockItem({ context, id, outletId }) {
  const db = scopedDb().for(context);
  const item = await db.table('stock_items').where({ id }).first();
  if (!item || !outletId) return item;
  const level = await db.table('stock_levels').where({ outlet_id: outletId, stock_item_id: id }).first();
  return withLevel(item, level, outletId);
}

/**
 * A shared stock item. `outletId` (optional) is where it is being added
 * from: that outlet gets a level for it (with `reorderLevel`) and carries
 * its category, so it shows there straight away. `reorderLevel` is also
 * the item's default for outlets that have none of their own yet.
 */
async function createStockItem({ context, outletId, name, unit, category, purchaseCost, supplier, reorderLevel }) {
  const db = scopedDb().for(context);
  if (outletId) await assertOutlet(db, outletId);
  const categoryName = await resolveStockCategoryName({ db, name: category });
  return db.transaction(async (trx) => {
    const [id] = await trx.table('stock_items').insert({
      name,
      unit,
      category: categoryName,
      purchase_cost: purchaseCost ?? '0.00',
      supplier: supplier ?? null,
      reorder_level: reorderLevel ?? ZERO_QTY,
    });
    if (outletId) {
      await upsertLevel(trx, outletId, id, { reorder_level: reorderLevel ?? ZERO_QTY });
      await carryCategoryByName(trx, outletId, categoryName);
    }
    const item = await trx.table('stock_items').where({ id }).first();
    if (!outletId) return item;
    return withLevel(item, await trx.table('stock_levels').where({ outlet_id: outletId, stock_item_id: id }).first(), outletId);
  });
}

/** With `outletId`, a `reorder_level` change is that outlet's own; without, it is the item default. */
async function updateStockItem({ context, id, changes, outletId }) {
  const db = scopedDb().for(context);
  const next = { ...changes };
  if (next.category !== undefined) {
    const current = await db.table('stock_items').where({ id }).first('category');
    const unchanged = current && typeof next.category === 'string' && next.category.trim() === current.category;
    // An item keeps its current category even if that category has since
    // been archived — editing only its cost/reorder level must not be
    // refused. Only a change of category has to name an active registered
    // one (or clear it entirely — resolveStockCategoryName's own null case).
    if (unchanged) delete next.category;
    else next.category = await resolveStockCategoryName({ db, name: next.category });
  }
  await db.transaction(async (trx) => {
    if (outletId && next.reorder_level !== undefined) {
      await assertOutlet(trx, outletId);
      const exists = await trx.table('stock_items').where({ id }).forUpdate().first('id');
      if (!exists) throw new StockItemNotFoundError();
      await upsertLevel(trx, outletId, id, { reorder_level: next.reorder_level });
      delete next.reorder_level;
    }
    if (Object.keys(next).length) await trx.table('stock_items').where({ id }).update(next);
  });
  return getStockItem({ context, id, outletId });
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

/**
 * Which active Register menu items use which stock items — one row per
 * recipe component, so the Stock items screen can tell a stock item sold
 * directly (a menu item whose whole recipe is that one item) from one that
 * is only an ingredient, or not sold at all. `outletId` (optional) narrows
 * it to the menu items that outlet sells, with their availability there.
 */
async function listMenuItemLinks({ context, outletId }) {
  const db = scopedDb().for(context);
  const menuItems = outletId
    ? await outletMenu.menuItemsForOutlet(db, outletId)
    : (await db.table('pos_menu_items').where({ status: 'active' }).select('id', 'name', 'category')).map((row) => ({ ...row, is_available: true }));
  if (menuItems.length === 0) return [];

  const menuById = new Map(menuItems.map((row) => [String(row.id), row]));
  const components = await db.table('pos_menu_item_components').select('menu_item_id', 'stock_item_id', 'quantity');

  const linked = components.filter((row) => menuById.has(String(row.menu_item_id)));
  const countByMenuItem = new Map();
  for (const row of linked) {
    const key = String(row.menu_item_id);
    countByMenuItem.set(key, (countByMenuItem.get(key) ?? 0) + 1);
  }

  return linked.map((row) => {
    const menuItem = menuById.get(String(row.menu_item_id));
    return {
      menu_item_id: row.menu_item_id,
      menu_item_name: menuItem.name,
      menu_item_category: menuItem.category,
      menu_item_available: Boolean(menuItem.is_available),
      stock_item_id: row.stock_item_id,
      quantity: row.quantity,
      component_count: countByMenuItem.get(String(row.menu_item_id)),
    };
  });
}

/** Full replace-all upsert for one menu item's recipe — plain config, no history to preserve (see `pos_menu_item_components`' own migration header). Both are shared, so any stock item may be a component. */
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
      if (!stockItemsById.get(id)) throw new StockItemNotFoundError();
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
 * `lines`: `[{stockItemId, quantity, unitCost}]`, received INTO `outletId`
 * (stock items are shared; the delivery adds to that outlet's quantity).
 */
async function recordGoodsReceived({ trx, outletId, lines, reference, userId, businessDate }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('MISSING_FIELD', 'At least one line is required.', [{ field: 'lines', issue: 'missing' }]);
  }
  await assertOutlet(trx, outletId);

  const stockItemIds = [...new Set(lines.map((line) => Number(line.stockItemId)))];
  const lockClosure = await resolveLockClosure({ trx, stockItemIds });
  await lockStockItemsSorted({ trx, stockItemIds: lockClosure });

  for (const line of lines) {
    const stockItemId = Number(line.stockItemId);
    const totalCost = extendedCost(line.unitCost, line.quantity);

    await trx.table('stock_movements').insert({
      outlet_id: outletId,
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
    await recomputeStockLevel({ trx, stockItemId, outletId });
  }

  await applyStockAvailabilityEffects({ trx, stockItemIds, outletId });
  const items = await trx.table('stock_items').whereIn('id', stockItemIds).orderBy('id');
  const levels = await trx.table('stock_levels').where({ outlet_id: outletId }).whereIn('stock_item_id', stockItemIds);
  const levelByItem = new Map(levels.map((row) => [String(row.stock_item_id), row]));
  return items.map((item) => withLevel(item, levelByItem.get(String(item.id)), outletId));
}

// ---------------------------------------------------------------------
// Wastage
// ---------------------------------------------------------------------

/** `trx`-based, called from `runIdempotentMutation`. `quantity` is the caller's positive "amount lost" at `outletId` — always posts as a decrease. Reason is mandatory (PLAN.md Phase 6's confirmed `pos.stock_view` grant: "a floor action with a mandatory reason"). */
async function recordWastage({ trx, stockItemId, outletId, quantity, reason, userId, businessDate }) {
  if (!reason) throw new MissingWastageReasonError();
  if (!outletId) throw new ValidationError('MISSING_FIELD', '"outlet_id" is required — say which outlet lost it.', [{ field: 'outlet_id', issue: 'missing' }]);
  await assertOutlet(trx, outletId);

  const lockClosure = await resolveLockClosure({ trx, stockItemIds: [stockItemId] });
  const lockedById = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });
  const stockItem = lockedById.get(String(Number(stockItemId)));

  const movementQuantity = negateQuantity(quantity);
  const totalCost = extendedCost(stockItem.purchase_cost, movementQuantity);

  await trx.table('stock_movements').insert({
    outlet_id: outletId,
    stock_item_id: stockItemId,
    type: 'wastage',
    quantity: movementQuantity,
    unit_cost: stockItem.purchase_cost,
    total_cost: totalCost,
    business_date: businessDate,
    reason,
    user_id: userId ?? null,
  });
  await recomputeStockLevel({ trx, stockItemId, outletId });
  await applyStockAvailabilityEffects({ trx, stockItemIds: [stockItemId], outletId });

  const item = await trx.table('stock_items').where({ id: stockItemId }).first();
  return withLevel(item, await trx.table('stock_levels').where({ outlet_id: outletId, stock_item_id: stockItemId }).first(), outletId);
}

// ---------------------------------------------------------------------
// Transfers between outlets
// ---------------------------------------------------------------------

/**
 * `trx`-based, called from `runIdempotentMutation`. Moves `quantity` of one
 * shared stock item from `fromOutletId` to `toOutletId` as two
 * `stock_movements` rows of type `transfer` — minus at the source, plus at
 * the destination — written in the caller's one transaction, so there is no
 * state in which one leg exists without the other. Both legs carry the
 * item's current `purchase_cost` (stock items are shared property-wide, so
 * there is one cost, not a source cost and a destination cost) and the two
 * legs' `total_cost` are exact mirrors: property-wide, a transfer nets to
 * zero quantity and zero cost. It is a relocation, never a loss or a
 * receipt — which is the whole point of recording it as its own type
 * rather than as wastage at one outlet plus goods received at another.
 *
 * DELIBERATELY DEPARTS from this module's "negative stock is allowed, never
 * blocked" rule (file header). A sale or wastage records something that
 * already happened on the floor, so refusing it would only make the ledger
 * lie; a transfer is a decision to move stock that must physically exist at
 * the source for the destination's gain to be real. So it is refused
 * outright — no override reason can push it through — when the source holds
 * less than `quantity` (an outlet with no level row at all holds zero).
 * The check is a locking read taken AFTER the `stock_items` lock every
 * writer of this item queues on, so a concurrent sale, wastage, delivery,
 * stock take or another transfer of the same item cannot slip between the
 * check and the write.
 *
 * Lock order is the one every writer here uses: closure resolved first,
 * locked ascending in one call, then `stock_levels`, then (inside
 * `applyStockAvailabilityEffects`) menu items. Arrives immediately — there
 * is no confirm-on-receipt step, and no request/approve paper trail (both
 * deliberately out of scope for this first version). The two legs share a
 * system-generated `reference` (`TRF-<ulid>`) so a reader can pair them;
 * `note` (optional, the user's own words) goes in `reason` on both.
 */
async function transferStock({ trx, stockItemId, fromOutletId, toOutletId, quantity, note, userId, businessDate }) {
  if (String(fromOutletId) === String(toOutletId)) throw new SameOutletTransferError();
  const fromOutlet = await assertOutlet(trx, fromOutletId);
  const toOutlet = await assertOutlet(trx, toOutletId);

  const lockClosure = await resolveLockClosure({ trx, stockItemIds: [stockItemId] });
  const lockedById = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });
  const stockItem = lockedById.get(String(Number(stockItemId)));
  if (!stockItem || stockItem.status !== 'active') throw new StockItemNotFoundError();

  const sourceLevel = await lockedLevel(trx, fromOutletId, stockItemId);
  const available = sourceLevel?.current_quantity ?? ZERO_QTY;
  if (compareQuantity(available, quantity) < 0) {
    throw new InsufficientStockForTransferError({
      stockItemId: Number(stockItemId),
      name: stockItem.name,
      unit: stockItem.unit,
      fromOutletId: Number(fromOutletId),
      available,
      requested: quantity,
    });
  }

  const reference = `TRF-${generateUlid()}`;
  const outQuantity = negateQuantity(quantity);
  const shared = {
    stock_item_id: stockItemId,
    type: 'transfer',
    unit_cost: stockItem.purchase_cost,
    business_date: businessDate,
    reference,
    reason: note || null,
    user_id: userId ?? null,
  };
  await trx.table('stock_movements').insert({ ...shared, outlet_id: fromOutletId, quantity: outQuantity, total_cost: extendedCost(stockItem.purchase_cost, outQuantity) });
  await trx.table('stock_movements').insert({ ...shared, outlet_id: toOutletId, quantity, total_cost: extendedCost(stockItem.purchase_cost, quantity) });

  const fromQuantity = await recomputeStockLevel({ trx, stockItemId, outletId: fromOutletId });
  const toQuantity = await recomputeStockLevel({ trx, stockItemId, outletId: toOutletId });
  // The same reactive availability flip a sale or delivery triggers, at
  // both ends: draining the source may make a menu item unavailable there;
  // stocking the destination may make one available again.
  await applyStockAvailabilityEffects({ trx, stockItemIds: [stockItemId], outletId: fromOutletId });
  await applyStockAvailabilityEffects({ trx, stockItemIds: [stockItemId], outletId: toOutletId });

  return {
    reference,
    stockItem: { id: stockItem.id, name: stockItem.name, unit: stockItem.unit },
    quantity,
    note: note || null,
    businessDate,
    from: { outletId: fromOutlet.id, outletName: fromOutlet.name, newQuantity: fromQuantity },
    to: { outletId: toOutlet.id, outletName: toOutlet.name, newQuantity: toQuantity },
  };
}

/**
 * Recent transfers, one row per transfer (its two legs paired by
 * `reference`), for the Transfer screen's history. Quantities, outlets and
 * who/when only — no cost: this list is readable with `pos.stock_transfer`,
 * which a Storekeeper holds, and cost reporting stays `pos.stock_manage`.
 * With `outletId`, only transfers in or out of that outlet.
 */
async function listTransfers({ context, outletId, limit = 50 }) {
  const db = scopedDb().for(context);
  // Newest legs first; each transfer has two legs (one per outlet), so
  // twice the limit always reaches `limit` distinct transfers.
  let recentLegs = db.table('stock_movements').where({ type: 'transfer' });
  if (outletId) recentLegs = recentLegs.where({ outlet_id: outletId });
  const recent = await recentLegs.orderBy('id', 'desc').limit(limit * 2).select('reference');
  const references = [...new Set(recent.map((row) => row.reference).filter(Boolean))].slice(0, limit);
  if (!references.length) return [];

  const legs = await db
    .table('stock_movements')
    .joinScoped('stock_items', (join) => join.on('stock_items.id', '=', 'stock_movements.stock_item_id'))
    .joinScoped('pos_outlets', (join) => join.on('pos_outlets.id', '=', 'stock_movements.outlet_id'))
    .where({ 'stock_movements.type': 'transfer' })
    .whereIn('stock_movements.reference', references)
    .select(
      'stock_movements.id',
      'stock_movements.reference',
      'stock_movements.stock_item_id',
      'stock_movements.outlet_id',
      'stock_movements.quantity',
      'stock_movements.business_date',
      'stock_movements.reason',
      'stock_movements.user_id',
      'stock_movements.created_at',
      'stock_items.name as stock_item_name',
      'stock_items.unit as stock_item_unit',
      'pos_outlets.name as outlet_name',
    );

  const byReference = new Map();
  for (const leg of legs) {
    const entry = byReference.get(leg.reference) ?? { reference: leg.reference, lastId: 0 };
    entry.lastId = Math.max(entry.lastId, Number(leg.id));
    entry.stockItemId = leg.stock_item_id;
    entry.stockItemName = leg.stock_item_name;
    entry.unit = leg.stock_item_unit;
    entry.businessDate = leg.business_date;
    entry.note = leg.reason;
    entry.userId = leg.user_id;
    entry.createdAt = leg.created_at;
    const side = compareQuantity(leg.quantity, ZERO_QTY) < 0 ? 'from' : 'to';
    entry[side] = { outletId: leg.outlet_id, outletName: leg.outlet_name };
    if (side === 'to') entry.quantity = leg.quantity;
    byReference.set(leg.reference, entry);
  }
  return [...byReference.values()].sort((a, b) => b.lastId - a.lastId).map(({ lastId, ...rest }) => rest);
}

// ---------------------------------------------------------------------
// Stock takes — blind counting, the same structural guarantee
// `pos_shifts`' own cash-up already establishes. A take counts one outlet.
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
 * correction, not a duplicate. Any shared stock item may be counted: what
 * matters is the take's outlet, whose quantity it is compared against.
 */
async function recordStockTakeCount({ context, stockTakeId, stockItemId, countedQuantity }) {
  const db = scopedDb().for(context);
  const stockTake = await db.table('stock_takes').where({ id: stockTakeId }).first();
  if (!stockTake) throw new StockTakeNotFoundError();
  if (stockTake.status !== 'open') {
    throw new StockTakeNotOpenError(stockTakeId, stockTake.status);
  }

  // Existence check first, so a garbage id is a friendly error rather than
  // a bare FK-constraint 500.
  const stockItem = await db.table('stock_items').where({ id: stockItemId }).first();
  if (!stockItem) throw new StockItemNotFoundError();

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
 * then every counted item (shared lock-ordering helper), reads the take
 * outlet's live quantity of each under that same lock as the
 * `theoretical_quantity`, and posts a `count_adjustment` movement at that
 * outlet for any nonzero variance.
 */
async function completeStockTake({ trx, stockTakeId, userId }) {
  const stockTake = await trx.table('stock_takes').where({ id: stockTakeId }).forUpdate().first();
  if (!stockTake) throw new StockTakeNotFoundError();
  if (stockTake.status === 'completed') throw new StockTakeAlreadyCompletedError(stockTakeId);
  if (stockTake.status === 'cancelled') throw new StockTakeAlreadyCancelledError(stockTakeId);
  const outletId = stockTake.outlet_id;

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
    const level = await lockedLevel(trx, outletId, stockItemId);
    const theoreticalQuantity = level?.current_quantity ?? ZERO_QTY;
    const variance = sumQuantity([line.counted_quantity, negateQuantity(theoreticalQuantity)]);

    await trx.table('stock_take_lines').where({ id: line.id }).update({ theoretical_quantity: theoreticalQuantity, variance });

    if (compareQuantity(variance, ZERO_QTY) !== 0) {
      const totalCost = extendedCost(stockItem.purchase_cost, variance);
      await trx.table('stock_movements').insert({
        outlet_id: outletId,
        stock_item_id: stockItemId,
        type: 'count_adjustment',
        quantity: variance,
        unit_cost: stockItem.purchase_cost,
        total_cost: totalCost,
        business_date: businessDate,
        stock_take_id: stockTakeId,
        user_id: userId ?? null,
      });
      await recomputeStockLevel({ trx, stockItemId, outletId });
      changedStockItemIds.push(stockItemId);
    }
  }

  if (changedStockItemIds.length) await applyStockAvailabilityEffects({ trx, stockItemIds: changedStockItemIds, outletId });

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

/**
 * Gap closure — this function already existed but was never routed
 * anywhere (Goods Received's own tab had no way to show what it had just
 * recorded). Widened from "one stock item's history" to also accept
 * `outletId` alone, for a per-outlet delivery/movement feed; at least one
 * of the two is required, so a caller can never accidentally list every
 * movement at the property with no scope at all. Joined to `stock_items`
 * for `name`/`unit` — a plain movement row only carries `stock_item_id`,
 * and a since-archived item's name would otherwise be unresolvable from
 * the frontend's own currently-active-items lookup.
 */
async function listStockMovements({ context, stockItemId, outletId, type, dateFrom, dateTo, limit = 50 }) {
  if (!stockItemId && !outletId) {
    throw new ValidationError('MISSING_FIELD', 'Either "stock_item_id" or "outlet_id" is required.', [{ field: 'stock_item_id', issue: 'missing' }]);
  }
  const db = scopedDb().for(context);
  let query = db.table('stock_movements').joinScoped('stock_items', (join) => join.on('stock_items.id', '=', 'stock_movements.stock_item_id'));
  if (stockItemId) query = query.where({ 'stock_movements.stock_item_id': stockItemId });
  if (outletId) query = query.where({ 'stock_movements.outlet_id': outletId });
  if (type) query = query.where({ 'stock_movements.type': type });
  if (dateFrom) query = query.where('stock_movements.business_date', '>=', dateFrom);
  if (dateTo) query = query.where('stock_movements.business_date', '<=', dateTo);
  return query
    .select('stock_movements.*', 'stock_items.name as stock_item_name', 'stock_items.unit as stock_item_unit', 'stock_items.category as stock_item_category')
    .orderBy('stock_movements.id', 'desc')
    .limit(limit);
}

module.exports = {
  lockStockItemsSorted,
  resolveLockClosure,
  recomputeStockLevel,
  applyStockAvailabilityEffects,
  assertStockAvailableOrOverridden,
  AUTOMATIC_OVERRIDE_REASON_GUEST_ACKNOWLEDGED,
  AUTOMATIC_OVERRIDE_REASON_ROOM_CHARGE_OTP,
  AUTOMATIC_OVERRIDE_REASON_CARD_CAPTURE,
  deductStockForSettlement,
  reverseStockForSettlement,
  listStockItemCategories,
  getStockItemCategory,
  createStockItemCategory,
  updateStockItemCategory,
  archiveStockItemCategory,
  listStockItems,
  listStockLevels,
  getStockItem,
  createStockItem,
  updateStockItem,
  archiveStockItem,
  listMenuItemComponents,
  listMenuItemLinks,
  upsertMenuItemComponents,
  recordGoodsReceived,
  recordWastage,
  transferStock,
  listTransfers,
  listStockTakes,
  getStockTake,
  openStockTake,
  recordStockTakeCount,
  completeStockTake,
  cancelStockTake,
  listStockMovements,
};
