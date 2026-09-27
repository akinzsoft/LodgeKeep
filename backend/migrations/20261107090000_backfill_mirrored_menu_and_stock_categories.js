'use strict';

/**
 * User-requested: "when any of the outlets is clicked in Stock items it
 * should show all the categories created in Setup, and vice versa." From
 * now on, creating (or renaming) a menu category or a stock category does
 * the same on the other side at the same outlet (`mirror` in
 * `shared/category-catalogue.js`). This backfills the categories that
 * already exist: every ACTIVE menu category gets a stock category of the
 * same name at the same outlet, and every ACTIVE stock category a menu
 * category, unless one with that name is already there in any status (an
 * archived one stays archived — someone archived it on purpose). Names
 * compare case-insensitively, as the columns' collation and unique keys do.
 *
 * down() does nothing: a backfilled row is indistinguishable from one a
 * person created, and deleting categories could strand items that were
 * assigned to them since.
 */

async function copyMissing(knex, fromTable, toTable) {
  const rows = await knex(fromTable).where({ status: 'active' }).select('tenant_id', 'property_id', 'outlet_id', 'name', 'sort_order');
  for (const row of rows) {
    const existing = await knex(toTable).where({ tenant_id: row.tenant_id, outlet_id: row.outlet_id, name: row.name }).first('id');
    if (existing) continue;
    await knex(toTable).insert({
      tenant_id: row.tenant_id,
      property_id: row.property_id,
      outlet_id: row.outlet_id,
      name: row.name,
      sort_order: row.sort_order,
      status: 'active',
    });
  }
}

exports.up = async function up(knex) {
  await copyMissing(knex, 'pos_menu_categories', 'stock_item_categories');
  await copyMissing(knex, 'stock_item_categories', 'pos_menu_categories');
};

exports.down = async function down() {};
