'use strict';

/**
 * `stock_item_categories.outlet_id` — gap closure, user-reported: choosing
 * an outlet in Stock items' "Filter by outlet" still showed every outlet's
 * stock categories. Stock categories now belong to ONE outlet, exactly like
 * menu categories since 20261104090000 (read that migration's header — this
 * one follows it step for step). Two outlets may each register a stock
 * category with the same name: the unique key moves from (property_id,
 * name) to (outlet_id, name). outlet_id reaches pos_outlets through the
 * (tenant_id, property_id, outlet_id) composite FK. Scope stays
 * PROPERTY_SCOPED.
 *
 * Existing rows, by the same shared rule (`planCategoryOutletFanOut`): a
 * category some stock items use goes to each outlet those items belong to
 * (one copy per outlet, the original row kept for the lowest outlet id,
 * matching case-insensitively); an unused one goes to the property's oldest
 * outlet; one at a property with no outlet is deleted (down() cannot bring
 * it back — the dev database has none).
 */

const { planCategoryOutletFanOut } = require('./20261104090000_add_outlet_id_to_pos_menu_categories');

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
const FK_NAME = 'stock_item_categories_outlet_foreign';
const OLD_UNIQUE = 'stock_item_categories_property_id_name_unique';
const NEW_UNIQUE = 'stock_item_categories_outlet_id_name_unique';

exports.up = async function up(knex) {
  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.bigInteger('outlet_id').unsigned().nullable().after('property_id').comment('The one outlet this stock category belongs to.');
  });
  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.dropUnique(['property_id', 'name'], OLD_UNIQUE);
  });

  const categories = await knex('stock_item_categories').orderBy('id');
  for (const category of categories) {
    const itemRows = await knex('stock_items')
      .where({ tenant_id: category.tenant_id, property_id: category.property_id })
      .whereRaw('LOWER(TRIM(category)) = LOWER(TRIM(?))', [category.name])
      .distinct('outlet_id')
      .orderBy('outlet_id');
    const outletRows = await knex('pos_outlets').where({ tenant_id: category.tenant_id, property_id: category.property_id }).orderBy('id').select('id');
    const plan = planCategoryOutletFanOut(
      itemRows.map((row) => row.outlet_id),
      outletRows.map((row) => row.id)
    );
    if (plan.delete) {
      await knex('stock_item_categories').where({ id: category.id }).del();
      continue;
    }
    await knex('stock_item_categories').where({ id: category.id }).update({ outlet_id: plan.updateOutletId });
    for (const outletId of plan.insertOutletIds) {
      await knex('stock_item_categories').insert({
        tenant_id: category.tenant_id,
        property_id: category.property_id,
        outlet_id: outletId,
        name: category.name,
        sort_order: category.sort_order,
        status: category.status,
      });
    }
  }

  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.bigInteger('outlet_id').unsigned().notNullable().comment('The one outlet this stock category belongs to.').alter();
    table.unique(['outlet_id', 'name'], { indexName: NEW_UNIQUE });
    table.comment('Registered stock-item categories, each belonging to one outlet. Scope: PROPERTY_SCOPED. Archive, never delete.');
    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], FK_NAME)
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  // Collapse the per-outlet copies back to one row per (property, name), keeping the lowest id.
  const rows = await knex('stock_item_categories').orderBy('id').select('id', 'property_id', 'name');
  const seen = new Set();
  const duplicateIds = [];
  for (const row of rows) {
    const key = `${row.property_id}::${String(row.name).trim().toLowerCase()}`;
    if (seen.has(key)) duplicateIds.push(row.id);
    else seen.add(key);
  }
  if (duplicateIds.length > 0) await knex('stock_item_categories').whereIn('id', duplicateIds).del();

  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'outlet_id'], FK_NAME);
    table.dropUnique(['outlet_id', 'name'], NEW_UNIQUE);
    table.dropIndex(['tenant_id', 'property_id', 'outlet_id'], FK_NAME); // MySQL's own supporting index for the FK
  });
  await knex.schema.alterTable('stock_item_categories', (table) => {
    table.dropColumn('outlet_id');
    table.unique(['property_id', 'name'], { indexName: OLD_UNIQUE });
    table.comment('Registered stock-item categories, shared by every outlet at the property. Scope: PROPERTY_SCOPED. Archive, never delete.');
  });
};
