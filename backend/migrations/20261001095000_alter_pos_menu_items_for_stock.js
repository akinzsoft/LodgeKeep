'use strict';

/**
 * `pos_menu_items.stock_auto_unavailable` — PLAN.md Phase 6. Distinguishes
 * "the system disabled this item because a recipe component hit zero
 * stock" from "a human disabled it manually" (`setMenuItemAvailability`,
 * PLAN.md Phase 4's own stock-out toggle) — the two must not fight each
 * other:
 *
 *   - `applyStockAvailabilityEffects` (stock/service.js) only ever flips
 *     `is_available` to `false` when it is currently `true` (never
 *     touches a manually-disabled item further), and only flips it BACK
 *     to `true` when `stock_auto_unavailable` is genuinely `true` — a
 *     manual disable (`stock_auto_unavailable: false`) is never silently
 *     reactivated by a later restock.
 *   - A human re-enabling a manually- OR auto-disabled item via
 *     `setMenuItemAvailability` clears `stock_auto_unavailable` back to
 *     `false` — an explicit staff action always wins over the automatic
 *     mechanism's own bookkeeping.
 *
 * `NOT NULL DEFAULT false` — every existing menu item's current
 * `is_available` value keeps its exact prior meaning ("a human's own
 * setting") the moment this migration runs; nothing here retroactively
 * reclassifies past state as stock-driven.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table
      .boolean('stock_auto_unavailable')
      .notNullable()
      .defaultTo(false)
      .comment('True only when a stock event (never a human) is what most recently set is_available to false — see migration header.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.dropColumn('stock_auto_unavailable');
  });
};
