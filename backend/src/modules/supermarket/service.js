'use strict';

/**
 * Supermarket quick-sale layer, Stage 1. A THIN layer over the existing POS:
 * a sale is an ordinary `pos_orders` tab, priced from the shared menu, settled
 * by `pos/service.js`'s own `settleOrder` (so tax, stock deduction, cash-up
 * attribution and the audit trail are the existing ones), and this module only
 * adds barcodes, a gapless receipt number and a receipt snapshot on top.
 *
 * - Taxed under the `supermarket_sale` charge type (own VAT row, hotel 'all'
 *   rows never apply: see cashiering/tax-engine.js).
 * - A sale at zero recorded stock is allowed with an automatic reason; the
 *   low-stock alerts are the control.
 * - Payment: cash or an external terminal only (no gateway round trip).
 * - Outlet assignments apply: a user assigned elsewhere cannot sell here.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const { sumMoney, toCents, fromCents } = require('../../shared/money');
const { computeItemLineTotal } = require('../../shared/pos-pricing');
const { resolveOrderLine } = require('../../shared/pos-line-input');
const outletMenu = require('../../shared/outlet-menu');
const { isSupermarketOutlet } = require('../../shared/outlet-types');
const { allocateLineNetAndTax } = require('../../shared/line-allocation');
const { outletScopeForUser, scopeCovers } = require('../../shared/outlet-assignments');
const posService = require('../pos/service');
const stockService = require('../stock/service');
const errors = require('./errors');

const SALE_METHODS = ['cash', 'terminal'];
const MAX_LINES = 100;
const MAX_BARCODE_LENGTH = 64;
const MAX_LOW_STOCK = 50;
const MAX_MY_SALES = 50;

function cleanBarcode(raw) {
  const barcode = typeof raw === 'string' ? raw.trim() : '';
  if (!barcode || barcode.length > MAX_BARCODE_LENGTH || /\s/.test(barcode)) {
    throw new ValidationError('INVALID_BARCODE', `A barcode is 1 to ${MAX_BARCODE_LENGTH} characters with no spaces.`, [{ field: 'barcode', issue: 'invalid' }]);
  }
  return barcode;
}

/** The outlet, which must be an active supermarket the caller may work at. Judged on the accessor passed in. */
async function requireSupermarketOutlet({ db, context, outletId, enforceAssignment = true }) {
  const outlet = outletId ? await db.table('pos_outlets').where({ id: outletId }).first() : null;
  if (!outlet || outlet.status !== 'active') throw new ValidationError('OUTLET_NOT_FOUND', 'The specified outlet does not exist.', [{ field: 'outlet_id', issue: 'not_found' }]);
  if (!isSupermarketOutlet(outlet)) throw new errors.NotASupermarketOutletError(outlet.name);
  if (enforceAssignment && !context.isImpersonation) {
    const scope = await outletScopeForUser(db, context.userId);
    if (!scopeCovers(scope, [outlet.id])) {
      throw new ValidationError('OUTLET_NOT_ASSIGNED', 'You are not assigned to this outlet.', [{ field: 'outlet_id', issue: 'not_assigned' }]);
    }
  }
  return outlet;
}

/** The supermarket outlets the caller may sell at (for the till's outlet picker). */
async function listMyOutlets({ context }) {
  const db = scopedDb().for(context);
  const scope = context.isImpersonation ? null : await outletScopeForUser(db, context.userId);
  const outlets = await db.table('pos_outlets').where({ type: 'supermarket', status: 'active' }).orderBy('name');
  return outlets.filter((outlet) => scopeCovers(scope, [outlet.id]));
}

// ---------------------------------------------------------------- barcodes

/**
 * Every barcode registered at the property (barcodes are unique property-wide,
 * so a code on a restaurant item shows here too), each with its product's name
 * and status. With `outletId` (a supermarket outlet the caller covers) each row
 * also says whether that product is on that outlet's till (`on_till`), by the
 * same carried-category rule the till uses; without it `on_till` is null.
 */
async function listBarcodes({ context, menuItemId, outletId }) {
  const db = scopedDb().for(context);
  let carried = null;
  if (outletId) {
    await requireSupermarketOutlet({ db, context, outletId });
    carried = new Set((await outletMenu.carriedCategoryNames(db, outletId)).map((name) => String(name).trim().toLowerCase()));
  }
  let query = db
    .table('supermarket_barcodes')
    .joinScoped('pos_menu_items', (join) => join.on('pos_menu_items.id', '=', 'supermarket_barcodes.menu_item_id'))
    .select(
      'supermarket_barcodes.id',
      'supermarket_barcodes.menu_item_id',
      'supermarket_barcodes.barcode',
      'supermarket_barcodes.created_at',
      'pos_menu_items.name as item_name',
      'pos_menu_items.category as item_category',
      'pos_menu_items.status as item_status'
    )
    .orderBy('pos_menu_items.name')
    .orderBy('supermarket_barcodes.id');
  if (menuItemId) query = query.where({ 'supermarket_barcodes.menu_item_id': menuItemId });
  const rows = await query;
  return rows.map((row) => ({
    ...row,
    on_till: carried === null ? null : row.item_status === 'active' && carried.has(String(row.item_category ?? '').trim().toLowerCase()),
  }));
}

async function addBarcode({ context, menuItemId, barcode }) {
  const db = scopedDb().for(context);
  const code = cleanBarcode(barcode);
  const item = await db.table('pos_menu_items').where({ id: menuItemId, status: 'active' }).first('id');
  if (!item) throw new ValidationError('MENU_ITEM_NOT_FOUND', 'The specified product does not exist.', [{ field: 'menu_item_id', issue: 'not_found' }]);
  try {
    const [id] = await db.table('supermarket_barcodes').insert({ menu_item_id: item.id, barcode: code });
    return db.table('supermarket_barcodes').where({ id }).first();
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw new errors.BarcodeAlreadyUsedError(code);
    throw error;
  }
}

async function removeBarcode({ context, id }) {
  const db = scopedDb().for(context);
  const row = await db.table('supermarket_barcodes').where({ id }).first();
  if (!row) throw new errors.BarcodeNotFoundError(String(id));
  await db.table('supermarket_barcodes').where({ id }).delete();
  return row;
}

// ---------------------------------------------------------------- lookup

/**
 * The item as the supermarket till sees it: a supermarket never switches an
 * item off because of stock (an oversell is confirmed at the till instead), so
 * an item switched off only by the old stock mechanism (`stock_auto_unavailable`)
 * counts as available. A manual Sold out still blocks.
 */
function forTill(item) {
  return item && item.stock_auto_unavailable ? { ...item, is_available: true, stock_auto_unavailable: false } : item;
}

/** One product at the outlet by barcode (exact) — what a scanner sends. */
async function lookupByBarcode({ context, outletId, barcode }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const code = cleanBarcode(barcode);
  const row = await db.table('supermarket_barcodes').where({ barcode: code }).first();
  if (!row) throw new errors.BarcodeNotFoundError(code);
  const item = forTill(await outletMenu.menuItemAtOutlet(db, outletId, row.menu_item_id));
  if (!item) throw new errors.BarcodeNotFoundError(code);
  return { ...item, barcode: code };
}

/** Products at the outlet whose name contains `q` (max 30), for typing instead of scanning. */
async function searchItems({ context, outletId, q }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return [];
  const items = await outletMenu.menuItemsForOutlet(db, outletId);
  return items
    .filter((item) => String(item.name).toLowerCase().includes(needle))
    .slice(0, 30)
    .map(forTill);
}

/**
 * Whole units of each product the outlet can still sell from recorded stock
 * (`{[menu_item_id]: units}`; null = not stock-tracked). For the till's "N in
 * stock" chips and the over-stock warning; the sale itself re-checks.
 */
async function stockOnHand({ context, outletId }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const items = await outletMenu.menuItemsForOutlet(db, outletId);
  const units = await stockService.unitsOnHandForMenuItems({ trx: db, menuItemIds: items.map((item) => item.id), outletId });
  return Object.fromEntries(units);
}

// ---------------------------------------------------------------- sale

/** Locks (creating on first use) the outlet's counter and takes the next number. Gapless: it commits with the sale. */
async function takeReceiptNumber(trx, outlet) {
  let sequence = await trx.table('supermarket_receipt_sequences').where({ outlet_id: outlet.id }).forUpdate().first();
  if (!sequence) {
    try {
      await trx.table('supermarket_receipt_sequences').insert({ outlet_id: outlet.id, next_number: 1 });
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
    }
    sequence = await trx.table('supermarket_receipt_sequences').where({ outlet_id: outlet.id }).forUpdate().first();
  }
  const number = Number(sequence.next_number);
  await trx.table('supermarket_receipt_sequences').where({ id: sequence.id }).update({ next_number: number + 1 });
  return number;
}

function receiptCode(outlet, number) {
  return `${outlet.code}-${String(number).padStart(6, '0')}`;
}

/**
 * Resolves a cart against the outlet's menu: each line by barcode or
 * menu_item_id, priced from the menu, quantity validated. A bad line refuses
 * the whole sale before anything is written. `[{menuItem, barcode, quantity}]`.
 */
async function resolveSaleLines(trx, outlet, lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError('MISSING_FIELD', 'At least one item is required.', [{ field: 'items', issue: 'missing' }]);
  if (lines.length > MAX_LINES) throw new ValidationError('CART_TOO_LARGE', `A sale may have at most ${MAX_LINES} lines.`, [{ field: 'items', issue: 'too_many' }]);
  const resolved = [];
  for (const [index, line] of lines.entries()) {
    let menuItemId = line?.menu_item_id;
    let barcode = null;
    if (line?.barcode !== undefined && line?.barcode !== null && line?.barcode !== '') {
      barcode = cleanBarcode(line.barcode);
      const row = await trx.table('supermarket_barcodes').where({ barcode }).first();
      if (!row) throw new errors.BarcodeNotFoundError(barcode);
      menuItemId = row.menu_item_id;
    }
    if (!menuItemId) throw new ValidationError('MISSING_FIELD', `Line ${index + 1} needs a barcode or a menu_item_id.`, [{ field: `items[${index}]`, issue: 'missing' }]);
    const menuItem = forTill(await outletMenu.menuItemAtOutlet(trx, outlet.id, menuItemId));
    if (!menuItem) throw new ValidationError('MENU_ITEM_NOT_FOUND', `Line ${index + 1}: this outlet does not sell that product.`, [{ field: `items[${index}]`, issue: 'not_found' }]);
    if (!menuItem.is_available) throw new ValidationError('POS_ITEM_UNAVAILABLE', `"${menuItem.name}" is currently marked unavailable.`, [{ field: `items[${index}]`, issue: 'unavailable' }]);
    const priced = resolveOrderLine({ menuItem, unitPrice: menuItem.price, quantity: line.quantity, modifiers: undefined });
    resolved.push({ menuItem, barcode, quantity: priced.quantity });
  }
  return resolved;
}

/** Opens the quick-sale tab and adds its lines (`rows`: menu_item_id, quantity, unit_price, item_name, barcode). */
async function openQuickSaleOrder(trx, { outlet, userId, terminalId = null, rows }) {
  const [orderId] = await trx.table('pos_orders').insert({
    outlet_id: outlet.id,
    terminal_id: terminalId,
    opened_by_user_id: userId ?? null,
    table_label: 'Quick sale',
    source: 'staff',
  });
  const itemRows = [];
  for (const line of rows) {
    const row = { pos_order_id: orderId, menu_item_id: line.menu_item_id, quantity: line.quantity, unit_price: line.unit_price, modifiers: null };
    const [itemId] = await trx.table('pos_order_items').insert(row);
    itemRows.push({ ...row, id: itemId, item_name: line.item_name, barcode: line.barcode ?? null });
  }
  return { orderId, itemRows };
}

/** Takes the gapless receipt number and writes the sale and its line snapshot. Returns the sale id. */
async function recordReceiptedSale(trx, { outlet, orderId, settlement, userId, method, itemRows }) {
  const lineTotals = itemRows.map((row) => computeItemLineTotal({ unit_price: row.unit_price, quantity: row.quantity, modifiers: [] }));
  const split = allocateLineNetAndTax({ lineTotals, subtotal: settlement.subtotal, taxAmount: settlement.tax_amount });
  const receiptNumber = await takeReceiptNumber(trx, outlet);
  const total = sumMoney([settlement.subtotal, settlement.tax_amount]);
  const [saleId] = await trx.table('supermarket_sales').insert({
    outlet_id: outlet.id,
    pos_order_id: orderId,
    settlement_id: settlement.id,
    receipt_number: receiptNumber,
    sold_by_user_id: userId ?? null,
    method,
    subtotal: settlement.subtotal,
    tax_amount: settlement.tax_amount,
    total,
    currency: settlement.currency,
  });
  for (const [index, row] of itemRows.entries()) {
    await trx.table('supermarket_sale_lines').insert({
      sale_id: saleId,
      line_no: index + 1,
      menu_item_id: row.menu_item_id,
      item_name: row.item_name,
      barcode: row.barcode,
      quantity: row.quantity,
      unit_price: row.unit_price,
      line_total: lineTotals[index],
      line_net: split[index].net,
      line_tax: split[index].tax,
    });
  }
  return saleId;
}

/**
 * `trx`-based, called from `runIdempotentMutation`. `lines`: `[{barcode | menu_item_id, quantity}]`.
 * Opens the tab, adds the lines, settles it and records the receipt, all in the caller's transaction.
 */
async function createSale({ trx, context, userId, outletId, lines, method, terminalId = null, terminal, terminalAccountId, confirmOversell = false, approve = null }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError('MISSING_FIELD', 'At least one item is required.', [{ field: 'items', issue: 'missing' }]);
  if (lines.length > MAX_LINES) throw new ValidationError('CART_TOO_LARGE', `A sale may have at most ${MAX_LINES} lines.`, [{ field: 'items', issue: 'too_many' }]);
  if (!SALE_METHODS.includes(method)) {
    throw new ValidationError('INVALID_SETTLEMENT_METHOD', `"${method}" is not a supermarket payment method — use "cash" or "terminal".`, [{ field: 'method', issue: 'invalid' }]);
  }
  const outlet = await requireSupermarketOutlet({ db: trx, context, outletId });

  if (terminalId) {
    const found = await trx.table('pos_terminals').where({ id: terminalId, outlet_id: outlet.id }).first('id');
    if (!found) throw new ValidationError('TERMINAL_NOT_FOUND', 'The specified terminal does not exist at this outlet.', [{ field: 'terminal_id', issue: 'not_found' }]);
  }

  const resolved = await resolveSaleLines(trx, outlet, lines);

  // An oversell (recorded stock taken BELOW zero) needs the cashier's explicit
  // confirmation: refused before anything is written, and the confirmed sale
  // carries its own audit reason. Reaching exactly zero needs no confirmation.
  const shortfalls = await stockService.findStockShortfalls({
    trx,
    lines: resolved.map((line) => ({ menuItemId: line.menuItem.id, quantity: line.quantity })),
    outletId: outlet.id,
  });
  if (shortfalls.length > 0 && confirmOversell !== true) throw new errors.OversellNotConfirmedError(shortfalls);
  // A confirmed oversell also needs a manager's approval (`src/modules/approvals`), claimed in this transaction.
  if (shortfalls.length > 0 && approve) await approve(trx);
  const stockOverrideReason = shortfalls.length > 0 ? stockService.CONFIRMED_OVERSELL_REASON_SUPERMARKET : stockService.AUTOMATIC_OVERRIDE_REASON_SUPERMARKET;

  const { orderId, itemRows } = await openQuickSaleOrder(trx, {
    outlet,
    userId,
    terminalId,
    rows: resolved.map((line) => ({ menu_item_id: line.menuItem.id, quantity: line.quantity, unit_price: line.menuItem.price, item_name: line.menuItem.name, barcode: line.barcode })),
  });

  const { settlements } = await posService.settleOrder({
    trx,
    orderId,
    settledByUserId: userId,
    settlements: [{ splitGroup: null, method, terminal: terminal ?? {}, terminalAccountId, tipAmount: undefined, serviceCharge: undefined }],
    stockOverrideReason,
  });
  const saleId = await recordReceiptedSale(trx, { outlet, orderId, settlement: settlements[0], userId, method, itemRows });
  return getSaleWith(trx, saleId);
}

/** A sale with its lines and outlet, in the shape the receipt shows. */
async function getSaleWith(db, saleId) {
  const sale = await db.table('supermarket_sales').where({ id: saleId }).first();
  if (!sale) throw new errors.SupermarketSaleNotFoundError();
  const outlet = await db.table('pos_outlets').where({ id: sale.outlet_id }).first('id', 'code', 'name');
  const lines = await db.table('supermarket_sale_lines').where({ sale_id: sale.id }).orderBy('line_no');
  const seller = sale.sold_by_user_id ? await db.table('users').where({ id: sale.sold_by_user_id }).first('first_name', 'last_name') : null;
  // An online (Paystack) sale: which channel paid it, and whether it has been refunded.
  const settlement = await db.table('pos_order_settlements').where({ id: sale.settlement_id }).first('payment_id');
  const payment = settlement?.payment_id ? await db.table('payments').where({ id: settlement.payment_id }).first('id', 'provider_channel', 'status') : null;
  return {
    ...sale,
    payment_id: payment ? payment.id : null,
    payment_channel: payment ? payment.provider_channel : null,
    payment_status: payment ? payment.status : null,
    receipt_code: receiptCode(outlet, sale.receipt_number),
    outlet_name: outlet.name,
    sold_by_name: seller ? [seller.first_name, seller.last_name].filter(Boolean).join(' ') || null : null,
    lines,
  };
}

/** A receipt. Outside the caller's outlets it is "not found", like every other outlet-scoped record. */
async function getSale({ context, id }) {
  const db = scopedDb().for(context);
  const sale = await db.table('supermarket_sales').where({ id }).first('outlet_id');
  if (!sale) throw new errors.SupermarketSaleNotFoundError();
  const scope = context.isImpersonation ? null : await outletScopeForUser(db, context.userId);
  if (!scopeCovers(scope, [sale.outlet_id])) throw new errors.SupermarketSaleNotFoundError();
  return getSaleWith(db, id);
}

/** Sales for the report, newest first (max 200). Dates are the property's business dates. */
async function listSales({ context, outletId, from, to, limit = 100 }) {
  const db = scopedDb().for(context);
  const scope = context.isImpersonation ? null : await outletScopeForUser(db, context.userId);
  // Both ends: a validated inclusive range. One end alone keeps its old meaning (open-ended: `/supermarket/report`
  // and any caller that sends only `from` or only `to`); the totals endpoint reads a lone end as a single day.
  const range = from && to ? resolveDateRange({ from, to }) : from || to ? { from: from ? validDate(from, 'from') : null, to: to ? validDate(to, 'to') : null } : null;
  const query = salesQuery(db, { range, outletId }).orderBy('supermarket_sales.id', 'desc').limit(Math.min(Number(limit) || 100, 200)).select('supermarket_sales.*');
  const rows = await query;
  return rows.filter((row) => scopeCovers(scope, [row.outlet_id]));
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

function validDate(value, field) {
  const text = String(value ?? '').trim();
  const parsed = DATE_PATTERN.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ValidationError('INVALID_DATE', `"${field}" must be a real date as YYYY-MM-DD.`, [{ field, issue: 'invalid' }]);
  }
  return text;
}

/** A business-date range `{from, to}` (inclusive): one end alone means that single day; from must not be after to; at most a year. */
function resolveDateRange({ from, to }) {
  const start = validDate(from ?? to, from ? 'from' : 'to');
  const end = validDate(to ?? from, to ? 'to' : 'from');
  if (start > end) throw new ValidationError('INVALID_DATE_RANGE', '"from" must not be after "to".', [{ field: 'from', issue: 'after_to' }]);
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  if (days > MAX_RANGE_DAYS) throw new ValidationError('DATE_RANGE_TOO_LONG', `Choose at most ${MAX_RANGE_DAYS} days at a time.`, [{ field: 'to', issue: 'too_long' }]);
  return { from: start, to: end };
}

/**
 * The supermarket sales query. With a `range` it keeps the sales settled on those BUSINESS dates (the property's
 * accounting date, the same as "Today's sales" and the hotel reports: `created_at` is UTC and would move a
 * sale just after midnight local time onto the wrong day).
 */
function salesQuery(db, { range, outletId, userId }) {
  let query = db.table('supermarket_sales');
  if (range) {
    query = query.joinScoped('pos_order_settlements', (join) => join.on('pos_order_settlements.id', '=', 'supermarket_sales.settlement_id'));
    if (range.from) query = query.where('pos_order_settlements.business_date', '>=', range.from);
    if (range.to) query = query.where('pos_order_settlements.business_date', '<=', range.to);
  }
  if (outletId) query = query.where('supermarket_sales.outlet_id', outletId);
  if (userId) query = query.where('supermarket_sales.sold_by_user_id', userId);
  return query;
}

/**
 * How a sale was paid, as the cash-up reads it: cash; the card machine (`terminal`); or an online (Paystack) sale by
 * the channel the customer used: card, bank transfer, anything else (USSD, QR, ...).
 */
const METHOD_ORDER = ['cash', 'terminal', 'online_card', 'online_transfer', 'online_other'];
function methodKey(row) {
  if (row.method === 'cash') return 'cash';
  if (row.method === 'terminal') return 'terminal';
  const channel = String(row.provider_channel ?? '').toLowerCase();
  if (channel === 'card') return 'online_card';
  if (channel === 'bank_transfer') return 'online_transfer';
  return 'online_other';
}

/** The sums over ALL the sales in view (not a capped list): non-voided total, tax and subtotal, with the voided sales counted apart. */
function totalsOf(rows, range) {
  const kept = rows.filter((row) => !row.voided_at);
  const voided = rows.filter((row) => row.voided_at);
  return {
    from: range.from,
    to: range.to,
    saleCount: kept.length,
    voidedCount: voided.length,
    subtotal: sumMoney(kept.map((row) => row.subtotal)),
    tax: sumMoney(kept.map((row) => row.tax_amount)),
    total: sumMoney(kept.map((row) => row.total)),
    voidedTotal: sumMoney(voided.map((row) => row.total)),
    // The same non-voided total split by how it was paid. Cash is always listed (the drawer), the rest only when used.
    byMethod: METHOD_ORDER.map((method) => {
      const group = kept.filter((row) => methodKey(row) === method);
      return { method, saleCount: group.length, total: sumMoney(group.map((row) => row.total)) };
    }).filter((entry) => entry.method === 'cash' || entry.saleCount > 0),
  };
}

/**
 * Totals for the manager's "All sales" view: the outlet's sales over a business-date range (default the property's
 * current business date). `supermarket.report`; the outlet must be one the caller covers.
 */
async function salesTotals({ context, outletId, from, to }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const range = await rangeOrToday(db, context, { from, to });
  const rows = await withPaymentChannel(salesQuery(db, { range, outletId }));
  return totalsOf(rows, range);
}

/** Totals for the cashier's own "Today's sales": their sales at the outlet on the current business date. `supermarket.sales`. */
async function mySalesTotals({ context, outletId }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const range = await rangeOrToday(db, context, {});
  const rows = await withPaymentChannel(salesQuery(db, { range, outletId, userId: context.userId }));
  return totalsOf(rows, range);
}

/** What the totals read: the amounts, voided flag and method of each sale, with the payment's channel (bank transfer, card...) for online sales. */
function withPaymentChannel(query) {
  return query
    .joinScoped('payments', (join) => join.on('payments.id', '=', 'pos_order_settlements.payment_id'), { type: 'left' })
    .select('supermarket_sales.subtotal', 'supermarket_sales.tax_amount', 'supermarket_sales.total', 'supermarket_sales.voided_at', 'supermarket_sales.method', 'payments.provider_channel');
}

async function rangeOrToday(db, context, { from, to }) {
  if (from || to) return resolveDateRange({ from, to });
  const property = await db.table('properties').where({ id: context.propertyId }).first('current_business_date');
  const today = property?.current_business_date ? String(property.current_business_date).slice(0, 10) : null;
  if (!today) throw new ValidationError('NO_BUSINESS_DATE', 'This property has no business date yet: choose a date range.', [{ field: 'from', issue: 'missing' }]);
  return { from: today, to: today };
}

/** Totals over a date range: by outlet, and top products from the receipt snapshots (voided sales excluded). */
async function summarize({ context, outletId, from, to }) {
  const db = scopedDb().for(context);
  const sales = (await listSales({ context, outletId, from, to, limit: 200 })).filter((sale) => !sale.voided_at);
  const byOutlet = new Map();
  for (const sale of sales) {
    const entry = byOutlet.get(String(sale.outlet_id)) ?? { outletId: sale.outlet_id, sales: 0, subtotal: [], tax: [], total: [] };
    entry.sales += 1;
    entry.subtotal.push(sale.subtotal);
    entry.tax.push(sale.tax_amount);
    entry.total.push(sale.total);
    byOutlet.set(String(sale.outlet_id), entry);
  }
  const lineRows = sales.length ? await db.table('supermarket_sale_lines').whereIn('sale_id', sales.map((s) => s.id)) : [];
  const byItem = new Map();
  for (const line of lineRows) {
    const key = String(line.menu_item_id ?? line.item_name);
    const entry = byItem.get(key) ?? { name: line.item_name, quantity: 0, net: [], tax: [], gross: [] };
    entry.quantity += line.quantity;
    entry.net.push(line.line_net);
    entry.tax.push(line.line_tax);
    entry.gross.push(line.line_total);
    byItem.set(key, entry);
  }
  return {
    saleCount: sales.length,
    subtotal: sumMoney(sales.map((s) => s.subtotal)),
    tax: sumMoney(sales.map((s) => s.tax_amount)),
    total: sumMoney(sales.map((s) => s.total)),
    byOutlet: [...byOutlet.values()].map((e) => ({ outletId: e.outletId, sales: e.sales, subtotal: sumMoney(e.subtotal), tax: sumMoney(e.tax), total: sumMoney(e.total) })),
    topItems: [...byItem.values()]
      .map((e) => ({ name: e.name, quantity: e.quantity, net: sumMoney(e.net), tax: sumMoney(e.tax), gross: sumMoney(e.gross) }))
      .sort((a, b) => (toCents(b.gross) > toCents(a.gross) ? 1 : toCents(b.gross) < toCents(a.gross) ? -1 : 0))
      .slice(0, 20),
  };
}

// ---------------------------------------------------------------- Stage 2: setup flags, low stock, reprint

/**
 * Products the outlet sells that need setup: no barcode (cannot be scanned) and/or no stock
 * recipe (a sale never deducts stock). Informational only; selling is never blocked by it.
 */
async function listSetupFlags({ context, outletId }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const items = await outletMenu.menuItemsForOutlet(db, outletId);
  if (items.length === 0) return { items: [], counts: { missing_barcode: 0, not_stock_tracked: 0 } };
  const ids = items.map((item) => item.id);
  const barcoded = new Set((await db.table('supermarket_barcodes').whereIn('menu_item_id', ids).select('menu_item_id')).map((row) => String(row.menu_item_id)));
  const tracked = new Set((await db.table('pos_menu_item_components').whereIn('menu_item_id', ids).select('menu_item_id')).map((row) => String(row.menu_item_id)));
  const flagged = items
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.price,
      missing_barcode: !barcoded.has(String(item.id)),
      not_stock_tracked: !tracked.has(String(item.id)),
    }))
    .filter((item) => item.missing_barcode || item.not_stock_tracked);
  return {
    items: flagged,
    counts: { missing_barcode: flagged.filter((i) => i.missing_barcode).length, not_stock_tracked: flagged.filter((i) => i.not_stock_tracked).length },
  };
}

/** Stock at or below its reorder level at the outlet, lowest first, for the till's banner. Carries no cost. */
async function listLowStock({ context, outletId }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const rows = await stockService.listStockItems({ context, outletId, lowStockOnly: true });
  const items = rows
    .map((row) => ({ id: row.id, name: row.name, unit: row.unit, current_quantity: row.current_quantity, reorder_level: row.reorder_level }))
    .sort((a, b) => Number(a.current_quantity) - Number(b.current_quantity));
  return { total: items.length, items: items.slice(0, MAX_LOW_STOCK) };
}

/** The caller's own sales on the property's current business date, newest first (for a cashier's reprint). */
async function listMySalesToday({ context, outletId }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const property = await db.table('properties').where({ id: context.propertyId }).first('current_business_date');
  if (!property?.current_business_date) return [];
  const rows = await db
    .table('supermarket_sales')
    .joinScoped('pos_order_settlements', (join) => join.on('pos_order_settlements.id', '=', 'supermarket_sales.settlement_id'))
    .where('supermarket_sales.outlet_id', outletId)
    .where('supermarket_sales.sold_by_user_id', context.userId)
    .where('pos_order_settlements.business_date', property.current_business_date)
    .orderBy('supermarket_sales.id', 'desc')
    .limit(MAX_MY_SALES)
    .select('supermarket_sales.*');
  const outlet = await db.table('pos_outlets').where({ id: outletId }).first('id', 'code');
  return rows.map((row) => ({ ...row, receipt_code: receiptCode(outlet, row.receipt_number) }));
}

/** Voids the sale (and its settlement and stock), keeping the receipt number. `trx`-based; the controller has already claimed a manager's PIN approval (`src/modules/approvals`) in the same transaction. */
async function voidSale({ trx, id, reason, userId }) {
  if (!reason || !String(reason).trim()) throw new ValidationError('MISSING_FIELD', '"reason" is required to void a sale.', [{ field: 'reason', issue: 'missing' }]);
  const sale = await trx.table('supermarket_sales').where({ id }).forUpdate().first();
  if (!sale) throw new errors.SupermarketSaleNotFoundError();
  if (sale.voided_at) throw new errors.SupermarketSaleAlreadyVoidedError();
  await posService.voidSettlement({ trx, settlementId: sale.settlement_id, reason: String(reason).trim(), userId });
  await trx.table('supermarket_sales').where({ id }).update({ voided_at: new Date() });
  return getSaleWith(trx, id);
}

module.exports = { cleanBarcode, requireSupermarketOutlet, MAX_BARCODE_LENGTH, MAX_LINES, forTill, resolveSaleLines, openQuickSaleOrder, recordReceiptedSale, getSaleWith, takeReceiptNumber, stockOnHand, listMyOutlets, listBarcodes, addBarcode, removeBarcode, lookupByBarcode, searchItems, createSale, getSale, listSales, salesTotals, mySalesTotals, summarize, voidSale, receiptCode, listSetupFlags, listLowStock, listMySalesToday };
