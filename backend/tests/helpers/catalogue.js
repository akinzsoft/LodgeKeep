'use strict';

/**
 * Test helpers for the shared POS catalogue (migration
 * 20261108090000_shared_pos_catalogue). Categories, menu items and stock
 * items belong to the property; an outlet carries categories
 * (`pos_outlet_categories`), keeps its own price/availability of an item
 * (`pos_outlet_menu_items`) and its own quantity of a stock item
 * (`stock_levels`). Tests used to insert these rows with an `outlet_id`;
 * these helpers take the same shape (including `outlet_id`,
 * `current_quantity`, `reorder_level`, `is_available`) and write the shared
 * row plus the outlet's link, so a test reads as before.
 *
 * `db` is any knex-style callable (`t.trx`, `db()`, a raw `knex`). Each
 * insert helper returns `[id]` (or one id per row), like knex's own
 * `insert`, so `const [id] = await insertMenuItem(...)` keeps working.
 */

const asArray = (rows) => (Array.isArray(rows) ? rows : [rows]);

/** Registers a category of the property (once per name) and makes `outlet_id` (if given) carry it. Returns its id. */
async function ensureMenuCategory(db, { tenant_id, property_id, outlet_id, name, sort_order, status }) {
  let category = await db('pos_menu_categories').where({ tenant_id, property_id, name }).first('id');
  if (!category) {
    const row = { tenant_id, property_id, name };
    if (sort_order !== undefined) row.sort_order = sort_order;
    if (status !== undefined) row.status = status;
    const [id] = await db('pos_menu_categories').insert(row);
    category = { id };
  }
  if (outlet_id) {
    const carried = await db('pos_outlet_categories').where({ outlet_id, category_id: category.id }).first('id');
    if (!carried) await db('pos_outlet_categories').insert({ tenant_id, property_id, outlet_id, category_id: category.id });
  }
  return category.id;
}

async function insertMenuCategories(db, rows) {
  const ids = [];
  for (const row of asArray(rows)) ids.push(await ensureMenuCategory(db, row));
  return ids;
}

/** A stock category of the property, and (when `outlet_id` is given) its matching menu category carried there. */
async function insertStockCategories(db, rows) {
  const ids = [];
  for (const { outlet_id, ...row } of asArray(rows)) {
    let category = await db('stock_item_categories').where({ tenant_id: row.tenant_id, property_id: row.property_id, name: row.name }).first('id');
    if (!category) {
      const [id] = await db('stock_item_categories').insert(row);
      category = { id };
    }
    if (outlet_id) await ensureMenuCategory(db, { tenant_id: row.tenant_id, property_id: row.property_id, outlet_id, name: row.name });
    ids.push(category.id);
  }
  return ids;
}

/** A shared menu item; with `outlet_id`, that outlet carries its category (and gets `is_available`/`stock_auto_unavailable`, if given). */
async function insertMenuItem(db, rows) {
  const ids = [];
  for (const { outlet_id, is_available, stock_auto_unavailable, ...row } of asArray(rows)) {
    if (row.category) await ensureMenuCategory(db, { tenant_id: row.tenant_id, property_id: row.property_id, outlet_id, name: row.category });
    const [id] = await db('pos_menu_items').insert(row);
    if (outlet_id && (is_available !== undefined || stock_auto_unavailable !== undefined)) {
      await db('pos_outlet_menu_items').insert({
        tenant_id: row.tenant_id,
        property_id: row.property_id,
        outlet_id,
        menu_item_id: id,
        is_available: is_available ?? true,
        stock_auto_unavailable: stock_auto_unavailable ?? false,
      });
    }
    ids.push(id);
  }
  return ids;
}

/** A shared stock item; with `outlet_id`, that outlet's level holds `current_quantity`/`reorder_level`. */
async function insertStockItem(db, rows) {
  const ids = [];
  for (const { outlet_id, ...row } of asArray(rows)) {
    const [id] = await db('stock_items').insert(row);
    if (outlet_id) {
      const level = { tenant_id: row.tenant_id, property_id: row.property_id, outlet_id, stock_item_id: id };
      if (row.current_quantity !== undefined) level.current_quantity = row.current_quantity;
      if (row.reorder_level !== undefined) level.reorder_level = row.reorder_level;
      await db('stock_levels').insert(level);
    }
    ids.push(id);
  }
  return ids;
}

/** Sets a stock item's quantity directly (a test shortcut past the movement ledger): every outlet level it has, and the total. */
async function setStockQuantity(db, stockItemId, quantity) {
  await db('stock_items').where({ id: stockItemId }).update({ current_quantity: quantity });
  await db('stock_levels').where({ stock_item_id: stockItemId }).update({ current_quantity: quantity });
}

async function sellingOutletIds(db, menuItemId) {
  const item = await db('pos_menu_items').where({ id: menuItemId }).first('tenant_id', 'property_id', 'category');
  const category = await db('pos_menu_categories').where({ tenant_id: item.tenant_id, property_id: item.property_id, name: item.category }).first('id');
  if (!category) return { item, outletIds: [] };
  const rows = await db('pos_outlet_categories').where({ category_id: category.id }).select('outlet_id');
  return { item, outletIds: rows.map((row) => row.outlet_id) };
}

/** Sets an item's availability at every outlet that sells it (the old single-outlet `is_available` write). */
async function setOutletAvailability(db, menuItemId, changes) {
  const { item, outletIds } = await sellingOutletIds(db, menuItemId);
  for (const outletId of outletIds) {
    const existing = await db('pos_outlet_menu_items').where({ outlet_id: outletId, menu_item_id: menuItemId }).first('id');
    if (existing) await db('pos_outlet_menu_items').where({ id: existing.id }).update(changes);
    else await db('pos_outlet_menu_items').insert({ tenant_id: item.tenant_id, property_id: item.property_id, outlet_id: outletId, menu_item_id: menuItemId, ...changes });
  }
}

/**
 * The item as one outlet sells it — `is_available`/`stock_auto_unavailable`
 * as 0/1 like the old columns (1/0 when no per-outlet row exists). Without
 * `outletId`, the first outlet that sells it.
 */
async function outletMenuItem(db, menuItemId, outletId) {
  const { item, outletIds } = await sellingOutletIds(db, menuItemId);
  const outlet = outletId ?? outletIds[0];
  const setting = outlet ? await db('pos_outlet_menu_items').where({ outlet_id: outlet, menu_item_id: menuItemId }).first() : null;
  const full = await db('pos_menu_items').where({ id: menuItemId }).first();
  return {
    ...full,
    tenant_id: item.tenant_id,
    is_available: setting ? Number(setting.is_available) : 1,
    stock_auto_unavailable: setting ? Number(setting.stock_auto_unavailable) : 0,
  };
}

/** An outlet's level for a stock item (quantity '0.000' when it has none). */
async function stockLevel(db, stockItemId, outletId) {
  const level = await db('stock_levels').where({ stock_item_id: stockItemId, outlet_id: outletId }).first();
  return level ?? { current_quantity: '0.000' };
}

module.exports = {
  insertMenuCategories,
  insertStockCategories,
  insertMenuItem,
  insertStockItem,
  setStockQuantity,
  setOutletAvailability,
  outletMenuItem,
  stockLevel,
};
