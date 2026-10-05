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
const { notifyStaff, roleReceivesEvent } = require('../notifications/staff-notifications');
const { recordAuditEntry } = require('../../audit');
const outletMenu = require('../../shared/outlet-menu');
const { STORE_OUTLET_TYPE, isSupermarketOutlet } = require('../../shared/outlet-types');
const { outletScopeForUser, scopeCovers } = require('../../shared/outlet-assignments');
const { sumQuantity, negateQuantity, multiplyQuantityByInteger, compareQuantity, extendedCost, toQtyUnits } = require('../../shared/quantity');
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
  ReceiveAtStoreOnlyError,
  SupermarketRequestMustComeFromStoreError,
  RequestItemNotAtOutletError,
  StockTakeCannotRaiseStockError,
  SameOutletTransferError,
  StockTransferRequestNotFoundError,
  StockTransferRequestNotPendingError,
  NothingIssuedError,
  InsufficientStockForIssueError,
  TopUpRequiresShortIssueError,
  RequestAlreadyToppedUpError,
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
const AUTOMATIC_OVERRIDE_REASON_SUPERMARKET = 'Supermarket sale at zero or low recorded stock — allowed at the till; the low-stock alert is the control.';
// A supermarket sale that takes stock BELOW zero is refused unless the cashier
// confirmed the oversell at the till; this is the reason a confirmed one carries
// (the audit row also names the cashier). Selling exactly the last units, or at
// zero-or-low stock without going below zero, keeps the automatic reason above.
const CONFIRMED_OVERSELL_REASON_SUPERMARKET = 'Supermarket oversell confirmed at the till by the cashier (the sale takes recorded stock below zero).';
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
  // A supermarket never switches an item off because of stock: an oversell is
  // warned and confirmed at the till instead (supermarket/service.js), so the
  // queue never stalls on a wrong count. An item this mechanism switched off
  // before (stock_auto_unavailable) is switched back on; a manual Sold out is
  // never touched. Every other outlet type keeps the behaviour below unchanged.
  const outletRow = await trx.table('pos_outlets').where({ id: outletId }).first('type');
  const supermarket = isSupermarketOutlet(outletRow);

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

    if (supermarket) {
      if (!available && autoOff) await outletMenu.upsertOutletMenuSetting(trx, outletId, menuItemId, { is_available: true, stock_auto_unavailable: false });
      continue;
    }
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
 * The stock items `lines` would take BELOW zero at `outletId` (read-only; the
 * same recipe arithmetic as the override guard, so two products sharing a
 * stock item are counted together). Taking stock to exactly zero is not a
 * shortfall. Used by the supermarket till's oversell confirmation; a plain
 * read with the same tolerated race as the guard (a concurrent sale may pass
 * too; stock may then go further negative, never blocked).
 *
 * @returns {Promise<Array<{stockItemId: number, name: string, unit: string, onHand: string, needed: string, projectedQuantity: string}>>}
 */
async function findStockShortfalls({ trx, lines, outletId }) {
  const deductionByStockItem = await computeStockDeductionsForLines({ trx, lines });
  if (deductionByStockItem.size === 0) return [];
  const stockItemIds = [...deductionByStockItem.keys()];
  const items = await trx.table('stock_items').whereIn('id', stockItemIds).select('id', 'name', 'unit');
  const levels = await trx.table('stock_levels').where({ outlet_id: outletId }).whereIn('stock_item_id', stockItemIds).select('stock_item_id', 'current_quantity');
  const onHandByItem = new Map(levels.map((row) => [String(row.stock_item_id), row.current_quantity]));
  const shortfalls = [];
  for (const item of items) {
    const onHand = onHandByItem.get(String(item.id)) ?? ZERO_QTY;
    const needed = deductionByStockItem.get(Number(item.id));
    const projectedQuantity = sumQuantity([onHand, negateQuantity(needed)]);
    if (compareQuantity(projectedQuantity, ZERO_QTY) < 0) shortfalls.push({ stockItemId: Number(item.id), name: item.name, unit: item.unit, onHand, needed, projectedQuantity });
  }
  return shortfalls.sort((a, b) => a.stockItemId - b.stockItemId);
}

/**
 * How many whole units of each menu item `outletId` can still sell from its
 * recorded stock: the fewest any recipe component allows (floor of level ÷
 * per-unit quantity, never below 0). A menu item with no recipe is not
 * stock-tracked and maps to null. Read-only, for the supermarket till.
 *
 * @returns {Promise<Map<string, number|null>>} keyed by menu item id (string)
 */
async function unitsOnHandForMenuItems({ trx, menuItemIds, outletId }) {
  const result = new Map(menuItemIds.map((id) => [String(id), null]));
  if (menuItemIds.length === 0) return result;
  const components = await trx.table('pos_menu_item_components').whereIn('menu_item_id', menuItemIds).select('menu_item_id', 'stock_item_id', 'quantity');
  if (components.length === 0) return result;
  const stockItemIds = [...new Set(components.map((row) => Number(row.stock_item_id)))];
  const levels = await trx.table('stock_levels').where({ outlet_id: outletId }).whereIn('stock_item_id', stockItemIds).select('stock_item_id', 'current_quantity');
  const onHandByItem = new Map(levels.map((row) => [String(row.stock_item_id), toQtyUnits(row.current_quantity)]));
  for (const component of components) {
    const perUnit = toQtyUnits(component.quantity);
    const onHand = onHandByItem.get(String(component.stock_item_id)) ?? 0n;
    const units = perUnit > 0n && onHand > 0n ? Number(onHand / perUnit) : 0;
    const key = String(component.menu_item_id);
    const current = result.get(key);
    result.set(key, current === null ? units : Math.min(current, units));
  }
  return result;
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
async function createStockItemCategory({ context, db: providedDb, outletId, name, sortOrder }) {
  // `db` (optional): an accessor already inside a transaction joins it, as in createStockItem.
  const db = providedDb ?? scopedDb().for(context);
  if (outletId) await assertOutlet(db, outletId);
  const category = await stockCategoryCatalogue.createCategory({ context, db, name, sortOrder });
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
/**
 * `carriedOnly` (the supermarket request form): only items in a category the outlet CARRIES, leaving out items
 * the outlet merely holds a stock level for (for example hotel drinks a mart still holds from before it was
 * cleaned up), so "the outlet's own products" means exactly its categories.
 */
async function listStockItems({ context, outletId, lowStockOnly, carriedOnly = false }) {
  const db = scopedDb().for(context);
  const items = await db.table('stock_items').where({ status: 'active' }).orderBy('name');
  let rows = items;
  if (outletId) {
    const carried = new Set((await outletMenu.carriedCategoryNames(db, outletId)).map(nameKey));
    const levels = await db.table('stock_levels').where({ outlet_id: outletId });
    const levelByItem = new Map(levels.map((row) => [String(row.stock_item_id), row]));
    rows = items
      .filter((item) => (item.category && carried.has(nameKey(item.category))) || (!carriedOnly && levelByItem.has(String(item.id))))
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
async function createStockItem({ context, db: providedDb, outletId, name, unit, category, purchaseCost, supplier, reorderLevel }) {
  // `db` (optional): an accessor already inside a transaction joins it (the supermarket product import's one transaction).
  const db = providedDb ?? scopedDb().for(context);
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
async function upsertMenuItemComponents({ context, db: providedDb, menuItemId, components }) {
  // `db` (optional): an accessor already inside a transaction joins it, as in createStockItem.
  const db = providedDb ?? scopedDb().for(context);
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
 * Once a property has a store room, supplier deliveries are received THERE
 * and reach a bar/restaurant by a stock request or transfer. Receiving at the
 * outlet as well would add stock with nothing leaving the store, counting the
 * same goods twice. A property with no store room at all keeps receiving
 * directly at its outlets, exactly as before.
 *
 * A supermarket is exempt ONLY for its opening stock (`openingStock`, passed
 * by the product import and by nothing else): after that its stock rises by
 * a store-approved request or transfer, like any other outlet's.
 */
async function assertReceivableOutlet(db, outlet, { openingStock = false } = {}) {
  if (outlet.type === STORE_OUTLET_TYPE || (openingStock && isSupermarketOutlet(outlet))) return;
  const stores = await db.table('pos_outlets').where({ type: STORE_OUTLET_TYPE, status: 'active' }).orderBy('name');
  if (stores.length === 0) return;
  throw new ReceiveAtStoreOnlyError({ outletId: outlet.id, outletName: outlet.name, storeNames: stores.map((store) => store.name) });
}

/**
 * `trx`-based, called from `runIdempotentMutation` — a real delivery,
 * financial in effect (it moves `purchase_cost`, ARCHITECTURE.md §7).
 * `lines`: `[{stockItemId, quantity, unitCost}]`, received INTO `outletId`
 * (stock items are shared; the delivery adds to that outlet's quantity).
 */
async function recordGoodsReceived({ trx, outletId, lines, reference, userId, businessDate, openingStock = false }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('MISSING_FIELD', 'At least one line is required.', [{ field: 'lines', issue: 'missing' }]);
  }
  const outlet = await assertOutlet(trx, outletId);
  await assertReceivableOutlet(trx, outlet, { openingStock });

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
 * is no confirm-on-receipt step. An outlet can ask for stock first through a
 * transfer request (below); issuing one calls this function per line. The two legs share a
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
// Transfer requests — an outlet asks, the storekeeper issues
// ---------------------------------------------------------------------

/**
 * User-requested, confirmed decisions: one request lists several items;
 * POS operators and managers raise it (`pos.stock_request`); whoever
 * issues stock (`pos.stock_transfer` — the Storekeeper) approves it in the
 * same step by issuing it, in full or in part, or rejects it with a
 * reason; stock moves the moment it is issued, through `transferStock`
 * itself, so an issued line IS a transfer — same two ledger legs, same
 * cost, same refusal to take the source below zero, same alerts. There is
 * no receipt step and no in-transit state.
 *
 * A request is decided exactly once (`pending` -> `issued` | `rejected` |
 * `cancelled`). Every decision takes a row lock on the request header
 * FIRST, then re-reads its status under that lock, so two storekeepers
 * issuing the same request — or an issue racing the requester's cancel —
 * resolve to one decision and one set of transfers, never two.
 */

/** The request header joined to both outlets' names and the requester's/decider's names, plus its lines. */
async function loadTransferRequests(db, { ids, status, outletId, limit, scope = null }) {
  let headers = db.table('stock_transfer_requests');
  if (ids) headers = headers.whereIn('id', ids);
  // A staff member limited to some outlets sees only requests to or from them.
  if (scope) headers = headers.where((builder) => builder.whereIn('from_outlet_id', scope).orWhereIn('to_outlet_id', scope));
  if (status) headers = headers.where({ status });
  if (outletId) headers = headers.where((builder) => builder.where({ from_outlet_id: outletId }).orWhere({ to_outlet_id: outletId }));
  headers = headers.orderBy('id', 'desc');
  if (limit) headers = headers.limit(limit);
  const rows = await headers.select('*');
  if (!rows.length) return [];

  // Names by id, in two small lookups — the accessor joins by table name,
  // and each request names two outlets and up to two users.
  const outletIds = [...new Set(rows.flatMap((row) => [String(row.from_outlet_id), String(row.to_outlet_id)]))];
  const outlets = new Map((await db.table('pos_outlets').whereIn('id', outletIds).select('id', 'name', 'type')).map((row) => [String(row.id), row]));
  const userIds = [...new Set(rows.flatMap((row) => [row.requested_by_user_id, row.decided_by_user_id]).filter(Boolean).map(String))];
  const users = new Map((await db.table('users').whereIn('id', userIds).select('id', 'first_name', 'last_name')).map((row) => [String(row.id), row]));

  const lines = await db
    .table('stock_transfer_request_lines')
    .joinScoped('stock_items', (join) => join.on('stock_items.id', '=', 'stock_transfer_request_lines.stock_item_id'))
    .whereIn('stock_transfer_request_lines.request_id', rows.map((row) => row.id))
    .orderBy('stock_items.name', 'asc')
    .select(
      'stock_transfer_request_lines.*',
      'stock_items.name as stock_item_name',
      'stock_items.unit as stock_item_unit',
      'stock_items.status as stock_item_status',
    );

  // What the supplying outlet holds right now, for pending requests only —
  // the issue form's starting point. Quantities, never cost: this list is
  // readable by a requester (`pos.stock_request`) and a storekeeper alike.
  const pending = rows.filter((row) => row.status === 'pending');
  const onHand = new Map();
  if (pending.length) {
    const levels = await db
      .table('stock_levels')
      .whereIn('outlet_id', [...new Set(pending.map((row) => String(row.from_outlet_id)))])
      .whereIn('stock_item_id', [...new Set(lines.map((line) => String(line.stock_item_id)))])
      .select('outlet_id', 'stock_item_id', 'current_quantity');
    for (const level of levels) onHand.set(`${level.outlet_id}:${level.stock_item_id}`, level.current_quantity);
  }

  // Top-ups of these requests (a top-up has the same two outlets as the
  // request it tops up, so whoever may see one may see the other).
  const topUpsOf = new Map();
  const topUps = await db
    .table('stock_transfer_requests')
    .whereIn('top_up_of_request_id', rows.map((row) => row.id))
    .orderBy('id', 'asc')
    .select('id', 'status', 'top_up_of_request_id');
  for (const topUp of topUps) {
    const list = topUpsOf.get(String(topUp.top_up_of_request_id)) ?? [];
    list.push({ id: topUp.id, status: topUp.status });
    topUpsOf.set(String(topUp.top_up_of_request_id), list);
  }

  const nameOf = (userId) => {
    const user = users.get(String(userId));
    return user ? [user.first_name, user.last_name].filter(Boolean).join(' ') || null : null;
  };
  const outletOf = (outletId) => {
    const outlet = outlets.get(String(outletId));
    return { id: outletId, name: outlet?.name ?? null, type: outlet?.type ?? null };
  };
  const linesByRequest = new Map();
  for (const line of lines) {
    const list = linesByRequest.get(String(line.request_id)) ?? [];
    list.push(line);
    linesByRequest.set(String(line.request_id), list);
  }
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    note: row.note,
    topUpOfRequestId: row.top_up_of_request_id ?? null,
    topUps: topUpsOf.get(String(row.id)) ?? [],
    fromOutlet: outletOf(row.from_outlet_id),
    toOutlet: outletOf(row.to_outlet_id),
    requestedBy: { userId: row.requested_by_user_id, name: nameOf(row.requested_by_user_id) },
    requestedAt: row.requested_at,
    decidedBy: row.decided_by_user_id ? { userId: row.decided_by_user_id, name: nameOf(row.decided_by_user_id) } : null,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    businessDate: row.business_date,
    lines: (linesByRequest.get(String(row.id)) ?? []).map((line) => ({
      stockItemId: line.stock_item_id,
      name: line.stock_item_name,
      unit: line.stock_item_unit,
      archived: line.stock_item_status !== 'active',
      quantityRequested: line.quantity_requested,
      quantityIssued: line.quantity_issued,
      transferReference: line.transfer_reference,
      availableAtSource: row.status === 'pending' ? onHand.get(`${row.from_outlet_id}:${line.stock_item_id}`) ?? ZERO_QTY : null,
    })),
  }));
}

async function listTransferRequests({ context, status, outletId, limit = 50 }) {
  const db = scopedDb().for(context);
  return loadTransferRequests(db, { status, outletId, limit, scope: await outletScopeForUser(db, context.userId) });
}

async function getTransferRequest({ context, id }) {
  const db = scopedDb().for(context);
  const [request] = await loadTransferRequests(db, { ids: [id], scope: await outletScopeForUser(db, context.userId) });
  return request ?? null;
}

/**
 * The pending requests waiting on the caller — what the sign-in reminder
 * pops up (user-requested: a pending request shows once each time the
 * storekeeper signs in, until it is issued, rejected or withdrawn). The
 * same people the "Stock requested" alert reaches: the caller's role is on
 * this property's recipient list for it (Setup → Notifications), and they
 * cover the SUPPLYING outlet — a storekeeper tied to one store is not
 * reminded of another store's requests, nor of requests delivered to their
 * own. Oldest first, at most 50.
 */
async function listRequestsAwaitingMe({ context }) {
  const db = scopedDb().for(context);
  if (!(await roleReceivesEvent({ db, eventType: 'stock.transfer_requested', userId: context.userId }))) return [];
  const scope = await outletScopeForUser(db, context.userId);
  let pending = db.table('stock_transfer_requests').where({ status: 'pending' });
  if (scope) pending = pending.whereIn('from_outlet_id', scope);
  const ids = (await pending.orderBy('id', 'asc').limit(50).select('id')).map((row) => row.id);
  if (!ids.length) return [];
  return (await loadTransferRequests(db, { ids })).reverse();
}

/** The outlets the caller covers for stock requests: `{restricted: false}` or `{restricted: true, outletIds}`. */
async function getMyRequestOutlets({ context }) {
  const scope = await outletScopeForUser(scopedDb().for(context), context.userId);
  return scope ? { restricted: true, outletIds: scope } : { restricted: false, outletIds: null };
}

/**
 * Locks the request header (every decision takes this lock first), hides a
 * request outside the caller's outlets as not found (never "forbidden",
 * which would confirm it exists), and requires it to still be pending.
 */
async function lockPendingRequest(trx, requestId, userId) {
  const request = await trx.table('stock_transfer_requests').where({ id: requestId }).forUpdate().first();
  if (!request) throw new StockTransferRequestNotFoundError();
  if (!scopeCovers(await outletScopeForUser(trx, userId), [request.from_outlet_id, request.to_outlet_id])) {
    throw new StockTransferRequestNotFoundError();
  }
  if (request.status !== 'pending') throw new StockTransferRequestNotPendingError(Number(requestId), request.status);
  return request;
}

/**
 * A top-up ("Request the rest", user-requested) is an ordinary new request
 * that names the ISSUED-SHORT request it asks the rest of. The request it
 * tops up stays decided — the store never sends more against it — so the
 * paper trail remains one decision per request.
 *
 * Refused unless: the original is visible to the caller (404 otherwise,
 * never "forbidden"); it was issued with at least one line sent short; the
 * top-up goes between the same two outlets; and no other top-up of it is
 * pending or issued (a rejected or withdrawn one frees the shortfall to be
 * asked for again). The lines are the requester's own — the form starts
 * from the shortfall but may ask for less, drop lines or add items.
 *
 * The original's header is locked FIRST, then its top-ups are read with a
 * LOCKING read: under REPEATABLE READ a plain read would reuse the snapshot
 * taken at this transaction's first read (the idempotency-key lookup,
 * before the lock was granted) and miss a top-up committed while this one
 * waited — two "Request the rest" clicks would then both land.
 */
async function assertCanTopUp(trx, { topUpOfRequestId, fromOutletId, toOutletId, userId }) {
  const original = await trx.table('stock_transfer_requests').where({ id: topUpOfRequestId }).forUpdate().first();
  if (!original) throw new StockTransferRequestNotFoundError();
  if (!scopeCovers(await outletScopeForUser(trx, userId), [original.from_outlet_id, original.to_outlet_id])) {
    throw new StockTransferRequestNotFoundError();
  }
  if (String(original.from_outlet_id) !== String(fromOutletId) || String(original.to_outlet_id) !== String(toOutletId)) {
    throw new ValidationError('TOP_UP_OUTLETS_MISMATCH', 'A top-up goes between the same two outlets as the request it tops up.', [
      { field: 'top_up_of_request_id', issue: 'outlets_mismatch' },
    ]);
  }
  if (original.status !== 'issued') throw new TopUpRequiresShortIssueError(Number(original.id), original.status);
  const lines = await trx.table('stock_transfer_request_lines').where({ request_id: original.id }).select('quantity_requested', 'quantity_issued');
  if (!lines.some((line) => compareQuantity(line.quantity_issued ?? ZERO_QTY, line.quantity_requested) < 0)) {
    throw new TopUpRequiresShortIssueError(Number(original.id), original.status);
  }
  const live = await trx
    .table('stock_transfer_requests')
    .where({ top_up_of_request_id: original.id })
    .whereIn('status', ['pending', 'issued'])
    .orderBy('id', 'asc')
    .forUpdate()
    .first();
  if (live) throw new RequestAlreadyToppedUpError(Number(original.id), Number(live.id), live.status);
}

/**
 * `trx`-based, from `runIdempotentMutation`. `lines` is `[{stockItemId,
 * quantity}]`, already shape-checked by the controller (positive, at most
 * 3 decimals). Stock availability is NOT checked here — asking for more
 * than the store holds is a legitimate request; the issue decides what can
 * actually be sent.
 */
async function createTransferRequest({ trx, fromOutletId, toOutletId, lines, note, userId, topUpOfRequestId = null }) {
  if (String(fromOutletId) === String(toOutletId)) throw new SameOutletTransferError();
  if (topUpOfRequestId) await assertCanTopUp(trx, { topUpOfRequestId, fromOutletId, toOutletId, userId });
  const fromOutlet = await assertOutlet(trx, fromOutletId);
  const toOutlet = await assertOutlet(trx, toOutletId);
  // Staff tied to outlets ask for stock for their own outlet only.
  const scope = await outletScopeForUser(trx, userId);
  if (scope && !scope.includes(String(toOutletId))) {
    throw new ValidationError('OUTLET_NOT_ASSIGNED', 'You can only request stock for an outlet you are assigned to.', [
      { field: 'to_outlet_id', issue: 'not_assigned' },
    ]);
  }

  const ids = lines.map((line) => String(line.stockItemId));
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('DUPLICATE_STOCK_ITEM', 'Each stock item can appear only once on a request — combine the quantities.', [{ field: 'lines', issue: 'duplicate' }]);
  }
  const items = await trx.table('stock_items').whereIn('id', ids).select('id', 'status', 'name', 'category');
  const activeIds = new Set(items.filter((item) => item.status === 'active').map((item) => String(item.id)));
  if (ids.some((id) => !activeIds.has(id))) throw new StockItemNotFoundError();

  // A mart cashier (staff tied to a supermarket) asks the STORE for the MART'S OWN products only: not another
  // outlet's items, even when the store holds those too. Everyone else (full access, or a bar/restaurant
  // operator) keeps the flexible request.
  if (scope && isSupermarketOutlet(toOutlet)) {
    if (fromOutlet.type !== STORE_OUTLET_TYPE) {
      const stores = await trx.table('pos_outlets').where({ type: STORE_OUTLET_TYPE, status: 'active' }).orderBy('name');
      throw new SupermarketRequestMustComeFromStoreError(stores.map((store) => store.name));
    }
    // The mart's own products are the items in the categories it CARRIES (not items it merely holds a level for,
    // such as hotel drinks left from before it was cleaned up): the same rule as the form's list (`carriedOnly`).
    const carried = new Set((await outletMenu.carriedCategoryNames(trx, toOutletId)).map(nameKey));
    const foreign = items.filter((item) => !(item.category && carried.has(nameKey(item.category))));
    if (foreign.length) throw new RequestItemNotAtOutletError({ outletName: toOutlet.name, itemNames: foreign.map((item) => item.name) });
  }

  const [requestId] = await trx.table('stock_transfer_requests').insert({
    from_outlet_id: fromOutletId,
    to_outlet_id: toOutletId,
    status: 'pending',
    note: note || null,
    top_up_of_request_id: topUpOfRequestId || null,
    requested_by_user_id: userId,
  });
  for (const line of lines) {
    await trx.table('stock_transfer_request_lines').insert({
      request_id: requestId,
      stock_item_id: line.stockItemId,
      quantity_requested: line.quantity,
    });
  }

  await notifyStaff({
    trx,
    eventType: 'stock.transfer_requested',
    popup: true, // user-requested: a stock request pops up (and beeps) rather than only counting in the bell
    payload: {
      requestId: Number(requestId),
      fromOutletName: fromOutlet.name,
      toOutletName: toOutlet.name,
      lineCount: lines.length,
      topUpOfRequestId: topUpOfRequestId ? Number(topUpOfRequestId) : null,
    },
    outletIds: [fromOutletId], // the storekeepers at the supplying store, not every storekeeper
  });
  const [request] = await loadTransferRequests(trx, { ids: [requestId] });
  return request;
}

/**
 * Issues a pending request: one `transferStock` per line with a quantity
 * above zero, all in the caller's one transaction — if any line cannot be
 * sent (the source holds less than that line's quantity, or its item was
 * archived since the request was raised) NOTHING is issued and the error
 * names every such line; the storekeeper lowers them and issues again. `lines` must
 * name every line of the request exactly once, `quantity` between 0 and
 * what was asked (a line sent short is recorded as short, never over).
 *
 * Lock order: the request header (every decision's first lock), then the
 * FULL stock-item closure of every line being issued, ascending, in one
 * `lockStockItemsSorted` call — the same global order every stock writer
 * uses, so two requests issuing overlapping items in different orders
 * cannot deadlock. Each `transferStock` then re-locks rows this
 * transaction already holds (instant) before its own source-level check.
 */
async function issueTransferRequest({ trx, requestId, lines, note, userId, businessDate }) {
  const request = await lockPendingRequest(trx, requestId, userId);
  const requestLines = await trx.table('stock_transfer_request_lines').where({ request_id: requestId }).select('id', 'stock_item_id', 'quantity_requested');

  const byItem = new Map(requestLines.map((line) => [String(line.stock_item_id), line]));
  const given = new Map();
  for (const line of lines) {
    const key = String(line.stockItemId);
    if (!byItem.has(key) || given.has(key)) {
      throw new ValidationError('ISSUE_LINES_MISMATCH', 'Give one quantity for each item on the request — no other items.', [{ field: 'lines', issue: 'mismatch' }]);
    }
    if (compareQuantity(line.quantity, byItem.get(key).quantity_requested) > 0) {
      throw new ValidationError('QUANTITY_EXCEEDS_REQUEST', 'You cannot issue more than was requested. Raise a new request for anything extra.', [
        { field: 'lines', issue: 'exceeds_request', stockItemId: Number(key) },
      ]);
    }
    given.set(key, line.quantity);
  }
  if (given.size !== byItem.size) {
    throw new ValidationError('ISSUE_LINES_MISMATCH', 'Give one quantity for each item on the request — no other items.', [{ field: 'lines', issue: 'mismatch' }]);
  }

  const toSend = [...given.entries()].filter(([, quantity]) => compareQuantity(quantity, ZERO_QTY) > 0).sort(([a], [b]) => Number(a) - Number(b));
  if (!toSend.length) throw new NothingIssuedError();

  const lockClosure = await resolveLockClosure({ trx, stockItemIds: toSend.map(([id]) => id) });
  const locked = await lockStockItemsSorted({ trx, stockItemIds: lockClosure });
  for (const [id] of toSend) {
    const item = locked.get(String(Number(id)));
    if (item.status !== 'active') {
      throw new ValidationError('STOCK_ITEM_ARCHIVED', `"${item.name}" has been archived since this request was raised — issue 0 of it.`, [
        { field: 'lines', issue: 'archived', stockItemId: Number(id) },
      ]);
    }
  }

  // Every line is checked against the source, under the locks just taken,
  // BEFORE anything is written — so a refusal names every short line at
  // once and never leaves part of the request sent. `transferStock`
  // re-checks each line itself (same locks, same answer).
  const shortLines = [];
  for (const [id, quantity] of toSend) {
    const available = (await lockedLevel(trx, request.from_outlet_id, id))?.current_quantity ?? ZERO_QTY;
    if (compareQuantity(available, quantity) < 0) {
      const item = locked.get(String(Number(id)));
      shortLines.push({ stockItemId: Number(id), name: item.name, unit: item.unit, available, requested: quantity });
    }
  }
  if (shortLines.length) throw new InsufficientStockForIssueError(shortLines);

  const movementNote = `Request #${request.id}${note ? ` — ${note}` : ''}`.slice(0, 255);
  const references = new Map();
  for (const [id, quantity] of toSend) {
    const transfer = await transferStock({
      trx,
      stockItemId: id,
      fromOutletId: request.from_outlet_id,
      toOutletId: request.to_outlet_id,
      quantity,
      note: movementNote,
      userId,
      businessDate,
    });
    references.set(id, transfer.reference);
  }

  for (const line of requestLines) {
    const key = String(line.stock_item_id);
    await trx
      .table('stock_transfer_request_lines')
      .where({ id: line.id })
      .update({ quantity_issued: given.get(key), transfer_reference: references.get(key) ?? null });
  }
  await trx.table('stock_transfer_requests').where({ id: request.id }).update({
    status: 'issued',
    decided_by_user_id: userId,
    decided_at: new Date(),
    decision_note: note || null,
    business_date: businessDate,
  });

  const [issued] = await loadTransferRequests(trx, { ids: [request.id] });
  const shortLineCount = issued.lines.filter((line) => compareQuantity(line.quantityIssued, line.quantityRequested) < 0).length;
  await notifyStaff({
    trx,
    eventType: 'stock.transfer_request_issued',
    popup: true, // user-requested: a stock request pops up (and beeps) rather than only counting in the bell
    outletIds: [request.to_outlet_id], // the staff at the outlet that asked...
    alsoUserIds: [request.requested_by_user_id], // ...and whoever asked
    payload: {
      requestId: Number(request.id),
      fromOutletName: issued.fromOutlet.name,
      toOutletName: issued.toOutlet.name,
      lineCount: issued.lines.length,
      shortLineCount,
    },
  });
  return issued;
}

/** Rejects a pending request; `reason` is required (the controller enforces it) and tells the requester why. */
async function rejectTransferRequest({ trx, requestId, reason, userId }) {
  const request = await lockPendingRequest(trx, requestId, userId);
  await trx.table('stock_transfer_requests').where({ id: request.id }).update({
    status: 'rejected',
    decided_by_user_id: userId,
    decided_at: new Date(),
    decision_note: reason,
  });
  const [rejected] = await loadTransferRequests(trx, { ids: [request.id] });
  await notifyStaff({
    trx,
    eventType: 'stock.transfer_request_rejected',
    popup: true, // user-requested: a stock request pops up (and beeps) rather than only counting in the bell
    outletIds: [request.to_outlet_id],
    alsoUserIds: [request.requested_by_user_id],
    payload: { requestId: Number(request.id), fromOutletName: rejected.fromOutlet.name, toOutletName: rejected.toOutlet.name, reason },
  });
  return rejected;
}

/** Withdraws a pending request (a requester changed their mind). No stock effect; the storekeeper's pending list simply loses it. */
async function cancelTransferRequest({ trx, requestId, reason, userId }) {
  const request = await lockPendingRequest(trx, requestId, userId);
  await trx.table('stock_transfer_requests').where({ id: request.id }).update({
    status: 'cancelled',
    decided_by_user_id: userId,
    decided_at: new Date(),
    decision_note: reason || null,
  });
  const [cancelled] = await loadTransferRequests(trx, { ids: [request.id] });
  return cancelled;
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
 * outlet for any nonzero variance. At a non-store outlet in a property that
 * has a store room, a count that would RAISE stock is refused (all lines are
 * checked first; nothing is written) — see `StockTakeCannotRaiseStockError`.
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

  // Pass 1, under the locks and before anything is written: the expected
  // quantity of every line, so a refusal names every offending line and
  // leaves the take open and the stock untouched.
  const counted = [];
  for (const line of lines) {
    const stockItemId = Number(line.stock_item_id);
    const stockItem = lockedById.get(String(stockItemId));
    const level = await lockedLevel(trx, outletId, stockItemId);
    const theoreticalQuantity = level?.current_quantity ?? ZERO_QTY;
    const variance = sumQuantity([line.counted_quantity, negateQuantity(theoreticalQuantity)]);
    counted.push({ line, stockItemId, stockItem, theoreticalQuantity, variance });
  }

  // Once a property has a store room, an outlet's stock only goes UP by a
  // request or transfer from the store, never by a count. A count that
  // matches or lowers stock is fine everywhere.
  const outlet = await trx.table('pos_outlets').where({ id: outletId }).first();
  if (outlet && outlet.type !== STORE_OUTLET_TYPE) {
    const stores = await trx.table('pos_outlets').where({ type: STORE_OUTLET_TYPE, status: 'active' }).orderBy('name');
    const raising = counted.filter((row) => compareQuantity(row.variance, ZERO_QTY) > 0);
    if (stores.length > 0 && raising.length > 0) {
      throw new StockTakeCannotRaiseStockError({
        outletId: outlet.id,
        outletName: outlet.name,
        storeNames: stores.map((store) => store.name),
        lines: raising.map((row) => ({
          stockItemId: row.stockItemId,
          name: row.stockItem.name,
          unit: row.stockItem.unit,
          counted: row.line.counted_quantity,
          onHand: row.theoreticalQuantity,
        })),
      });
    }
  }

  const changedStockItemIds = [];
  for (const { line, stockItemId, stockItem, theoreticalQuantity, variance } of counted) {
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
  AUTOMATIC_OVERRIDE_REASON_SUPERMARKET,
  CONFIRMED_OVERSELL_REASON_SUPERMARKET,
  findStockShortfalls,
  unitsOnHandForMenuItems,
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
  listTransferRequests,
  getTransferRequest,
  listRequestsAwaitingMe,
  getMyRequestOutlets,
  createTransferRequest,
  issueTransferRequest,
  rejectTransferRequest,
  cancelTransferRequest,
  listStockTakes,
  getStockTake,
  openStockTake,
  recordStockTakeCount,
  completeStockTake,
  cancelStockTake,
  listStockMovements,
};
