'use strict';

/**
 * `expense_categories` — the property's registered list of operating-expense
 * categories (Utilities, Salaries, Supplies, Maintenance…), mirroring
 * `stock_item_categories`/`pos_menu_categories` exactly (same migration
 * pattern, same reasoning).
 *
 * Unlike those two tables, `expenses.expense_category_id` (a later
 * migration) is a real, live foreign key — not a copied name string. This
 * is a brand-new table with zero pre-existing free-text data to reconcile,
 * so there is no "every reader keeps working unchanged" constraint pulling
 * toward a copied string; a live FK is simpler here: renaming a category
 * needs no cascade update to `expenses` rows at all (the join always
 * resolves the current name), and "category in use" for archiving is a
 * plain `COUNT(*) WHERE expense_category_id = id`, not a name-string match.
 *
 * Scope: PROPERTY_SCOPED. Archive, never delete.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('expense_categories', (table) => {
    table.comment('Registered operating-expense categories, shared by every expense and recurring schedule at the property. Scope: PROPERTY_SCOPED. Archive, never delete.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.string('name', 60).notNullable();
    table.integer('sort_order').notNullable().defaultTo(0).comment('Display order, lowest first.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.unique(['property_id', 'name'], { indexName: 'expense_categories_property_id_name_unique' });
    // Parent key for expenses.expense_category_id / recurring_expense_schedules.expense_category_id
    // (both PROPERTY_SCOPED tables referencing another PROPERTY_SCOPED table
    // need the 3-column composite key, matching pos_menu_item_components.stock_item_id -> stock_items).
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'expense_categories_tenant_id_property_id_id_unique' });
    table
      .foreign(['tenant_id', 'property_id'], 'expense_categories_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.index(['tenant_id', 'property_id', 'status'], 'expense_categories_tenant_property_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('expense_categories');
};
