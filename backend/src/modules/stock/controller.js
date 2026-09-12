'use strict';

/**
 * HTTP layer for the stock module — parses the request, calls the
 * service, shapes the API.md §2 envelope. No business logic here; see
 * `service.js`. Mirrors `pos/controller.js`'s exact conventions.
 *
 * Goods-received, wastage, and stock-take completion all go through
 * `runIdempotentMutation` — each is a real inventory-affecting mutation
 * (ARCHITECTURE.md §7's "every financial mutation," extended here to
 * every real quantity-affecting one). Stock item CRUD, recipe upsert,
 * stock-take open/count/cancel are not idempotency-gated — each is either
 * plain configuration (naturally idempotent on retry, the same
 * `configureOverbookingThreshold`/group-blocks precedent) or already made
 * safe by its own upsert/gap-lock shape.
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { runIdempotentMutation } = require('../../shared/mutation');
const service = require('./service');
const reporting = require('./reporting');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

// ---------------------------------------------------------------------
// Stock items
// ---------------------------------------------------------------------

async function listStockItems(req, res, next) {
  try {
    const lowStockOnly = req.query.low_stock === 'true' || req.query.low_stock === '1';
    res.status(200).json(ok(await service.listStockItems({ context: req.context, outletId: req.query.outlet_id, lowStockOnly })));
  } catch (error) {
    next(error);
  }
}

async function createStockItem(req, res, next) {
  try {
    const outletId = require_(req.body, 'outlet_id');
    const name = require_(req.body, 'name');
    const unit = require_(req.body, 'unit');
    const item = await service.createStockItem({
      context: req.context,
      outletId,
      name,
      unit,
      purchaseCost: req.body?.purchase_cost,
      supplier: req.body?.supplier,
      reorderLevel: req.body?.reorder_level,
    });
    await req.audit({ entityType: 'stock_items', entityId: item.id, action: 'create', afterState: item });
    res.status(201).json(ok(item));
  } catch (error) {
    next(error);
  }
}

/**
 * Allowlists what a plain PATCH may change on a stock item — the same
 * `pickRoomTypeChanges`/`pickPropertyChanges` shape (`setup/controller.js`).
 * `current_quantity` and `purchase_cost` are deliberately excluded: this
 * module's entire design rests on `current_quantity` having exactly one
 * writer (`recomputeStockItemQuantity`, always re-derived from the real
 * `stock_movements` ledger) and `purchase_cost` having exactly one writer
 * (`recordGoodsReceived`, last-cost). A raw passthrough here would let a
 * plain edit silently disagree with both. `outlet_id`/`status` are also
 * excluded — moving outlets or archiving both go through their own,
 * narrower actions (recreate, or the dedicated archive endpoint) rather
 * than an unvalidated field on a general update.
 */
function pickStockItemChanges(body) {
  const changes = {};
  if (body?.name !== undefined) changes.name = body.name;
  if (body?.unit !== undefined) changes.unit = body.unit;
  if (body?.supplier !== undefined) changes.supplier = body.supplier;
  if (body?.reorder_level !== undefined) changes.reorder_level = body.reorder_level;
  return changes;
}

async function updateStockItem(req, res, next) {
  try {
    const before = await service.getStockItem({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const item = await service.updateStockItem({ context: req.context, id: req.params.id, changes: pickStockItemChanges(req.body) });
    await req.audit({ entityType: 'stock_items', entityId: req.params.id, action: 'update', beforeState: before, afterState: item });
    res.status(200).json(ok(item));
  } catch (error) {
    next(error);
  }
}

async function archiveStockItem(req, res, next) {
  try {
    const before = await service.getStockItem({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const item = await service.archiveStockItem({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'stock_items', entityId: req.params.id, action: 'archive', beforeState: before, afterState: item });
    res.status(200).json(ok(item));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Wastage — pos.stock_view, a floor action with a mandatory reason
// ---------------------------------------------------------------------

async function recordWastage(req, res, next) {
  try {
    const quantity = require_(req.body, 'quantity');
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'stock.record_wastage',
      entityType: 'stock_items',
      entityId: req.params.id,
      action: 'wastage',
      handler: async (trx) => {
        const property = await trx.table('properties').first('current_business_date');
        const item = await service.recordWastage({
          trx,
          stockItemId: req.params.id,
          quantity,
          reason,
          userId: req.context.userId,
          businessDate: property?.current_business_date,
        });
        return { status: 200, body: ok(item) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Recipe / BOM
// ---------------------------------------------------------------------

async function listMenuItemComponents(req, res, next) {
  try {
    res.status(200).json(ok(await service.listMenuItemComponents({ context: req.context, menuItemId: req.params.menuItemId })));
  } catch (error) {
    next(error);
  }
}

async function upsertMenuItemComponents(req, res, next) {
  try {
    const components = (req.body?.components ?? []).map((row) => ({ stockItemId: row.stock_item_id, quantity: row.quantity }));
    const result = await service.upsertMenuItemComponents({ context: req.context, menuItemId: req.params.menuItemId, components });
    await req.audit({
      entityType: 'pos_menu_item_components',
      entityId: req.params.menuItemId,
      action: 'upsert_components',
      afterState: { menu_item_id: req.params.menuItemId, count: result.length },
    });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Goods received
// ---------------------------------------------------------------------

async function recordGoodsReceived(req, res, next) {
  try {
    const outletId = require_(req.body, 'outlet_id');
    const lines = (req.body?.lines ?? []).map((row) => ({ stockItemId: row.stock_item_id, quantity: row.quantity, unitCost: row.unit_cost }));
    await runIdempotentMutation(req, res, {
      operationType: 'stock.record_goods_received',
      entityType: 'stock_movements',
      action: 'goods_received',
      handler: async (trx) => {
        const property = await trx.table('properties').first('current_business_date');
        const items = await service.recordGoodsReceived({
          trx,
          outletId,
          lines,
          reference: req.body?.reference,
          userId: req.context.userId,
          businessDate: property?.current_business_date,
        });
        // A code-review precedent this codebase already established
        // (Group Blocks' own bulk room-allocation endpoint): knex/mysql2
        // does not serialize a plain JS ARRAY into `audit_log.after_state`'s
        // JSON column the way it does a plain object, and
        // `runIdempotentMutation`'s own audit call passes `result.body.data`
        // straight through — a bare array here would reproduce that exact
        // `ER_PARSE_ERROR`. Wrapped in a summary object instead.
        return { status: 201, body: ok({ outletId, reference: req.body?.reference ?? null, count: items.length, items }) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Stock takes
// ---------------------------------------------------------------------

async function listStockTakes(req, res, next) {
  try {
    res.status(200).json(ok(await service.listStockTakes({ context: req.context, outletId: req.query.outlet_id, status: req.query.status })));
  } catch (error) {
    next(error);
  }
}

async function getStockTake(req, res, next) {
  try {
    const result = await service.getStockTake({ context: req.context, id: req.params.id });
    if (!result) return notFound(res);
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function openStockTake(req, res, next) {
  try {
    const outletId = require_(req.body, 'outlet_id');
    const stockTake = await service.openStockTake({ context: req.context, outletId, userId: req.context.userId });
    await req.audit({ entityType: 'stock_takes', entityId: stockTake.id, action: 'open', afterState: stockTake });
    res.status(201).json(ok(stockTake));
  } catch (error) {
    next(error);
  }
}

async function recordStockTakeCount(req, res, next) {
  try {
    const countedQuantity = require_(req.body, 'counted_quantity');
    const line = await service.recordStockTakeCount({
      context: req.context,
      stockTakeId: req.params.id,
      stockItemId: req.params.stockItemId,
      countedQuantity,
    });
    res.status(200).json(ok(line));
  } catch (error) {
    next(error);
  }
}

async function completeStockTake(req, res, next) {
  try {
    await runIdempotentMutation(req, res, {
      operationType: 'stock.complete_take',
      entityType: 'stock_takes',
      entityId: req.params.id,
      action: 'complete',
      handler: async (trx) => {
        const result = await service.completeStockTake({ trx, stockTakeId: req.params.id, userId: req.context.userId });
        return { status: 200, body: ok(result) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function cancelStockTake(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    const stockTake = await service.cancelStockTake({ context: req.context, stockTakeId: req.params.id, reason, userId: req.context.userId });
    await req.audit({ entityType: 'stock_takes', entityId: req.params.id, action: 'cancel', afterState: stockTake, reason });
    res.status(200).json(ok(stockTake));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------

async function costOfSales(req, res, next) {
  try {
    const dateFrom = require_(req.query, 'date_from');
    const dateTo = require_(req.query, 'date_to');
    res.status(200).json(ok(await reporting.computeCostOfSales({ context: req.context, dateFrom, dateTo, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function stockVariance(req, res, next) {
  try {
    const dateFrom = require_(req.query, 'date_from');
    const dateTo = require_(req.query, 'date_to');
    res.status(200).json(ok(await reporting.computeStockVariance({ context: req.context, dateFrom, dateTo, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listStockItems,
  createStockItem,
  updateStockItem,
  archiveStockItem,
  recordWastage,
  listMenuItemComponents,
  upsertMenuItemComponents,
  recordGoodsReceived,
  listStockTakes,
  getStockTake,
  openStockTake,
  recordStockTakeCount,
  completeStockTake,
  cancelStockTake,
  costOfSales,
  stockVariance,
};
