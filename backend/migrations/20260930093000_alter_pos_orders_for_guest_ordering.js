'use strict';

/**
 * `pos_orders` — PLAN.md Phase 6's QR self-ordering gap closure.
 *
 * `opened_by_user_id`/`terminal_id` become nullable: a guest-opened tab
 * (`source: 'guest'`) has no staff member and no physical terminal behind
 * it at all — `openOrder` (`pos/service.js`) is widened to accept
 * `terminalId = null, openedByUserId = null, source = 'staff'`, only
 * validating/looking up a terminal when one is actually supplied. Every
 * EXISTING staff-opened order is unaffected — both columns stay required
 * in practice for `source: 'staff'`, just no longer required by the
 * schema itself, which was the smallest change that lets one table serve
 * both origins without a parallel `guest_pos_orders` table duplicating
 * every other column this one already has.
 *
 * `source` distinguishes the two origins for reporting/filtering
 * (`GET /pos/guest-orders` vs. the existing staff-facing order list) —
 * `enu`, not inferred from whether `opened_by_user_id` is null, so the
 * intent is explicit data rather than derived from an absence.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_orders', (table) => {
    table.bigInteger('opened_by_user_id').unsigned().nullable().alter();
    table.bigInteger('terminal_id').unsigned().nullable().alter();
  });
  await knex.schema.alterTable('pos_orders', (table) => {
    table.enu('source', ['staff', 'guest']).notNullable().defaultTo('staff').comment('Which surface opened this tab — staff (register/terminal) or guest (QR self-ordering).');
  });
  await knex.schema.alterTable('pos_orders', (table) => {
    table.index(['tenant_id', 'property_id', 'source'], 'pos_orders_tenant_id_property_id_source_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_orders', (table) => {
    table.dropIndex(['tenant_id', 'property_id', 'source'], 'pos_orders_tenant_id_property_id_source_index');
    table.dropColumn('source');
  });
  await knex.schema.alterTable('pos_orders', (table) => {
    table.bigInteger('terminal_id').unsigned().notNullable().alter();
    table.bigInteger('opened_by_user_id').unsigned().notNullable().alter();
  });
};
