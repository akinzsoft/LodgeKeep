'use strict';

/**
 * `pos_order_settlements` — PLAN.md Phase 6's QR self-ordering gap closure.
 *
 * `settled_by_user_id` becomes nullable: a guest's own card/room-charge
 * settlement (via `settleOrder`, called with `settledByUserId: null` from
 * the QR-ordering module) has no staff member to attribute it to — the
 * same "no person, no room-hardware, no problem" shape this pass applies
 * throughout (`pos_orders.opened_by_user_id`, `payments.folio_id`).
 *
 * `payment_id` links a `card`-method settlement to the real `payments` row
 * that funded it (Paystack, via the new `pos_order_id`/`settlement_target`
 * columns on `payments` — sibling migration) — the settlement itself is
 * still the SAME row every existing `cash`/`room_charge` settlement uses;
 * this column is simply null for those two methods, since neither has a
 * `payments` row behind it (cash is synchronous with no gateway row at
 * all; room_charge posts straight to a folio).
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.bigInteger('settled_by_user_id').unsigned().nullable().alter();
  });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.bigInteger('payment_id').unsigned().nullable().comment('Set only for a card-method guest settlement — the payments row that funded it. Null for cash/room_charge.');
  });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table
      .foreign(['tenant_id', 'property_id', 'payment_id'], 'pos_order_settlements_tenant_id_property_id_payment_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('payments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.index(['tenant_id', 'property_id', 'payment_id'], 'pos_order_settlements_tenant_id_property_id_payment_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'payment_id'], 'pos_order_settlements_tenant_id_property_id_payment_id_foreign');
    table.dropIndex(['tenant_id', 'property_id', 'payment_id'], 'pos_order_settlements_tenant_id_property_id_payment_id_index');
    table.dropColumn('payment_id');
  });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.bigInteger('settled_by_user_id').unsigned().notNullable().alter();
  });
};
