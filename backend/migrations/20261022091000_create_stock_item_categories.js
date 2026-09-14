'use strict';

/**
 * `stock_item_categories` — gap closure, mirroring `pos_menu_categories`
 * exactly (same migration pattern, same reasoning): the property's
 * registered list of stock-item categories (Wine, Spirits, Produce,
 * Cleaning supplies…), shared by every outlet. Stock items pick one from a
 * dropdown instead of typing it, so the Stock Items list and the new
 * cost-of-sales margin report never split one category into
 * "Wine"/"wine"/"Wines".
 *
 * `stock_items.category` (added by the very next migration) stays the
 * category NAME itself — a plain string, not a foreign key — the identical
 * "every reader keeps working unchanged" reasoning `pos_menu_categories`'
 * own header already gives. The service layer keeps the two consistent: a
 * stock item may only use an active registered name, and renaming a
 * category renames it on every stock item using it, in the same
 * transaction.
 *
 * No backfill needed here (unlike `pos_menu_categories`'s own migration):
 * `stock_items.category` does not exist yet before this pass, so there is
 * no pre-existing free-text data to reconcile.
 *
 * Scope: PROPERTY_SCOPED. Archive, never delete.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('stock_item_categories', (table) => {
    table.comment('Registered stock-item categories, shared by every outlet at the property. Scope: PROPERTY_SCOPED. Archive, never delete.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    // 60, not more: the name is copied into stock_items.category, a VARCHAR(60).
    table.string('name', 60).notNullable().comment('Matches stock_items.category exactly (same 60-char width); unique per property.');
    table.integer('sort_order').notNullable().defaultTo(0).comment('Display order, lowest first.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.unique(['property_id', 'name'], { indexName: 'stock_item_categories_property_id_name_unique' });
    table
      .foreign(['tenant_id', 'property_id'], 'stock_item_categories_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.index(['tenant_id', 'property_id', 'status'], 'stock_item_categories_tenant_property_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('stock_item_categories');
};
