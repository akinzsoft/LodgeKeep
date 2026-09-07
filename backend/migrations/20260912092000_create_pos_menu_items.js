'use strict';

/**
 * `pos_menu_items` — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.4's
 * "Menu management": "Items with categories, prices, and per-outlet
 * availability... Modifiers and options (double, no ice, side choice)
 * affecting price."
 *
 * Scope: PROPERTY_SCOPED, following `pos_outlets`.
 *
 * ── `modifiers` — beyond DATABASE.md's original two-column draft ────────
 *
 * DATABASE.md's `pos_menu_items` row lists `outlet_id, name, price,
 * category, is_available, cost_price, photo_url` — no modifier catalogue
 * column, and `pos_order_items.modifiers (JSON)` (also in that same
 * table) only captures what a GUEST'S order chose, not what a menu item
 * OFFERS. Something has to define the available modifier groups and their
 * price deltas for an order screen to render choices at all, so this
 * migration adds `modifiers` here: a nullable JSON array of
 * `{name, options: [{label, priceDelta}]}` groups — the same "JSON blob,
 * first real caller defines the shape, documented at the point it's
 * added" pattern `properties.theme` already established. DATABASE.md is
 * updated in this same pass to record the addition.
 *
 * `cost_price`/`photo_url` from DATABASE.md's draft are deliberately
 * dropped: nothing in POS core (outlets/terminals/menu/orders/cash-up/
 * charge-to-room) reads either — cost/margin reporting is inventory-
 * adjacent (Phase 6), and photo upload has no caller yet. Adding either
 * back later is a trivial additive migration, the same reasoning DATABASE.md's
 * own migration rule already gives for never building a column ahead of
 * its first real reader.
 *
 * Happy-hour/time-based pricing (also named in §3.4) has no column here —
 * flagged as a deferred gap in CLAUDE.md alongside inventory, not silently
 * folded into a plain `price` column that can't express it.
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
  await knex.schema.createTable('pos_menu_items', (table) => {
    table.comment('A sellable item at one outlet. Scope: PROPERTY_SCOPED. Archive, never delete — historical orders reference it.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();

    table.string('name', 150).notNullable();
    table.string('category', 60).notNullable().comment('Free string, e.g. "Cocktails", "Starters" — no separate category table for this pass.');
    table.decimal('price', 12, 2).notNullable();
    table
      .boolean('is_available')
      .notNullable()
      .defaultTo(true)
      .comment('The stock-out toggle (PRODUCT_REQUIREMENTS.md §3.4) — staff mark unavailable without an admin edit. Distinct from status below.');
    table.json('modifiers').nullable().comment('[{name, options: [{label, priceDelta}]}] — see migration header. Null/empty = no modifiers offered.');
    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_menu_items_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'pos_menu_items_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_items_tenant_id_property_id_outlet_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'outlet_id'], 'pos_menu_items_tenant_id_property_id_outlet_id_index');
    table.index(['tenant_id', 'property_id', 'outlet_id', 'is_available'], 'pos_menu_items_outlet_id_is_available_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_menu_items');
};
