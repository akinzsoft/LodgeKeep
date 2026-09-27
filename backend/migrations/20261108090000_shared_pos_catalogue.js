'use strict';

/**
 * The shared POS catalogue — user-requested, replacing per-outlet
 * categories and items: "creating a category should be separated from the
 * outlet ... I can add items under a category without it being in any
 * outlet. When I create an outlet I can choose any category I want in that
 * outlet, which will contain all its items." Confirmed with the user
 * (AskUserQuestion): stock items become one shared list with quantities kept
 * per outlet; an item has one price with an optional per-outlet override;
 * existing same-named categories and items are merged.
 *
 * New tables (all PROPERTY_SCOPED):
 *   - pos_outlet_categories: which menu categories each outlet carries. An
 *     outlet sells every active item in a category it carries, including
 *     items added later.
 *   - pos_outlet_menu_items: one row per (outlet, menu item) only where that
 *     outlet differs from the item's defaults — its own price, or the item
 *     switched off there (by staff, or automatically when stock runs out).
 *     Availability moves here from pos_menu_items: selling out at the bar
 *     must not switch the item off at the restaurant.
 *   - stock_levels: each outlet's on-hand quantity and reorder level for a
 *     shared stock item. The quantity is always re-derived from that
 *     outlet's stock_movements (which already carry outlet_id), the same
 *     "never a running total" rule stock_items.current_quantity follows;
 *     stock_items.current_quantity becomes the property-wide total and
 *     stock_items.reorder_level the default for an outlet with no level yet.
 *
 * Existing data, merged per property:
 *   - Menu and stock categories with the same name (case-insensitive)
 *     become one; every outlet that had an active one carries it. The two
 *     category lists are then made to hold the same names (the earlier
 *     user request that Setup and Stock categories match).
 *   - Active menu items with the same name in the same category become one
 *     item, at most one per outlet. The kept item (lowest id) keeps its
 *     price as the main price; another outlet whose old price differed gets
 *     it back as that outlet's own price. Merged-away items are ARCHIVED,
 *     never deleted or repointed: past orders (pos_order_items) keep
 *     pointing at them, so sales history is untouched.
 *   - Active stock items with the same name and unit become one item, at
 *     most one per outlet. The merged-away item's stock movements, stock
 *     take lines and recipe lines move to the kept item (the movements keep
 *     their own outlet_id, so each outlet's quantity is unchanged); the
 *     merged-away row is archived. Two same-named items at ONE outlet are
 *     never merged — they may genuinely differ.
 *
 * down() restores the per-outlet schema (each category, item and stock item
 * back to one outlet: the lowest outlet carrying or stocking it). It cannot
 * un-merge, and categories at a property with no outlet are dropped.
 */

const T = {
  outletCategories: 'pos_outlet_categories',
  outletItems: 'pos_outlet_menu_items',
  levels: 'stock_levels',
};
const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

const key = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/** Pure: split one group of same-named rows into merged sets of at most one row per outlet (rows ascending by id). */
function planOnePerOutlet(rows) {
  const sets = [];
  for (const row of rows) {
    const set = sets.find((candidate) => !candidate.some((member) => String(member.outlet_id) === String(row.outlet_id)));
    if (set) set.push(row);
    else sets.push([row]);
  }
  return sets;
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const k = keyOf(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  return [...groups.values()];
}

async function mergeCategories(knex, table, propertyRow) {
  const where = { tenant_id: propertyRow.tenant_id, property_id: propertyRow.property_id };
  const rows = await knex(table).where(where).orderBy('id');
  const carried = []; // [{name, outlet_id}]
  for (const group of groupBy(rows, (row) => key(row.name))) {
    const kept = group.find((row) => row.status === 'active') ?? group[0];
    for (const row of group) if (row.status === 'active') carried.push({ name: kept.name, outlet_id: row.outlet_id });
    const others = group.filter((row) => row.id !== kept.id).map((row) => row.id);
    if (others.length) await knex(table).whereIn('id', others).del();
  }
  return carried;
}

async function upsertOutletItem(knex, where, outletId, menuItemId, changes) {
  const existing = await knex(T.outletItems).where({ outlet_id: outletId, menu_item_id: menuItemId }).first();
  if (existing) await knex(T.outletItems).where({ id: existing.id }).update(changes);
  else await knex(T.outletItems).insert({ ...where, outlet_id: outletId, menu_item_id: menuItemId, ...changes });
}

async function migrateProperty(knex, propertyRow) {
  const where = { tenant_id: propertyRow.tenant_id, property_id: propertyRow.property_id };

  // 1. Categories: merge, then make both lists hold the same names.
  const carriedMenu = await mergeCategories(knex, 'pos_menu_categories', propertyRow);
  const carriedStock = await mergeCategories(knex, 'stock_item_categories', propertyRow);
  const menuCats = await knex('pos_menu_categories').where(where);
  const stockCats = await knex('stock_item_categories').where(where);
  const menuByName = new Map(menuCats.map((row) => [key(row.name), row]));
  const stockByName = new Map(stockCats.map((row) => [key(row.name), row]));
  for (const row of menuCats) {
    if (row.status === 'active' && !stockByName.has(key(row.name))) {
      const [id] = await knex('stock_item_categories').insert({ ...where, name: row.name, sort_order: row.sort_order, status: 'active' });
      stockByName.set(key(row.name), { id, name: row.name });
    }
  }
  for (const row of stockCats) {
    if (row.status === 'active' && !menuByName.has(key(row.name))) {
      const [id] = await knex('pos_menu_categories').insert({ ...where, name: row.name, sort_order: row.sort_order, status: 'active' });
      menuByName.set(key(row.name), { id, name: row.name, status: 'active' });
    }
  }

  // 2. Every outlet carries the categories it had (menu or stock), and the
  //    categories its active menu items are filed under.
  const activeItems = await knex('pos_menu_items').where({ ...where, status: 'active' }).orderBy('id');
  const carry = new Set();
  const carryPairs = [...carriedMenu, ...carriedStock, ...activeItems.map((item) => ({ name: item.category, outlet_id: item.outlet_id }))];
  for (const pair of carryPairs) {
    if (!pair.name) continue;
    let category = menuByName.get(key(pair.name));
    if (!category) {
      const name = String(pair.name).trim();
      const [id] = await knex('pos_menu_categories').insert({ ...where, name, sort_order: 0, status: 'active' });
      category = { id, name, status: 'active' };
      menuByName.set(key(name), category);
      if (!stockByName.has(key(name))) {
        const [stockId] = await knex('stock_item_categories').insert({ ...where, name, sort_order: 0, status: 'active' });
        stockByName.set(key(name), { id: stockId, name });
      }
    }
    const pairKey = `${pair.outlet_id}:${category.id}`;
    if (carry.has(pairKey)) continue;
    carry.add(pairKey);
    await knex(T.outletCategories).insert({ ...where, outlet_id: pair.outlet_id, category_id: category.id });
  }

  // 3. Menu items: file each under its category's canonical spelling, then
  //    merge same-named items in the same category (one per outlet).
  for (const item of activeItems) {
    const canonical = menuByName.get(key(item.category))?.name;
    if (canonical && canonical !== item.category) {
      await knex('pos_menu_items').where({ id: item.id }).update({ category: canonical });
      item.category = canonical;
    }
  }
  for (const group of groupBy(activeItems, (item) => `${key(item.category)}\u0000${key(item.name)}`)) {
    for (const set of planOnePerOutlet(group)) {
      const [kept, ...others] = set;
      const keptChanges = {};
      for (const member of set) {
        const outletChanges = {};
        if (member.id !== kept.id && String(member.price) !== String(kept.price)) outletChanges.price = member.price;
        if (!member.is_available) {
          outletChanges.is_available = false;
          outletChanges.stock_auto_unavailable = Boolean(member.stock_auto_unavailable);
        }
        if (Object.keys(outletChanges).length) await upsertOutletItem(knex, where, member.outlet_id, kept.id, outletChanges);
      }
      for (const other of others) {
        if (!kept.image_path && !keptChanges.image_path && other.image_path) keptChanges.image_path = other.image_path;
        if (kept.cost_price == null && keptChanges.cost_price == null && other.cost_price != null) keptChanges.cost_price = other.cost_price;
        const keptRecipe = await knex('pos_menu_item_components').where({ menu_item_id: kept.id }).first('id');
        if (!keptRecipe) {
          const otherRecipe = await knex('pos_menu_item_components').where({ menu_item_id: other.id });
          for (const line of otherRecipe) {
            await knex('pos_menu_item_components').insert({ ...where, menu_item_id: kept.id, stock_item_id: line.stock_item_id, quantity: line.quantity });
          }
        }
        await knex('pos_menu_items').where({ id: other.id }).update({ status: 'archived' });
      }
      if (Object.keys(keptChanges).length) await knex('pos_menu_items').where({ id: kept.id }).update(keptChanges);
    }
  }

  // 4. Stock items: stock categories take their canonical spelling, then
  //    same name + unit merge (one per outlet); every item gets a level at
  //    each outlet it was stocked at.
  const stockItems = await knex('stock_items').where(where).orderBy('id');
  for (const item of stockItems) {
    const canonical = item.category ? stockByName.get(key(item.category))?.name : null;
    if (canonical && canonical !== item.category) {
      await knex('stock_items').where({ id: item.id }).update({ category: canonical });
      item.category = canonical;
    }
  }
  const levelTargets = []; // [{stockItemId, outletId, reorderLevel}]
  const active = stockItems.filter((item) => item.status === 'active');
  for (const item of stockItems.filter((row) => row.status !== 'active')) {
    levelTargets.push({ stockItemId: item.id, outletId: item.outlet_id, reorderLevel: item.reorder_level });
  }
  for (const group of groupBy(active, (item) => `${key(item.name)}\u0000${key(item.unit)}`)) {
    for (const set of planOnePerOutlet(group)) {
      const [kept, ...others] = set;
      for (const member of set) levelTargets.push({ stockItemId: kept.id, outletId: member.outlet_id, reorderLevel: member.reorder_level });
      for (const other of others) {
        await knex('stock_movements').where({ stock_item_id: other.id }).update({ stock_item_id: kept.id });
        await knex('stock_take_lines').where({ stock_item_id: other.id }).update({ stock_item_id: kept.id });
        const recipeLines = await knex('pos_menu_item_components').where({ stock_item_id: other.id });
        for (const line of recipeLines) {
          const clash = await knex('pos_menu_item_components').where({ menu_item_id: line.menu_item_id, stock_item_id: kept.id }).first('id');
          if (clash) await knex('pos_menu_item_components').where({ id: line.id }).del();
          else await knex('pos_menu_item_components').where({ id: line.id }).update({ stock_item_id: kept.id });
        }
        await knex('stock_items').where({ id: other.id }).update({ status: 'archived', current_quantity: '0.000' });
        if (!kept.category && other.category) {
          await knex('stock_items').where({ id: kept.id }).update({ category: other.category });
          kept.category = other.category;
        }
      }
    }
  }
  for (const target of levelTargets) {
    const movements = await knex('stock_movements').where({ stock_item_id: target.stockItemId, outlet_id: target.outletId }).select('quantity');
    const quantity = sumQuantities(movements.map((row) => row.quantity));
    const existing = await knex(T.levels).where({ stock_item_id: target.stockItemId, outlet_id: target.outletId }).first('id');
    if (existing) continue;
    await knex(T.levels).insert({ ...where, outlet_id: target.outletId, stock_item_id: target.stockItemId, current_quantity: quantity, reorder_level: target.reorderLevel });
  }
  // Movements at an outlet with no level yet (e.g. from a merged-away item) get one too.
  const movementPairs = await knex('stock_movements').where(where).distinct('stock_item_id', 'outlet_id');
  for (const pair of movementPairs) {
    const existing = await knex(T.levels).where({ stock_item_id: pair.stock_item_id, outlet_id: pair.outlet_id }).first('id');
    if (existing) continue;
    const item = await knex('stock_items').where({ id: pair.stock_item_id }).first('reorder_level');
    const movements = await knex('stock_movements').where({ stock_item_id: pair.stock_item_id, outlet_id: pair.outlet_id }).select('quantity');
    await knex(T.levels).insert({ ...where, outlet_id: pair.outlet_id, stock_item_id: pair.stock_item_id, current_quantity: sumQuantities(movements.map((row) => row.quantity)), reorder_level: item.reorder_level });
  }
  for (const item of await knex('stock_items').where({ ...where, status: 'active' })) {
    const movements = await knex('stock_movements').where({ stock_item_id: item.id }).select('quantity');
    await knex('stock_items').where({ id: item.id }).update({ current_quantity: sumQuantities(movements.map((row) => row.quantity)) });
  }
}

/** Exact 3-decimal sum of DECIMAL strings, via integer thousandths (no floats). */
function sumQuantities(values) {
  let total = 0n;
  for (const value of values) {
    const text = String(value ?? '0');
    const negative = text.startsWith('-');
    const [whole, frac = ''] = text.replace('-', '').split('.');
    const units = BigInt(whole || '0') * 1000n + BigInt((frac + '000').slice(0, 3));
    total += negative ? -units : units;
  }
  const negative = total < 0n;
  const abs = negative ? -total : total;
  return `${negative ? '-' : ''}${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`;
}

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_menu_categories_tenant_property_id_unique' });
  });

  await knex.schema.createTable(T.outletCategories, (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('category_id').unsigned().notNullable();
    table.timestamps(true, true);
    table.unique(['outlet_id', 'category_id'], { indexName: 'pos_outlet_categories_outlet_category_unique' });
    table.foreign(['tenant_id', 'property_id'], 'pos_outlet_categories_property_foreign').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_outlet_categories_outlet_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'category_id'], 'pos_outlet_categories_category_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_menu_categories').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.comment('Which shared menu categories each outlet carries; it sells every active item in them. Scope: PROPERTY_SCOPED.');
  });

  await knex.schema.createTable(T.outletItems, (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('menu_item_id').unsigned().notNullable();
    table.decimal('price', 12, 2).nullable().comment("This outlet's own price; null = the item's main price.");
    table.boolean('is_available').notNullable().defaultTo(true).comment('False = not selling at this outlet right now.');
    table.boolean('stock_auto_unavailable').notNullable().defaultTo(false).comment('Switched off automatically because a recipe stock item ran out at this outlet.');
    table.timestamps(true, true);
    table.unique(['outlet_id', 'menu_item_id'], { indexName: 'pos_outlet_menu_items_outlet_item_unique' });
    table.foreign(['tenant_id', 'property_id'], 'pos_outlet_menu_items_property_foreign').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_outlet_menu_items_outlet_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'menu_item_id'], 'pos_outlet_menu_items_item_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_menu_items').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.comment('Per-outlet price and availability of a shared menu item, only where it differs from the item defaults. Scope: PROPERTY_SCOPED.');
  });

  await knex.schema.createTable(T.levels, (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('stock_item_id').unsigned().notNullable();
    table.decimal('current_quantity', 14, 3).notNullable().defaultTo('0.000').comment("Re-derived from this outlet's stock_movements; never a running total.");
    table.decimal('reorder_level', 14, 3).notNullable().defaultTo('0.000');
    table.timestamps(true, true);
    table.unique(['outlet_id', 'stock_item_id'], { indexName: 'stock_levels_outlet_item_unique' });
    table.foreign(['tenant_id', 'property_id'], 'stock_levels_property_foreign').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'stock_levels_outlet_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'stock_item_id'], 'stock_levels_item_foreign').references(['tenant_id', 'property_id', 'id']).inTable('stock_items').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.comment('Each outlet on-hand quantity and reorder level for a shared stock item. Scope: PROPERTY_SCOPED.');
  });

  // Category names become unique per property before the merge can rely on it — dropped first, re-added after.
  //
  // Bug fix, found in production (not caught by CI — the test fixtures'
  // two categories always had a matching name on both sides, so the one
  // path this exercises never ran there): migrateProperty()'s own
  // "make both lists hold the same names" step inserts a NEW category row
  // on whichever side is missing a name match (e.g. a menu category with
  // no same-named stock category — the ordinary case for data that was
  // never kept in sync, which is every tenant that existed before that
  // sync existed). That insert never supplies outlet_id, because by then
  // outlet_id is a retired concept — the real "which outlet(s)" answer for
  // a category from here on is pos_outlet_categories, populated in the
  // very next lines of that same block. But the column itself is still
  // NOT NULL at that point in the migration (it isn't dropped until the
  // very end, since pos_menu_items/stock_items still need to report their
  // OWN outlet_id for the rest of the loop to read) — so the insert failed
  // outright with a real, live "column has no default value" error.
  // Making outlet_id nullable HERE, the same place its own uniqueness
  // and foreign key are already being retired, is the correct fix: every
  // EXISTING row's real outlet_id is completely untouched (this only
  // changes what a FUTURE insert may omit), and the column is dropped
  // outright a few dozen lines below regardless, once the whole loop is
  // done reading from it.
  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_categories_outlet_foreign');
    table.dropUnique(['outlet_id', 'name'], 'pos_menu_categories_outlet_id_name_unique');
    table.bigInteger('outlet_id').unsigned().nullable().alter();
  });
  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'outlet_id'], 'stock_item_categories_outlet_foreign');
    table.dropUnique(['outlet_id', 'name'], 'stock_item_categories_outlet_id_name_unique');
    table.bigInteger('outlet_id').unsigned().nullable().alter();
  });

  const properties = await knex('properties').select('tenant_id', 'id as property_id').orderBy('id');
  for (const propertyRow of properties) await migrateProperty(knex, propertyRow);

  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_categories_outlet_foreign');
    table.dropColumn('outlet_id');
    table.unique(['property_id', 'name'], { indexName: 'pos_menu_categories_property_id_name_unique' });
    table.comment('The shared menu categories of a property; outlets choose which to carry (pos_outlet_categories). Scope: PROPERTY_SCOPED.');
  });
  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'outlet_id'], 'stock_item_categories_outlet_foreign');
    table.dropColumn('outlet_id');
    table.unique(['property_id', 'name'], { indexName: 'stock_item_categories_property_id_name_unique' });
    table.comment('The shared stock-item categories of a property, kept matching its menu categories. Scope: PROPERTY_SCOPED.');
  });
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_items_tenant_id_property_id_outlet_id_foreign');
    table.dropIndex(['tenant_id', 'property_id', 'outlet_id', 'is_available'], 'pos_menu_items_outlet_id_is_available_index');
    table.dropIndex(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_items_tenant_id_property_id_outlet_id_index');
  });
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.dropColumn('outlet_id');
    table.dropColumn('is_available');
    table.dropColumn('stock_auto_unavailable');
    table.index(['tenant_id', 'property_id', 'status', 'category'], 'pos_menu_items_property_status_category_index');
    table.comment('The shared menu items of a property; an outlet sells those in categories it carries. Scope: PROPERTY_SCOPED.');
  });
  await knex.schema.alterTable('stock_items', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'outlet_id'], 'stock_items_tenant_id_property_id_outlet_id_foreign');
    table.dropIndex(['tenant_id', 'property_id', 'outlet_id', 'status'], 'stock_items_tenant_id_property_id_outlet_id_status_index');
  });
  await knex.schema.alterTable('stock_items', (table) => {
    table.dropColumn('outlet_id');
    table.index(['tenant_id', 'property_id', 'status'], 'stock_items_property_status_index');
    table.comment('The shared stock items of a property; per-outlet quantities are in stock_levels. current_quantity = the property-wide total; reorder_level = the default for an outlet with no level. Scope: PROPERTY_SCOPED.');
  });
};

exports.down = async function down(knex) {
  // Each row back to one outlet: the lowest outlet that carries/stocks it,
  // else the property's oldest outlet. Merges are not undone.
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.bigInteger('outlet_id').unsigned().nullable().after('property_id');
    table.boolean('is_available').notNullable().defaultTo(true);
    table.boolean('stock_auto_unavailable').notNullable().defaultTo(false);
  });
  await knex.schema.alterTable('stock_items', (table) => {
    table.bigInteger('outlet_id').unsigned().nullable().after('property_id');
  });
  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.bigInteger('outlet_id').unsigned().nullable().after('property_id');
    table.dropUnique(['property_id', 'name'], 'pos_menu_categories_property_id_name_unique');
  });
  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.bigInteger('outlet_id').unsigned().nullable().after('property_id');
    table.dropUnique(['property_id', 'name'], 'stock_item_categories_property_id_name_unique');
  });

  const firstOutlet = async (row) => (await knex('pos_outlets').where({ tenant_id: row.tenant_id, property_id: row.property_id }).orderBy('id').first('id'))?.id ?? null;

  for (const category of await knex('pos_menu_categories')) {
    const carried = await knex(T.outletCategories).where({ category_id: category.id }).orderBy('outlet_id').first('outlet_id');
    const outletId = carried?.outlet_id ?? (await firstOutlet(category));
    if (outletId == null) await knex('pos_menu_categories').where({ id: category.id }).del();
    else await knex('pos_menu_categories').where({ id: category.id }).update({ outlet_id: outletId });
  }
  for (const category of await knex('stock_item_categories')) {
    const outletId = await firstOutlet(category);
    if (outletId == null) await knex('stock_item_categories').where({ id: category.id }).del();
    else await knex('stock_item_categories').where({ id: category.id }).update({ outlet_id: outletId });
  }
  for (const item of await knex('pos_menu_items')) {
    const category = await knex('pos_menu_categories').where({ tenant_id: item.tenant_id, property_id: item.property_id, name: item.category }).first('outlet_id');
    const outletId = category?.outlet_id ?? (await firstOutlet(item));
    const setting = outletId ? await knex(T.outletItems).where({ outlet_id: outletId, menu_item_id: item.id }).first() : null;
    await knex('pos_menu_items')
      .where({ id: item.id })
      .update({ outlet_id: outletId, is_available: setting ? setting.is_available : true, stock_auto_unavailable: setting ? setting.stock_auto_unavailable : false });
  }
  for (const item of await knex('stock_items')) {
    const level = await knex(T.levels).where({ stock_item_id: item.id }).orderBy('outlet_id').first('outlet_id');
    await knex('stock_items').where({ id: item.id }).update({ outlet_id: level?.outlet_id ?? (await firstOutlet(item)) });
  }

  await knex.schema.dropTable(T.levels);
  await knex.schema.dropTable(T.outletItems);
  await knex.schema.dropTable(T.outletCategories);

  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'status', 'category'], 'pos_menu_items_property_status_category_index');
    table.bigInteger('outlet_id').unsigned().notNullable().alter();
    table.index(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_items_tenant_id_property_id_outlet_id_index');
    table.index(['tenant_id', 'property_id', 'outlet_id', 'is_available'], 'pos_menu_items_outlet_id_is_available_index');
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_items_tenant_id_property_id_outlet_id_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
  await knex.schema.alterTable('stock_items', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'status'], 'stock_items_property_status_index');
    table.bigInteger('outlet_id').unsigned().notNullable().alter();
    table.index(['tenant_id', 'property_id', 'outlet_id', 'status'], 'stock_items_tenant_id_property_id_outlet_id_status_index');
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'stock_items_tenant_id_property_id_outlet_id_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
  await knex.schema.alterTable('pos_menu_categories', (table) => {
    table.dropUnique(['tenant_id', 'property_id', 'id'], 'pos_menu_categories_tenant_property_id_unique');
    table.bigInteger('outlet_id').unsigned().notNullable().alter();
    table.unique(['outlet_id', 'name'], { indexName: 'pos_menu_categories_outlet_id_name_unique' });
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_categories_outlet_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.bigInteger('outlet_id').unsigned().notNullable().alter();
    table.unique(['outlet_id', 'name'], { indexName: 'stock_item_categories_outlet_id_name_unique' });
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'stock_item_categories_outlet_foreign').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
};

exports.planOnePerOutlet = planOnePerOutlet;
exports.sumQuantities = sumQuantities;
