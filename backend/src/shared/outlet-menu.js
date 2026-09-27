'use strict';

/**
 * What an outlet sells, from the shared POS catalogue (migration
 * 20261108090000_shared_pos_catalogue, user-requested): categories and
 * menu items belong to the property; an outlet carries some categories
 * (`pos_outlet_categories`) and sells every active item filed under them;
 * `pos_outlet_menu_items` holds only what differs at one outlet — its own
 * price, or the item switched off there.
 *
 * Shared by the POS Register (`pos/service.js`), guest QR ordering
 * (`qr-ordering/service.js`) and stock (`stock/service.js`, which must not
 * require `pos/service.js`), so "what does this outlet sell, at what price"
 * has one answer everywhere. Every function takes an already-scoped
 * accessor (a request's or a transaction's).
 */

/** Names of the categories an outlet carries (any status — an archived category keeps its items selling until they are moved). */
async function carriedCategoryNames(db, outletId) {
  const rows = await db
    .table('pos_outlet_categories')
    .joinScoped('pos_menu_categories', (join) => join.on('pos_menu_categories.id', '=', 'pos_outlet_categories.category_id'))
    .where({ 'pos_outlet_categories.outlet_id': outletId })
    .select('pos_menu_categories.name');
  return rows.map((row) => row.name);
}

/** Ids of the categories an outlet carries. */
async function carriedCategoryIds(db, outletId) {
  const rows = await db.table('pos_outlet_categories').where({ outlet_id: outletId }).select('category_id');
  return rows.map((row) => String(row.category_id));
}

const nameKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/** The item as sold at this outlet: `price` is the outlet's own price or the main one; `base_price`/`outlet_price` say which. */
function applyOutletSetting(item, setting) {
  const outletPrice = setting?.price ?? null;
  return {
    ...item,
    base_price: item.price,
    outlet_price: outletPrice,
    price: outletPrice ?? item.price,
    is_available: setting ? Boolean(setting.is_available) : true,
    stock_auto_unavailable: setting ? Boolean(setting.stock_auto_unavailable) : false,
  };
}

/** Every active menu item an outlet sells, as sold there. */
async function menuItemsForOutlet(db, outletId) {
  const names = await carriedCategoryNames(db, outletId);
  if (names.length === 0) return [];
  const items = await db.table('pos_menu_items').where({ status: 'active' }).whereIn('category', names).orderBy('category').orderBy('name');
  if (items.length === 0) return [];
  const settings = await db
    .table('pos_outlet_menu_items')
    .where({ outlet_id: outletId })
    .whereIn(
      'menu_item_id',
      items.map((item) => item.id)
    );
  const byItem = new Map(settings.map((row) => [String(row.menu_item_id), row]));
  return items.map((item) => applyOutletSetting(item, byItem.get(String(item.id))));
}

/**
 * One item as sold at this outlet, or null when the outlet does not sell it
 * (unknown, archived, or filed under a category the outlet does not carry).
 */
async function menuItemAtOutlet(db, outletId, menuItemId) {
  const item = await db.table('pos_menu_items').where({ id: menuItemId, status: 'active' }).first();
  if (!item) return null;
  const names = await carriedCategoryNames(db, outletId);
  if (!names.some((name) => nameKey(name) === nameKey(item.category))) return null;
  const setting = await db.table('pos_outlet_menu_items').where({ outlet_id: outletId, menu_item_id: menuItemId }).first();
  return applyOutletSetting(item, setting);
}

/** Writes this outlet's differences for one item, creating the row on first use. */
async function upsertOutletMenuSetting(db, outletId, menuItemId, changes) {
  const existing = await db.table('pos_outlet_menu_items').where({ outlet_id: outletId, menu_item_id: menuItemId }).forUpdate().first();
  if (existing) {
    await db.table('pos_outlet_menu_items').where({ id: existing.id }).update(changes);
    return;
  }
  try {
    await db.table('pos_outlet_menu_items').insert({ outlet_id: outletId, menu_item_id: menuItemId, ...changes });
  } catch (error) {
    // A concurrent first write created the row — apply ours on top of it.
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
    await db.table('pos_outlet_menu_items').where({ outlet_id: outletId, menu_item_id: menuItemId }).update(changes);
  }
}

/** Makes an outlet carry a category (no-op when it already does). */
async function carryCategory(db, outletId, categoryId) {
  const existing = await db.table('pos_outlet_categories').where({ outlet_id: outletId, category_id: categoryId }).first('id');
  if (existing) return;
  try {
    await db.table('pos_outlet_categories').insert({ outlet_id: outletId, category_id: categoryId });
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
  }
}

/** Ids of the outlets that sell a menu item (carry its category). */
async function outletIdsSellingCategory(db, categoryName) {
  const category = await db.table('pos_menu_categories').where({ name: String(categoryName ?? '').trim() }).first('id');
  if (!category) return [];
  const rows = await db.table('pos_outlet_categories').where({ category_id: category.id }).select('outlet_id');
  return rows.map((row) => String(row.outlet_id));
}

module.exports = {
  carriedCategoryNames,
  carriedCategoryIds,
  applyOutletSetting,
  menuItemsForOutlet,
  menuItemAtOutlet,
  upsertOutletMenuSetting,
  carryCategory,
  outletIdsSellingCategory,
};
