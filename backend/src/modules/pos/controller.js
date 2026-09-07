'use strict';

/**
 * HTTP layer for the POS module — parses the request, calls the service,
 * shapes the API.md §2 envelope. No business logic here; see `service.js`.
 *
 * `settleOrder`/`closeShift` go through `runIdempotentMutation` — both are
 * financial mutations (ARCHITECTURE.md §7): settlement posts real money
 * (cash-up totals or a folio charge), and a retried shift-close must not
 * ask an operator to re-enter a cash count and get a different variance.
 * Every other mutation here (open a tab, add/void an item pre-settlement,
 * open a shift) is not idempotency-gated — each is either non-financial or
 * already made safe by its own row-lock guard (see `service.js`'s header).
 */

const { ok, notFound } = require('../../shared/response');
const { ValidationError } = require('../../shared/errors');
const { runIdempotentMutation } = require('../../shared/mutation');
const service = require('./service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

// ---------------------------------------------------------------------
// Outlets
// ---------------------------------------------------------------------

async function listOutlets(req, res, next) {
  try {
    res.status(200).json(ok(await service.listOutlets({ context: req.context })));
  } catch (error) {
    next(error);
  }
}

async function createOutlet(req, res, next) {
  try {
    const code = require_(req.body, 'code');
    const name = require_(req.body, 'name');
    const type = require_(req.body, 'type');
    const outlet = await service.createOutlet({ context: req.context, code, name, type });
    await req.audit({ entityType: 'pos_outlets', entityId: outlet.id, action: 'create', afterState: outlet });
    res.status(201).json(ok(outlet));
  } catch (error) {
    next(error);
  }
}

async function updateOutlet(req, res, next) {
  try {
    const before = await service.getOutlet({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const outlet = await service.updateOutlet({ context: req.context, id: req.params.id, changes: req.body ?? {} });
    await req.audit({ entityType: 'pos_outlets', entityId: req.params.id, action: 'update', beforeState: before, afterState: outlet });
    res.status(200).json(ok(outlet));
  } catch (error) {
    next(error);
  }
}

async function archiveOutlet(req, res, next) {
  try {
    const before = await service.getOutlet({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const outlet = await service.archiveOutlet({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'pos_outlets', entityId: req.params.id, action: 'archive', beforeState: before, afterState: outlet });
    res.status(200).json(ok(outlet));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------

async function listTerminals(req, res, next) {
  try {
    res.status(200).json(ok(await service.listTerminals({ context: req.context, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function createTerminal(req, res, next) {
  try {
    const outletId = require_(req.body, 'outlet_id');
    const deviceRef = require_(req.body, 'device_ref');
    const terminal = await service.createTerminal({ context: req.context, outletId, deviceRef, supportsContactless: req.body?.supports_contactless });
    await req.audit({ entityType: 'pos_terminals', entityId: terminal.id, action: 'create', afterState: terminal });
    res.status(201).json(ok(terminal));
  } catch (error) {
    next(error);
  }
}

async function updateTerminal(req, res, next) {
  try {
    const before = await service.getTerminal({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const terminal = await service.updateTerminal({ context: req.context, id: req.params.id, changes: req.body ?? {} });
    await req.audit({ entityType: 'pos_terminals', entityId: req.params.id, action: 'update', beforeState: before, afterState: terminal });
    res.status(200).json(ok(terminal));
  } catch (error) {
    next(error);
  }
}

async function archiveTerminal(req, res, next) {
  try {
    const before = await service.getTerminal({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const terminal = await service.archiveTerminal({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'pos_terminals', entityId: req.params.id, action: 'archive', beforeState: before, afterState: terminal });
    res.status(200).json(ok(terminal));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------

async function listMenuItems(req, res, next) {
  try {
    res.status(200).json(ok(await service.listMenuItems({ context: req.context, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function createMenuItem(req, res, next) {
  try {
    const outletId = require_(req.body, 'outlet_id');
    const name = require_(req.body, 'name');
    const category = require_(req.body, 'category');
    const price = require_(req.body, 'price');
    const menuItem = await service.createMenuItem({ context: req.context, outletId, name, category, price, modifiers: req.body?.modifiers });
    await req.audit({ entityType: 'pos_menu_items', entityId: menuItem.id, action: 'create', afterState: menuItem });
    res.status(201).json(ok(menuItem));
  } catch (error) {
    next(error);
  }
}

async function updateMenuItem(req, res, next) {
  try {
    const before = await service.getMenuItem({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const menuItem = await service.updateMenuItem({ context: req.context, id: req.params.id, changes: req.body ?? {} });
    await req.audit({ entityType: 'pos_menu_items', entityId: req.params.id, action: 'update', beforeState: before, afterState: menuItem });
    res.status(200).json(ok(menuItem));
  } catch (error) {
    next(error);
  }
}

/** The stock-out toggle — deliberately `pos.operate`, not `pos.manage` (see routes.js): PRODUCT_REQUIREMENTS.md §3.4 asks for this without an admin edit. */
async function setMenuItemAvailability(req, res, next) {
  try {
    const before = await service.getMenuItem({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    if (req.body?.is_available === undefined) throw new ValidationError('MISSING_FIELD', '"is_available" is required.', [{ field: 'is_available', issue: 'missing' }]);
    const menuItem = await service.setMenuItemAvailability({ context: req.context, id: req.params.id, isAvailable: !!req.body.is_available });
    await req.audit({ entityType: 'pos_menu_items', entityId: req.params.id, action: 'set_availability', beforeState: before, afterState: menuItem });
    res.status(200).json(ok(menuItem));
  } catch (error) {
    next(error);
  }
}

async function archiveMenuItem(req, res, next) {
  try {
    const before = await service.getMenuItem({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const menuItem = await service.archiveMenuItem({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'pos_menu_items', entityId: req.params.id, action: 'archive', beforeState: before, afterState: menuItem });
    res.status(200).json(ok(menuItem));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Charge-to-room guest lookup
// ---------------------------------------------------------------------

async function findInHouseForCharge(req, res, next) {
  try {
    const query = require_(req.query, 'query');
    res.status(200).json(ok(await service.findInHouseForCharge({ context: req.context, query })));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Orders (tabs)
// ---------------------------------------------------------------------

async function listOrders(req, res, next) {
  try {
    res.status(200).json(ok(await service.listOrders({ context: req.context, outletId: req.query.outlet_id, status: req.query.status })));
  } catch (error) {
    next(error);
  }
}

async function getOrder(req, res, next) {
  try {
    const order = await service.getOrder({ context: req.context, id: req.params.id });
    if (!order) return notFound(res);
    const [items, settlements] = await Promise.all([
      service.listOrderItems({ context: req.context, orderId: order.id }),
      service.listOrderSettlements({ context: req.context, orderId: order.id }),
    ]);
    res.status(200).json(ok({ order, items, settlements }));
  } catch (error) {
    next(error);
  }
}

async function openOrder(req, res, next) {
  try {
    const outletId = require_(req.body, 'outlet_id');
    const terminalId = require_(req.body, 'terminal_id');
    const order = await service.openOrder({
      context: req.context,
      outletId,
      terminalId,
      openedByUserId: req.context.userId,
      tableLabel: req.body?.table_label,
    });
    await req.audit({ entityType: 'pos_orders', entityId: order.id, action: 'open', afterState: order });
    res.status(201).json(ok(order));
  } catch (error) {
    next(error);
  }
}

async function addItem(req, res, next) {
  try {
    const menuItemId = require_(req.body, 'menu_item_id');
    const result = await service.addItem({
      context: req.context,
      orderId: req.params.id,
      menuItemId,
      quantity: req.body?.quantity,
      modifiers: req.body?.modifiers,
    });
    await req.audit({ entityType: 'pos_orders', entityId: req.params.id, action: 'add_item', afterState: result });
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}

async function voidOrderItem(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    const item = await service.voidOrderItem({ context: req.context, orderItemId: req.params.itemId, reason, userId: req.context.userId });
    await req.audit({ entityType: 'pos_order_items', entityId: req.params.itemId, action: 'void', afterState: item, reason });
    res.status(200).json(ok(item));
  } catch (error) {
    next(error);
  }
}

async function assignItemSplitGroup(req, res, next) {
  try {
    const item = await service.assignItemSplitGroup({
      context: req.context,
      orderItemId: req.params.itemId,
      splitGroup: req.body?.split_group ?? null,
    });
    res.status(200).json(ok(item));
  } catch (error) {
    next(error);
  }
}

async function voidOrder(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    const order = await service.voidOrder({ context: req.context, orderId: req.params.id, reason, userId: req.context.userId });
    await req.audit({ entityType: 'pos_orders', entityId: req.params.id, action: 'void', afterState: order, reason });
    res.status(200).json(ok(order));
  } catch (error) {
    next(error);
  }
}

async function settleOrder(req, res, next) {
  try {
    await runIdempotentMutation(req, res, {
      operationType: 'pos.settle_order',
      entityType: 'pos_orders',
      entityId: req.params.id,
      action: 'settle',
      handler: async (trx) => {
        const result = await service.settleOrder({
          trx,
          orderId: req.params.id,
          settledByUserId: req.context.userId,
          settlements: (req.body?.settlements ?? []).map((s) => ({
            splitGroup: s.split_group ?? null,
            method: s.method,
            tipAmount: s.tip_amount,
            serviceCharge: s.service_charge,
            roomCharge: s.room_charge
              ? { reservationId: s.room_charge.reservation_id, authMethod: s.room_charge.auth_method, authReference: s.room_charge.auth_reference }
              : undefined,
          })),
        });
        return { status: 200, body: ok(result) };
      },
    });
  } catch (error) {
    next(error);
  }
}

async function voidSettlement(req, res, next) {
  try {
    const reason = require_(req.body, 'reason');
    await runIdempotentMutation(req, res, {
      operationType: 'pos.void_settlement',
      entityType: 'pos_order_settlements',
      entityId: req.params.settlementId,
      action: 'void',
      handler: async (trx) => {
        const settlement = await service.voidSettlement({ trx, settlementId: req.params.settlementId, reason, userId: req.context.userId });
        return { status: 200, body: ok(settlement) };
      },
    });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------
// Shifts — blind cash-up
// ---------------------------------------------------------------------

async function listShifts(req, res, next) {
  try {
    res.status(200).json(ok(await service.listShifts({ context: req.context, terminalId: req.query.terminal_id })));
  } catch (error) {
    next(error);
  }
}

async function getShift(req, res, next) {
  try {
    const shift = await service.getShift({ context: req.context, id: req.params.id });
    if (!shift) return notFound(res);
    res.status(200).json(ok(shift));
  } catch (error) {
    next(error);
  }
}

async function openShift(req, res, next) {
  try {
    const terminalId = require_(req.body, 'terminal_id');
    const openingFloat = require_(req.body, 'opening_float');
    const shift = await service.openShift({ context: req.context, terminalId, userId: req.context.userId, openingFloat });
    await req.audit({ entityType: 'pos_shifts', entityId: shift.id, action: 'open', afterState: shift });
    res.status(201).json(ok(shift));
  } catch (error) {
    next(error);
  }
}

async function closeShift(req, res, next) {
  try {
    const countedCash = require_(req.body, 'counted_cash');
    await runIdempotentMutation(req, res, {
      operationType: 'pos.close_shift',
      entityType: 'pos_shifts',
      entityId: req.params.id,
      action: 'close',
      handler: async (trx) => {
        const shift = await service.closeShift({ trx, shiftId: req.params.id, countedCash });
        return { status: 200, body: ok(shift) };
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listOutlets,
  createOutlet,
  updateOutlet,
  archiveOutlet,
  listTerminals,
  createTerminal,
  updateTerminal,
  archiveTerminal,
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  setMenuItemAvailability,
  archiveMenuItem,
  findInHouseForCharge,
  listOrders,
  getOrder,
  openOrder,
  addItem,
  voidOrderItem,
  assignItemSplitGroup,
  voidOrder,
  settleOrder,
  voidSettlement,
  listShifts,
  getShift,
  openShift,
  closeShift,
};
