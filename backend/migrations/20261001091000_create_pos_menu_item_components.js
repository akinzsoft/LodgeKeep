'use strict';

/**
 * `pos_menu_item_components` — PLAN.md Phase 6. A menu item's recipe/BOM:
 * how much of one `stock_items` row is consumed by selling ONE unit of a
 * `pos_menu_items` row. Plain configuration, not a ledger — no void
 * columns, an ordinary row is replaced wholesale by
 * `stock/service.js`'s `upsertMenuItemComponents` (a full replace-all per
 * menu item, not a per-row patch).
 *
 * Scope: PROPERTY_SCOPED, following `pos_menu_items`/`stock_items`.
 *
 * ── MODIFIERS DO NOT AFFECT RECIPE QUANTITY — A NAMED, DELIBERATE GAP ────
 *
 * `quantity` is fixed per menu item regardless of which JSON
 * `pos_menu_items.modifiers`/`pos_order_items.modifiers` option was
 * selected on the order line — a "double" shot deducts the same recipe
 * quantity as a single. This is confirmed, deliberate scope, not an
 * omission: modelling a modifier-conditional recipe would need a real
 * schema extension (a per-option quantity override) this pass was not
 * asked to build.
 *
 * ── OUTLET MATCH IS ENFORCED IN THE SERVICE LAYER, NOT A DB CONSTRAINT ───
 *
 * A stock item can only be a component of a menu item at the SAME outlet
 * — `stock/service.js`'s `upsertMenuItemComponents` checks
 * `menu_item.outlet_id === stock_item.outlet_id` before writing, the same
 * "a WHERE-clause match in code, not a cross-column CHECK constraint"
 * shape this codebase already uses elsewhere (MySQL has no portable
 * cross-column CHECK enforcement in this schema's style).
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('pos_menu_item_components', (table) => {
    table.comment(
      'A menu item recipe/BOM line — how much of one stock item is consumed per unit sold. Scope: PROPERTY_SCOPED. Plain config, replace-all upsert, no void columns.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('menu_item_id').unsigned().notNullable();
    table.bigInteger('stock_item_id').unsigned().notNullable();

    table.decimal('quantity', 14, 3).notNullable().comment('Amount of stock_item\'s own unit consumed per ONE unit of menu_item sold — fixed regardless of modifiers, see migration header.');

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'menu_item_id', 'stock_item_id'], { indexName: 'pos_menu_item_components_menu_stock_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'pos_menu_item_components_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'menu_item_id'], 'pos_menu_item_components_menu_item_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_menu_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'stock_item_id'], 'pos_menu_item_components_stock_item_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('stock_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'menu_item_id'], 'pos_menu_item_components_by_menu_item_index');
    // Reverse lookup — the auto-stock-out mechanism (`applyStockAvailabilityEffects`)
    // starts from a stock item that just moved and needs every menu item
    // that depends on it.
    table.index(['tenant_id', 'property_id', 'stock_item_id'], 'pos_menu_item_components_by_stock_item_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_menu_item_components');
};
