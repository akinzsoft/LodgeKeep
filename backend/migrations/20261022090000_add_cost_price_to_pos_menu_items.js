'use strict';

/**
 * `pos_menu_items.cost_price` — gap closure. The original menu-items
 * migration deliberately dropped DATABASE.md's draft `cost_price` column
 * ("nothing in POS core reads it; cost/margin reporting is
 * inventory-adjacent, Phase 6"). Phase 6 shipped a real, more accurate
 * mechanism instead — a menu item's true cost is derived live from its
 * recipe/BOM (`pos_menu_item_components.quantity` × the linked
 * `stock_items.purchase_cost`), which tracks the real, current wholesale
 * cost automatically as deliveries come in.
 *
 * This column is confirmed, user-requested scope beyond that: a FALLBACK
 * cost source for a menu item that has no recipe configured at all (a
 * bottle of wine sold as a whole unit, or any item nobody has bothered to
 * build a stock-linked BOM for) — so it can still get a real margin
 * figure without requiring full inventory tracking to be set up first.
 *
 * Nullable, no default — `null` means "no fallback configured," not
 * zero cost; the margin report (`stock/reporting.js`'s
 * `computeCostOfSalesMargin`) reports that item's cost as genuinely
 * unknown rather than silently treating a missing cost as free.
 *
 * `computeCostOfSalesMargin`'s own confirmed priority: a menu item with a
 * real recipe ALWAYS uses the recipe-derived cost, even if cost_price is
 * also set — the recipe tracks the true, current wholesale cost; this
 * column only ever applies when no recipe exists at all.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table
      .decimal('cost_price', 12, 2)
      .nullable()
      .comment('Fallback wholesale cost, used for margin reporting only when this item has no recipe/BOM configured. Recipe-derived cost always wins when one exists.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.dropColumn('cost_price');
  });
};
