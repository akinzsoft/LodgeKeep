'use strict';

/**
 * Supermarket product editing (`supermarket.manage`): list a mart's products,
 * change a product's price, name, category and cost, archive and restore it.
 *
 * Menu items are ONE property-wide set and an outlet sells every item in the
 * categories it carries, so a row the mart sells can also be on a hotel
 * outlet's menu when that outlet carries the same category. This module never
 * changes a hotel menu: every edit, archive and restore is refused, naming the
 * outlet, while any active hotel selling outlet carries the product's category
 * (the same rule the CSV import applies at creation). It does not call or
 * change the shared `PATCH /pos/menu-items`; it writes through the scoped
 * accessor and audits every change.
 *
 * Past sales never change: a sale line snapshots name, price, net and tax
 * (`supermarket_sale_lines`) and an order line its `unit_price`. Profit and
 * margin reports use the CURRENT cost (existing behaviour), so a cost edit
 * shifts past profit figures but never a receipt.
 *
 * The product's cost lives on its stock item (the 1:1 recipe), not on the
 * menu item (whose `cost_price` is only a fallback for items with no recipe),
 * so a cost edit writes both. A rename or category change is mirrored onto
 * the linked stock item when the product is its only user.
 *
 * Lock order (stock/service.js header): stock items first (the recipe's
 * closure, sorted), then the menu item row. Everything is discovered with
 * plain reads before the transaction and re-checked under the locks.
 */

const { scopedDb } = require('../../db');
const { ValidationError } = require('../../shared/errors');
const outletMenu = require('../../shared/outlet-menu');
const { isHotelSellingOutlet } = require('../../shared/outlet-types');
const stockService = require('../stock/service');
const { requireSupermarketOutlet } = require('./service');
const errors = require('./errors');
const { keyOf } = require('./product-import');

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const MAX_NAME_LENGTH = 150;
const EDITABLE_FIELDS = ['price', 'name', 'category', 'cost_price'];

const badField = (field, message) => new ValidationError('INVALID_PRODUCT_FIELD', message, [{ field, issue: 'invalid' }]);

/** The edit's changes, validated: only known fields, at least one, money as exact decimal strings. */
function parseChanges(body) {
  const changes = {};
  for (const field of EDITABLE_FIELDS) {
    if (body?.[field] === undefined) continue;
    const raw = body[field];
    if (field === 'name') {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name || name.length > MAX_NAME_LENGTH) throw badField('name', `"name" must be 1 to ${MAX_NAME_LENGTH} characters.`);
      changes.name = name;
    } else if (field === 'category') {
      const category = typeof raw === 'string' ? raw.trim() : '';
      if (!category) throw badField('category', '"category" is required.');
      changes.category = category;
    } else if (field === 'price') {
      const price = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
      if (!MONEY_PATTERN.test(price)) throw badField('price', '"price" must be a non-negative amount with at most 2 decimal places.');
      changes.price = price;
    } else {
      // cost_price: null/'' clears the fallback; otherwise an exact amount.
      if (raw === null || raw === '') changes.cost_price = null;
      else {
        const cost = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
        if (!MONEY_PATTERN.test(cost)) throw badField('cost_price', '"cost_price" must be a non-negative amount with at most 2 decimal places, or null.');
        changes.cost_price = cost;
      }
    }
  }
  if (Object.keys(changes).length === 0) throw new ValidationError('MISSING_FIELD', 'Send at least one of price, name, category or cost_price.', [{ field: 'price', issue: 'missing' }]);
  return changes;
}

/** Active hotel selling outlets (not a supermarket, not a store room) that carry a category, by category id. */
async function hotelOutletsByCategory(db) {
  const rows = await db
    .table('pos_outlet_categories')
    .joinScoped('pos_outlets', (join) => join.on('pos_outlets.id', '=', 'pos_outlet_categories.outlet_id'))
    .select('pos_outlet_categories.category_id', 'pos_outlets.name', 'pos_outlets.type', 'pos_outlets.status');
  const byCategory = new Map();
  for (const row of rows) {
    if (!isHotelSellingOutlet(row)) continue;
    const key = String(row.category_id);
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(row.name);
  }
  return byCategory;
}

/** The categories the outlet carries, as rows (any status), keyed by normalised name. */
async function carriedCategories(db, outletId) {
  const rows = await db
    .table('pos_outlet_categories')
    .joinScoped('pos_menu_categories', (join) => join.on('pos_menu_categories.id', '=', 'pos_outlet_categories.category_id'))
    .where({ 'pos_outlet_categories.outlet_id': outletId })
    .select('pos_menu_categories.id', 'pos_menu_categories.name', 'pos_menu_categories.status');
  return new Map(rows.map((row) => [keyOf(row.name), row]));
}

/** Reads one product as the outlet sees it, or throws not-found when the outlet does not carry its category. */
async function loadProduct(db, outletId, id, { lock = false } = {}) {
  const query = db.table('pos_menu_items').where({ id });
  const item = await (lock ? query.forUpdate() : query).first();
  if (!item) throw new errors.ProductNotFoundError();
  const carried = await carriedCategories(db, outletId);
  const category = carried.get(keyOf(item.category));
  if (!category) throw new errors.ProductNotFoundError();
  return { item, category, carried };
}

async function assertNotSharedWithHotel(db, categoryIds) {
  const hotel = await hotelOutletsByCategory(db);
  const names = new Set();
  for (const categoryId of categoryIds) for (const name of hotel.get(String(categoryId)) ?? []) names.add(name);
  if (names.size) throw new errors.ProductSharedWithHotelError([...names].sort());
}

async function assertNameFree(db, { name, category, exceptId }) {
  const sameCategory = await db.table('pos_menu_items').where({ status: 'active', category }).select('id', 'name');
  if (sameCategory.some((row) => String(row.id) !== String(exceptId) && keyOf(row.name) === keyOf(name))) {
    throw new errors.ProductNameTakenError(name, category);
  }
}

/** The product as the Setup list shows it. */
function present(item, { barcodes, units, stockCost, sharedWith, outletPrice }) {
  return {
    id: String(item.id),
    name: item.name,
    category: item.category,
    // What this outlet charges: its own price for the product when it has one, else the shared price.
    price: outletPrice ?? item.price,
    cost_price: item.cost_price ?? null,
    stock_cost: stockCost ?? null,
    status: item.status,
    barcodes,
    units_on_hand: units ?? null,
    shared_with: sharedWith,
  };
}

/**
 * Every product the outlet sells (its carried categories), archived ones too when asked.
 * `shared_with` names the hotel outlets that also carry the product's category, which is
 * why such a product cannot be edited here.
 */
async function listProducts({ context, outletId, includeArchived = false }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  const carried = await carriedCategories(db, outletId);
  const names = [...carried.values()].map((row) => row.name);
  if (names.length === 0) return [];
  let query = db.table('pos_menu_items').whereIn('category', names);
  if (!includeArchived) query = query.where({ status: 'active' });
  const items = await query.orderBy('category').orderBy('name');
  if (items.length === 0) return [];
  const ids = items.map((item) => item.id);

  const barcodeRows = await db.table('supermarket_barcodes').whereIn('menu_item_id', ids).select('menu_item_id', 'barcode').orderBy('id');
  const barcodesByItem = new Map();
  for (const row of barcodeRows) {
    const key = String(row.menu_item_id);
    if (!barcodesByItem.has(key)) barcodesByItem.set(key, []);
    barcodesByItem.get(key).push(row.barcode);
  }
  const units = await stockService.unitsOnHandForMenuItems({ trx: db, menuItemIds: ids, outletId });
  const components = await db.table('pos_menu_item_components').whereIn('menu_item_id', ids).select('menu_item_id', 'stock_item_id', 'quantity');
  const stockIds = [...new Set(components.map((row) => Number(row.stock_item_id)))];
  const stockRows = stockIds.length ? await db.table('stock_items').whereIn('id', stockIds).select('id', 'purchase_cost') : [];
  const costByStock = new Map(stockRows.map((row) => [String(row.id), row.purchase_cost]));
  const componentsByItem = new Map();
  for (const row of components) {
    const key = String(row.menu_item_id);
    if (!componentsByItem.has(key)) componentsByItem.set(key, []);
    componentsByItem.get(key).push(row);
  }
  const overrides = await db.table('pos_outlet_menu_items').where({ outlet_id: outletId }).whereIn('menu_item_id', ids).select('menu_item_id', 'price');
  const outletPriceByItem = new Map(overrides.filter((row) => row.price !== null).map((row) => [String(row.menu_item_id), row.price]));
  const hotel = await hotelOutletsByCategory(db);

  return items.map((item) => {
    const recipe = componentsByItem.get(String(item.id)) ?? [];
    const category = carried.get(keyOf(item.category));
    return present(item, {
      barcodes: barcodesByItem.get(String(item.id)) ?? [],
      units: units.get(String(item.id)),
      stockCost: recipe.length === 1 ? (costByStock.get(String(recipe[0].stock_item_id)) ?? null) : null,
      sharedWith: category ? (hotel.get(String(category.id)) ?? []) : [],
      outletPrice: outletPriceByItem.get(String(item.id)),
    });
  });
}

/**
 * Runs `change` under the product's locks: the recipe's stock items first (sorted), then the menu item
 * row. The recipe seen before the locks must still be the recipe under them.
 */
async function withProductLocked({ context, outletId, id, change }) {
  const db = scopedDb().for(context);
  await requireSupermarketOutlet({ db, context, outletId });
  await loadProduct(db, outletId, id); // 404 before any lock for a product this outlet does not carry
  const seen = await db.table('pos_menu_item_components').where({ menu_item_id: id }).select('stock_item_id');
  return db.transaction(async (trx) => {
    const closure = await stockService.resolveLockClosure({ trx, stockItemIds: seen.map((row) => row.stock_item_id) });
    const lockedStock = await stockService.lockStockItemsSorted({ trx, stockItemIds: closure });
    const { item, category, carried } = await loadProduct(trx, outletId, id, { lock: true });
    const recipe = await trx.table('pos_menu_item_components').where({ menu_item_id: id }).select('stock_item_id', 'quantity');
    const sameRecipe = recipe.length === seen.length && recipe.every((row) => seen.some((s) => String(s.stock_item_id) === String(row.stock_item_id)));
    if (!sameRecipe) throw new errors.ProductChangedError();
    return change({ trx, item, category, carried, recipe, lockedStock });
  });
}

/** The single stock item behind a product when its recipe is one component at quantity 1 (what the import builds), else null. */
function linkedStockItem(recipe, lockedStock) {
  if (recipe.length !== 1 || Number(recipe[0].quantity) !== 1) return null;
  return lockedStock.get(String(recipe[0].stock_item_id)) ?? null;
}

async function usedByOtherProduct(trx, stockItemId, menuItemId) {
  const rows = await trx.table('pos_menu_item_components').where({ stock_item_id: stockItemId }).select('menu_item_id');
  return rows.some((row) => String(row.menu_item_id) !== String(menuItemId));
}

async function presentOne(trx, outletId, id) {
  const { item, category } = await loadProduct(trx, outletId, id);
  const barcodes = (await trx.table('supermarket_barcodes').where({ menu_item_id: id }).select('barcode').orderBy('id')).map((row) => row.barcode);
  const units = await stockService.unitsOnHandForMenuItems({ trx, menuItemIds: [id], outletId });
  const recipe = await trx.table('pos_menu_item_components').where({ menu_item_id: id }).select('stock_item_id', 'quantity');
  const stock = recipe.length === 1 ? await trx.table('stock_items').where({ id: recipe[0].stock_item_id }).first('purchase_cost') : null;
  const override = await trx.table('pos_outlet_menu_items').where({ outlet_id: outletId, menu_item_id: id }).first('price');
  const hotel = await hotelOutletsByCategory(trx);
  return present(item, { barcodes, units: units.get(String(id)), stockCost: stock?.purchase_cost ?? null, sharedWith: hotel.get(String(category.id)) ?? [], outletPrice: override?.price ?? undefined });
}

/** Changes price, name, category and/or cost. Returns `{ before, after }` (the product as listed). */
async function editProduct({ context, outletId, id, body }) {
  const changes = parseChanges(body);
  return withProductLocked({
    context,
    outletId,
    id,
    change: async ({ trx, item, category, carried, recipe, lockedStock }) => {
      const before = await presentOne(trx, outletId, id);
      let targetCategory = category;
      const update = {};
      const stockUpdate = {};

      if (changes.category !== undefined && keyOf(changes.category) !== keyOf(item.category)) {
        targetCategory = carried.get(keyOf(changes.category));
        if (!targetCategory || targetCategory.status !== 'active') throw new errors.ProductCategoryNotCarriedError(changes.category);
        update.category = targetCategory.name;
        stockUpdate.category = targetCategory.name;
      }
      // Hotel isolation: the row's current category AND any new one must be mart-only.
      await assertNotSharedWithHotel(trx, new Set([category.id, targetCategory.id]));

      if (changes.name !== undefined && changes.name !== item.name) {
        update.name = changes.name;
        stockUpdate.name = changes.name;
      }
      if (changes.price !== undefined) {
        update.price = changes.price;
        // A price this outlet set for itself (POS Setup) would keep winning on the till, so the new price replaces it.
        await trx.table('pos_outlet_menu_items').where({ outlet_id: outletId, menu_item_id: item.id }).update({ price: null });
      }
      if (changes.cost_price !== undefined) update.cost_price = changes.cost_price;

      if (item.status === 'active' && (update.name !== undefined || update.category !== undefined)) {
        await assertNameFree(trx, { name: update.name ?? item.name, category: update.category ?? item.category, exceptId: item.id });
      }

      const stock = linkedStockItem(recipe, lockedStock);
      const sharedStock = stock ? await usedByOtherProduct(trx, stock.id, item.id) : false;
      if (!stock && recipe.length > 0 && changes.cost_price !== undefined && changes.cost_price !== null) {
        // Reports cost this product from its recipe, so a menu-only cost would change nothing.
        throw new errors.ProductCostSharedError("This product's stock recipe is not a single stock item, so its cost is set in Stock.");
      }
      if (stock && changes.cost_price !== undefined && changes.cost_price !== null) {
        if (sharedStock) throw new errors.ProductCostSharedError();
        await trx.table('stock_items').where({ id: stock.id }).update({ purchase_cost: changes.cost_price });
      }
      // A rename or category change follows the stock item only when this product is its one user.
      if (stock && !sharedStock && Object.keys(stockUpdate).length) {
        if (stockUpdate.category !== undefined) {
          const twin = await trx.table('stock_item_categories').where({ name: stockUpdate.category, status: 'active' }).first('id');
          if (!twin) delete stockUpdate.category;
        }
        if (Object.keys(stockUpdate).length) await trx.table('stock_items').where({ id: stock.id }).update(stockUpdate);
      }

      if (Object.keys(update).length) await trx.table('pos_menu_items').where({ id: item.id }).update(update);
      return { before, after: await presentOne(trx, outletId, id) };
    },
  });
}

/** Archives (hides from the till; sales history, barcodes and stock stay) or restores a product. */
async function setProductArchived({ context, outletId, id, archived }) {
  const wanted = archived ? 'archived' : 'active';
  return withProductLocked({
    context,
    outletId,
    id,
    change: async ({ trx, item, category }) => {
      const before = await presentOne(trx, outletId, id);
      if (item.status === wanted) return { before, after: before, changed: false };
      await assertNotSharedWithHotel(trx, [category.id]);
      if (!archived) await assertNameFree(trx, { name: item.name, category: item.category, exceptId: item.id });
      await trx.table('pos_menu_items').where({ id: item.id }).update({ status: wanted });
      return { before, after: await presentOne(trx, outletId, id), changed: true };
    },
  });
}

module.exports = { listProducts, editProduct, setProductArchived, parseChanges };
