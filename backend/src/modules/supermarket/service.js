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

async function listBarcodes({ context, menuItemId }) {
  const db = scopedDb().for(context);
  const query = db.table('supermarket_barcodes').orderBy('id');
  return menuItemId ? query.where({ menu_item_id: menuItemId }) : query;
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

/** One product at the outlet by barcode (exact) — what a scanner sends. */
async function lookupByBarcode({ context, outletId, barcode }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const code = cleanBarcode(barcode);
  const row = await db.table('supermarket_barcodes').where({ barcode: code }).first();
  if (!row) throw new errors.BarcodeNotFoundError(code);
  const item = await outletMenu.menuItemAtOutlet(db, outletId, row.menu_item_id);
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
  return items.filter((item) => String(item.name).toLowerCase().includes(needle)).slice(0, 30);
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
 * `trx`-based, called from `runIdempotentMutation`. `lines`: `[{barcode | menu_item_id, quantity}]`.
 * Opens the tab, adds the lines, settles it and records the receipt, all in the caller's transaction.
 */
async function createSale({ trx, context, userId, outletId, lines, method, terminalId = null, terminal, terminalAccountId }) {
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

  // Resolve every line first (a bad barcode refuses the whole sale before anything is written).
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
    const menuItem = await outletMenu.menuItemAtOutlet(trx, outlet.id, menuItemId);
    if (!menuItem) throw new ValidationError('MENU_ITEM_NOT_FOUND', `Line ${index + 1}: this outlet does not sell that product.`, [{ field: `items[${index}]`, issue: 'not_found' }]);
    if (!menuItem.is_available) throw new ValidationError('POS_ITEM_UNAVAILABLE', `"${menuItem.name}" is currently marked unavailable.`, [{ field: `items[${index}]`, issue: 'unavailable' }]);
    const priced = resolveOrderLine({ menuItem, unitPrice: menuItem.price, quantity: line.quantity, modifiers: undefined });
    resolved.push({ menuItem, barcode, quantity: priced.quantity });
  }

  const [orderId] = await trx.table('pos_orders').insert({
    outlet_id: outlet.id,
    terminal_id: terminalId,
    opened_by_user_id: userId ?? null,
    table_label: 'Quick sale',
    source: 'staff',
  });
  const itemRows = [];
  for (const line of resolved) {
    const row = { pos_order_id: orderId, menu_item_id: line.menuItem.id, quantity: line.quantity, unit_price: line.menuItem.price, modifiers: null };
    const [itemId] = await trx.table('pos_order_items').insert(row);
    itemRows.push({ ...row, id: itemId });
  }

  const { settlements } = await posService.settleOrder({
    trx,
    orderId,
    settledByUserId: userId,
    settlements: [{ splitGroup: null, method, terminal: terminal ?? {}, terminalAccountId, tipAmount: undefined, serviceCharge: undefined }],
    stockOverrideReason: stockService.AUTOMATIC_OVERRIDE_REASON_SUPERMARKET,
  });
  const settlement = settlements[0];

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
      item_name: resolved[index].menuItem.name,
      barcode: resolved[index].barcode,
      quantity: row.quantity,
      unit_price: row.unit_price,
      line_total: lineTotals[index],
      line_net: split[index].net,
      line_tax: split[index].tax,
    });
  }
  return getSaleWith(trx, saleId);
}

/** A sale with its lines and outlet, in the shape the receipt shows. */
async function getSaleWith(db, saleId) {
  const sale = await db.table('supermarket_sales').where({ id: saleId }).first();
  if (!sale) throw new errors.SupermarketSaleNotFoundError();
  const outlet = await db.table('pos_outlets').where({ id: sale.outlet_id }).first('id', 'code', 'name');
  const lines = await db.table('supermarket_sale_lines').where({ sale_id: sale.id }).orderBy('line_no');
  const seller = sale.sold_by_user_id ? await db.table('users').where({ id: sale.sold_by_user_id }).first('first_name', 'last_name') : null;
  return {
    ...sale,
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
  const query = db.table('supermarket_sales').orderBy('id', 'desc').limit(Math.min(Number(limit) || 100, 200));
  if (outletId) query.where({ outlet_id: outletId });
  if (from) query.where('created_at', '>=', `${from} 00:00:00`);
  if (to) query.where('created_at', '<=', `${to} 23:59:59`);
  const rows = await query;
  return rows.filter((row) => scopeCovers(scope, [row.outlet_id]));
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

/** Voids the sale (and its settlement and stock), keeping the receipt number. `trx`-based, manager-level. */
async function voidSale({ trx, id, reason, userId }) {
  if (!reason || !String(reason).trim()) throw new ValidationError('MISSING_FIELD', '"reason" is required to void a sale.', [{ field: 'reason', issue: 'missing' }]);
  const sale = await trx.table('supermarket_sales').where({ id }).forUpdate().first();
  if (!sale) throw new errors.SupermarketSaleNotFoundError();
  if (sale.voided_at) throw new errors.SupermarketSaleAlreadyVoidedError();
  await posService.voidSettlement({ trx, settlementId: sale.settlement_id, reason: String(reason).trim(), userId });
  await trx.table('supermarket_sales').where({ id }).update({ voided_at: new Date() });
  return getSaleWith(trx, id);
}

module.exports = { listMyOutlets, listBarcodes, addBarcode, removeBarcode, lookupByBarcode, searchItems, createSale, getSale, listSales, summarize, voidSale, receiptCode };
