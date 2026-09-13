'use strict';

/**
 * `pos_menu_categories` — the property's registered list of menu categories
 * (Starters, Mains, Drinks…), shared by every outlet. Menu items pick one
 * from a dropdown instead of typing it, so the Register's category rail and
 * the guest QR menu never split one category into "Drinks"/"drinks"/"Drink".
 *
 * `pos_menu_items.category` stays the category NAME it has always been —
 * every reader (Register rail, guest menu, reports) keeps working unchanged.
 * The service keeps the two consistent: an item may only use an active
 * registered name, and renaming a category renames it on its items in the
 * same transaction.
 *
 * Existing free-text categories are backfilled as registered categories
 * (trimmed, one per distinct name per property), so no current menu item is
 * left pointing at an unregistered name.
 *
 * Scope: PROPERTY_SCOPED. Archive, never delete.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('pos_menu_categories', (table) => {
    table.comment('Registered POS menu categories, shared by every outlet at the property. Scope: PROPERTY_SCOPED. Archive, never delete.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    // 60, not more: the name is copied into pos_menu_items.category, a VARCHAR(60).
    table.string('name', 60).notNullable().comment('Matches pos_menu_items.category exactly (same 60-char width); unique per property.');
    table.integer('sort_order').notNullable().defaultTo(0).comment('Display order, lowest first.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.unique(['property_id', 'name'], { indexName: 'pos_menu_categories_property_id_name_unique' });
    table
      .foreign(['tenant_id', 'property_id'], 'pos_menu_categories_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.index(['tenant_id', 'property_id', 'status'], 'pos_menu_categories_tenant_property_status_index');
  });

  const existing = await knex('pos_menu_items')
    .select('tenant_id', 'property_id', knex.raw('TRIM(category) AS name'))
    .whereRaw("TRIM(category) <> ''")
    .groupByRaw('tenant_id, property_id, TRIM(category)');
  const seen = new Set();
  const rows = [];
  for (const row of existing) {
    // MySQL's default collation compares case-insensitively, so "Drinks" and
    // "drinks" are one category; keep the first spelling seen.
    const key = `${row.property_id}:${row.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ tenant_id: row.tenant_id, property_id: row.property_id, name: row.name });
  }
  if (rows.length > 0) await knex('pos_menu_categories').insert(rows);
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('pos_menu_categories');
};
