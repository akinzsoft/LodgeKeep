'use strict';

/**
 * `stock_items.category` — gap closure, the name a stock item's registered
 * `stock_item_categories` row is copied into, matching
 * `pos_menu_items.category`'s own shape exactly. Nullable, unlike
 * `pos_menu_items.category` (`NOT NULL`) — every existing stock item was
 * created with no category at all, and retrofitting a mandatory value onto
 * them would need an invented "Uncategorized" default nobody chose;
 * grouping by category in the Stock Items list or the margin report simply
 * treats a `null` category as its own, honestly-labelled group instead.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('stock_items', (table) => {
    table.string('category', 60).nullable().comment('The name of a registered stock_item_categories row, or null (optional, unlike pos_menu_items.category).');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('stock_items', (table) => {
    table.dropColumn('category');
  });
};
