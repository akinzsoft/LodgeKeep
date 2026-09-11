'use strict';

/**
 * Closes `tenants.plan_id`'s forward reference — PLAN.md Phase 5. The
 * original `20260902213045_create_tenants_and_properties.js` left this
 * column deliberately FK-less, its own comment stating plainly: "the FK is
 * added in the same migration that creates `plans`." `plans` now exists
 * (`20260924090000_create_plans.js`), closing that reference the same way
 * the four Phase 2 forward-reference columns on `reservations`
 * (`market_segment_id`/`booking_source_id`/`cancellation_policy_id`/
 * `group_block_id`) were each closed once their own parent table arrived.
 *
 * RESTRICT, not CASCADE (ARCHITECTURE.md §1) — a plan cannot be deleted
 * while a real tenant still references it; `plans.is_active = false` is
 * the real way to retire one.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table
      .foreign('plan_id', 'tenants_plan_id_foreign')
      .references('id')
      .inTable('plans')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('tenants', (table) => {
    table.dropForeign('plan_id', 'tenants_plan_id_foreign');
  });
};
