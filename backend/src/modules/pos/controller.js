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
const { runIdempotentMutation, requireIdempotencyKey } = require('../../shared/mutation');
const { withIdempotency } = require('../../shared/idempotency');
const { scopedDb } = require('../../db');
const service = require('./service');
const { computeSalesReport } = require('./sales-report');
const { computeCostOfSalesMargin } = require('../stock/reporting');
const { toCsv } = require('../reporting/service');

function require_(body, field) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, [{ field, issue: 'missing' }]);
  }
  return value;
}

/**
 * A required, non-negative cash amount with at most 2 decimal places,
 * returned as a trimmed string. Bug fix (the "test and review Shifts"
 * pass): the shift float and count were passed straight through, so
 * "abc" reached MySQL as a 500, "-50" was stored, and "100.999" was
 * stored rounded (101.00) while the variance used the truncated 100.99 —
 * a saved row whose own numbers didn't add up.
 */
function requireCashAmount(body, field) {
  const value = String(require_(body, field)).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new ValidationError('INVALID_AMOUNT', `"${field}" must be a non-negative amount with at most 2 decimal places.`, [{ field, issue: 'invalid' }]);
  }
  return value;
}

/**
 * Gap closure (`pos_menu_items.cost_price`): distinguishes `undefined`
 * ("field not sent, don't touch it") from `null` ("clear it, go back to no
 * fallback cost") the same way `access-monitoring`'s `retentionDays` does —
 * a genuinely optional money field, unlike `requireCashAmount`'s always-
 * required one.
 */
function optionalCashAmount(body, field) {
  const raw = body?.[field];
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new ValidationError('INVALID_AMOUNT', `"${field}" must be a non-negative amount with at most 2 decimal places, or null.`, [{ field, issue: 'invalid' }]);
  }
  return value;
}

/**
 * Bug fix (found while building this module's first real edit UI —
 * `updateOutlet`/`updateTerminal`/`updateMenuItem` had all three taken
 * `req.body ?? {}` straight through to a raw `.update(changes)` since this
 * module was first built, with no field allowlist — the exact same
 * latent-until-a-live-caller gap CLAUDE.md's own room-type/property update
 * passes already found and fixed for their own first real edit UI ("the
 * next time any of them gets a live caller, it should get the identical
 * allowlist treatment"). Each mirrors its sibling `create*` function's own
 * field set exactly — `status`/`stock_auto_unavailable` stay reachable only
 * through their own dedicated archive/availability endpoints, never a
 * generic edit form.
 */
function pickOutletChanges(body) {
  const changes = {};
  if (body?.code !== undefined) changes.code = body.code;
  if (body?.name !== undefined) changes.name = body.name;
  if (body?.type !== undefined) changes.type = body.type;
  return changes;
}

function pickTerminalChanges(body) {
  const changes = {};
  if (body?.device_ref !== undefined) changes.device_ref = body.device_ref;
  if (body?.supports_contactless !== undefined) changes.supports_contactless = !!body.supports_contactless;
  return changes;
}

function pickMenuItemChanges(body) {
  const changes = {};
  if (body?.name !== undefined) changes.name = body.name;
  if (body?.category !== undefined) changes.category = body.category;
  if (body?.price !== undefined) changes.price = body.price;
  if (body?.modifiers !== undefined) changes.modifiers = body.modifiers;
  if (body?.cost_price !== undefined) changes.cost_price = optionalCashAmount(body, 'cost_price');
  return changes;
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
    const outlet = await service.updateOutlet({ context: req.context, id: req.params.id, changes: pickOutletChanges(req.body) });
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
    const terminal = await service.updateTerminal({ context: req.context, id: req.params.id, changes: pickTerminalChanges(req.body) });
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

// ---------------------------------------------------------------------
// Menu categories
// ---------------------------------------------------------------------

async function listMenuCategories(req, res, next) {
  try {
    const includeArchived = req.query.include_archived === 'true';
    res.status(200).json(ok(await service.listMenuCategories({ context: req.context, includeArchived })));
  } catch (error) {
    next(error);
  }
}

function optionalSortOrder(body) {
  if (body?.sort_order === undefined || body?.sort_order === null || body?.sort_order === '') return undefined;
  const value = Number(body.sort_order);
  return Number.isInteger(value) ? value : Number.NaN;
}

async function createMenuCategory(req, res, next) {
  try {
    const category = await service.createMenuCategory({ context: req.context, name: req.body?.name, sortOrder: optionalSortOrder(req.body) });
    await req.audit({ entityType: 'pos_menu_categories', entityId: category.id, action: 'create', afterState: category });
    res.status(201).json(ok(category));
  } catch (error) {
    next(error);
  }
}

async function updateMenuCategory(req, res, next) {
  try {
    const before = await service.getMenuCategory({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const category = await service.updateMenuCategory({ context: req.context, id: req.params.id, name: req.body?.name, sortOrder: optionalSortOrder(req.body) });
    if (!category) return notFound(res);
    await req.audit({ entityType: 'pos_menu_categories', entityId: category.id, action: 'update', beforeState: before, afterState: category });
    res.status(200).json(ok(category));
  } catch (error) {
    next(error);
  }
}

async function archiveMenuCategory(req, res, next) {
  try {
    const before = await service.getMenuCategory({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const category = await service.archiveMenuCategory({ context: req.context, id: req.params.id });
    if (!category) return notFound(res);
    await req.audit({ entityType: 'pos_menu_categories', entityId: category.id, action: 'archive', beforeState: before, afterState: category });
    res.status(200).json(ok(category));
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
    const costPrice = optionalCashAmount(req.body, 'cost_price');
    const menuItem = await service.createMenuItem({ context: req.context, outletId, name, category, price, costPrice, modifiers: req.body?.modifiers });
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
    const menuItem = await service.updateMenuItem({ context: req.context, id: req.params.id, changes: pickMenuItemChanges(req.body) });
    await req.audit({ entityType: 'pos_menu_items', entityId: req.params.id, action: 'update', beforeState: before, afterState: menuItem });
    res.status(200).json(ok(menuItem));
  } catch (error) {
    next(error);
  }
}

/** The stock-out toggle — deliberately `pos.operate`, not `pos.manage` (see routes.js): PRODUCT_REQUIREMENTS.md §3.4 asks for this without an admin edit. */
/** `POST /pos/menu-items/:id/image` (multipart, field `image`) — see `menu-images.js` for validation and storage. */
async function uploadMenuItemImage(req, res, next) {
  try {
    const before = await service.getMenuItem({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const menuItem = await service.setMenuItemImage({ context: req.context, id: req.params.id, buffer: req.file.buffer });
    await req.audit({ entityType: 'pos_menu_items', entityId: menuItem.id, action: 'set_image', beforeState: { image_path: before.image_path }, afterState: { image_path: menuItem.image_path } });
    res.status(200).json(ok(menuItem));
  } catch (error) {
    next(error);
  }
}

async function removeMenuItemImage(req, res, next) {
  try {
    const before = await service.getMenuItem({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const menuItem = await service.removeMenuItemImage({ context: req.context, id: req.params.id });
    await req.audit({ entityType: 'pos_menu_items', entityId: menuItem.id, action: 'remove_image', beforeState: { image_path: before.image_path }, afterState: { image_path: null } });
    res.status(200).json(ok(menuItem));
  } catch (error) {
    next(error);
  }
}

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

async function listKitchenTickets(req, res, next) {
  try {
    res.status(200).json(ok(await service.listKitchenTickets({ context: req.context, outletId: req.query.outlet_id })));
  } catch (error) {
    next(error);
  }
}

async function markTicketDone(req, res, next) {
  try {
    const order = await service.markTicketDone({ context: req.context, orderId: req.params.id, userId: req.context.userId });
    if (!order) return notFound(res);
    await req.audit({ entityType: 'pos_orders', entityId: order.id, action: 'ticket_done', afterState: { ticket_done_at: order.ticket_done_at } });
    res.status(200).json(ok(order));
  } catch (error) {
    next(error);
  }
}

async function getOrder(req, res, next) {
  try {
    const order = await service.getOrder({ context: req.context, id: req.params.id });
    if (!order) return notFound(res);
    const db = scopedDb().for(req.context);
    const [items, settlements, registerPayments] = await Promise.all([
      service.listOrderItems({ context: req.context, orderId: order.id }),
      service.listOrderSettlements({ context: req.context, orderId: order.id }),
      service.listUnsettledRegisterPayments({ db, orderId: order.id }),
    ]);
    // `registerPayments` lets the Register recover a card/NQR payment
    // Paystack captured but the tab never settled (a closed browser, a
    // dropped connection) instead of charging the guest a second time.
    res.status(200).json(ok({ order, items, settlements, registerPayments }));
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
      stockOverrideReason: req.body?.stock_override_reason,
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

async function renameOrder(req, res, next) {
  try {
    const before = await service.getOrder({ context: req.context, id: req.params.id });
    if (!before) return notFound(res);
    const order = await service.renameOrder({ context: req.context, orderId: req.params.id, tableLabel: req.body?.table_label });
    await req.audit({ entityType: 'pos_orders', entityId: order.id, action: 'rename', beforeState: { table_label: before.table_label }, afterState: { table_label: order.table_label } });
    res.status(200).json(ok(order));
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

/** Read-only preview — no `req.audit`, matching `getOrder`/`listOrders`; nothing is written. */
async function previewSettlement(req, res, next) {
  try {
    const preview = await service.previewSettlement({ context: req.context, orderId: req.params.id });
    res.status(200).json(ok(preview));
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
            paymentId: s.payment_id,
            tipAmount: s.tip_amount,
            serviceCharge: s.service_charge,
            roomCharge: s.room_charge
              ? { reservationId: s.room_charge.reservation_id, authMethod: s.room_charge.auth_method, authReference: s.room_charge.auth_reference }
              : undefined,
          })),
          stockOverrideReason: req.body?.stock_override_reason,
        });
        return { status: 200, body: ok(result) };
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Card/NQR checkout for one Register check (ARCHITECTURE.md §7): the local
 * payment intent commits under the Idempotency-Key, then Paystack is called
 * outside that transaction. The response carries `accessCode` in `meta` for
 * the on-screen Paystack popup. A payment already CAPTURED comes back with
 * no access code — the Register settles with it straight away. A gateway
 * failure is a `202` with `checkoutError`, the same honest partial success
 * `cashiering/controller.js`'s `capturePaystackPayment` returns.
 */
async function startPaystackCheckout(req, res, next) {
  try {
    const tender = require_(req.body, 'tender');
    const key = requireIdempotencyKey(req);
    const outcome = await withIdempotency({
      context: req.context,
      operationType: 'pos.start_register_paystack_checkout',
      key,
      payload: { ...req.body, orderId: req.params.id },
      handler: async (trx) => {
        const payment = await service.prepareRegisterPayment({
          trx,
          orderId: req.params.id,
          splitGroup: req.body?.split_group ?? null,
          tender,
          idempotencyKey: key,
        });
        return { status: 201, body: ok(payment) };
      },
    });
    const prepared = outcome.body.data;
    if (!outcome.replayed) {
      await req.audit({ entityType: 'payments', entityId: prepared.id, action: 'initiate_register_paystack_payment', afterState: prepared });
    }

    try {
      const { payment, accessCode } = await service.startRegisterPaystackCheckout({
        context: req.context,
        payment: prepared,
        customerEmail: req.body?.customer_email,
      });
      res.status(201).json(ok(payment, { accessCode }));
    } catch (checkoutError) {
      res.status(202).json(ok(prepared, { checkoutError: checkoutError.message }));
    }
  } catch (error) {
    next(error);
  }
}

async function verifyPaystackPayment(req, res, next) {
  try {
    const payment = await service.verifyRegisterPayment({
      context: req.context,
      orderId: req.params.id,
      paymentId: req.params.paymentId,
      userId: req.context.userId,
    });
    if (!payment) return notFound(res);
    await req.audit({ entityType: 'payments', entityId: payment.id, action: 'verify', afterState: payment });
    res.status(200).json(ok(payment));
  } catch (error) {
    next(error);
  }
}

/** e.g. "cash", "card via ussd", "room_charge Room 05 (Ada Bello)" — the CSV's plain-text form of one check's payment. */
function describeSettlementPayment(payment) {
  let text = payment.tender;
  if (payment.channel && payment.channel !== payment.tender) text += ` via ${payment.channel}`;
  if (payment.roomNumber) text += ` Room ${payment.roomNumber}`;
  if (payment.guestName) text += ` (${payment.guestName})`;
  return text;
}

const SALES_CSV_SECTIONS = {
  tabs: {
    columns: ['orderId', 'businessDate', 'settledAt', 'tableLabel', 'source', 'tenders', 'itemCount', 'cashier', 'total', 'profit'],
    rows: (report) => report.tabs.map((tab) => ({ ...tab, settledAt: new Date(tab.settledAt).toISOString(), tenders: tab.payments.map(describeSettlementPayment).join(' + ') })),
  },
  items: { columns: ['name', 'quantity', 'sales', 'cost', 'profit'], rows: (report) => report.topItems },
  tenders: { columns: ['tender', 'checks', 'total'], rows: (report) => report.byTender },
};

/**
 * `GET /pos/reports/sales?date_from&date_to[&outlet_id][&format=csv&section=tabs|items|tenders]`.
 * Allow-listed query params only. CSV exports one section at a time,
 * reflecting the same filters as the on-screen report.
 */
async function salesReport(req, res, next) {
  try {
    const dateFrom = req.query?.date_from;
    const dateTo = req.query?.date_to;
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoDate.test(dateFrom ?? '') || !isoDate.test(dateTo ?? '')) {
      throw new ValidationError('INVALID_DATE_RANGE', '"date_from" and "date_to" are required, as YYYY-MM-DD.', [{ field: 'date_from', issue: 'invalid' }]);
    }
    if (dateFrom > dateTo) {
      throw new ValidationError('INVALID_DATE_RANGE', '"date_from" must not be after "date_to".', [{ field: 'date_from', issue: 'after_date_to' }]);
    }
    const outletId = req.query?.outlet_id || undefined;
    // Each menu item's unit cost (recipe, else cost price) from the stock margin report — profit = what an item sold for minus that.
    const margin = await computeCostOfSalesMargin({ context: req.context, dateFrom, dateTo, outletId });
    const unitCostByMenuItem = new Map(margin.byMenuItem.map((row) => [String(row.menuItemId), row.unitCost]));
    const report = await computeSalesReport({ context: req.context, dateFrom, dateTo, outletId, unitCostByMenuItem });

    if (req.query?.format === 'csv') {
      const section = SALES_CSV_SECTIONS[req.query?.section ?? 'tabs'];
      if (!section) throw new ValidationError('INVALID_SECTION', '"section" must be tabs, items, or tenders.', [{ field: 'section', issue: 'invalid' }]);
      const name = req.query?.section ?? 'tabs';
      res
        .status(200)
        .set('Content-Type', 'text/csv')
        .set('Content-Disposition', `attachment; filename="pos-sales-${name}-${dateFrom}-to-${dateTo}.csv"`)
        .send(toCsv(section.rows(report), section.columns));
      return;
    }
    res.status(200).json(ok(report));
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
    const openingFloat = requireCashAmount(req.body, 'opening_float');
    const shift = await service.openShift({ context: req.context, terminalId, userId: req.context.userId, openingFloat });
    await req.audit({ entityType: 'pos_shifts', entityId: shift.id, action: 'open', afterState: shift });
    res.status(201).json(ok(shift));
  } catch (error) {
    next(error);
  }
}

async function closeShift(req, res, next) {
  try {
    const countedCash = requireCashAmount(req.body, 'counted_cash');
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
  listMenuCategories,
  createMenuCategory,
  updateMenuCategory,
  archiveMenuCategory,
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  setMenuItemAvailability,
  uploadMenuItemImage,
  removeMenuItemImage,
  archiveMenuItem,
  findInHouseForCharge,
  listOrders,
  listKitchenTickets,
  markTicketDone,
  getOrder,
  openOrder,
  addItem,
  voidOrderItem,
  assignItemSplitGroup,
  voidOrder,
  renameOrder,
  previewSettlement,
  settleOrder,
  startPaystackCheckout,
  verifyPaystackPayment,
  voidSettlement,
  salesReport,
  listShifts,
  getShift,
  openShift,
  closeShift,
};
