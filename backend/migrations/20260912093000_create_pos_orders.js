'use strict';

/**
 * `pos_orders` — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md §3.4's "Order
 * flow": "Open a tab, add items, run multiple tabs simultaneously... Every
 * order must be attributable to a person, not 'the bar terminal'."
 *
 * Scope: PROPERTY_SCOPED, following `pos_outlets`/`pos_terminals`.
 *
 * ── SETTLEMENT LIVES ON `pos_order_settlements`, NOT HERE ────────────────
 *
 * DATABASE.md's original draft put `folio_id`/`settlement_method`/
 * `tip_amount`/`service_charge` directly on this table, assuming one
 * settlement per order. That can't express the split-bill requirement
 * this same section asks for ("split a bill by item or evenly") — a
 * single tab settled partly by card and partly charged to a room needs
 * TWO settlement records, not one. `pos_order_settlements` (this same
 * migration set, next file) is the normalized fix; this table stays
 * exactly what its own name says — one open/settled/void tab, nothing
 * about how it was paid. DATABASE.md is updated in this same pass.
 *
 * `table_label` is a free string (a physical table number, a room number
 * for room-service, or null for a walk-up bar order) — no separate table/
 * seating concept exists anywhere in this schema, and inventing one for a
 * label field would be over-building.
 *
 * `status`: `open` (tab in progress) -> `settled` (fully paid, whether by
 * one settlement or several summing to the total) or `void` (the whole
 * tab cancelled before settlement, distinct from voiding individual
 * items). No `RUNNING`/etc — this is a simpler lifecycle than Night
 * Audit's own run state machine, since a POS tab has no crash-recovery
 * story to encode (ARCHITECTURE.md's "POS tab edit" concurrency
 * requirement is handled by a row lock at mutation time, not a state
 * machine — see `pos/service.js`).
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
  await knex.schema.createTable('pos_orders', (table) => {
    table.comment('One open/settled/void tab at an outlet. Scope: PROPERTY_SCOPED. Never deleted — void, never delete, per ARCHITECTURE.md §8.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('terminal_id').unsigned().notNullable();
    table.bigInteger('opened_by_user_id').unsigned().notNullable().comment('Every order is attributable to a person, never "the bar terminal" (PRODUCT_REQUIREMENTS.md §3.4).');

    table.string('table_label', 60).nullable().comment('Table number, room number for room service, or null for a walk-up order.');
    table.enu('status', ['open', 'settled', 'void']).notNullable().defaultTo('open');

    table.datetime('opened_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('closed_at').nullable().comment('Set when status moves to settled or void.');
    table.datetime('voided_at').nullable();
    table.string('void_reason', 255).nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'pos_orders_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'pos_orders_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_orders_tenant_id_property_id_outlet_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_outlets')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'terminal_id'], 'pos_orders_tenant_id_property_id_terminal_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_terminals')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'opened_by_user_id'], 'pos_orders_tenant_id_opened_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'pos_orders_tenant_id_voided_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'outlet_id', 'status'], 'pos_orders_tenant_id_property_id_outlet_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_orders');
};
