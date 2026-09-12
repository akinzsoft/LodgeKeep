'use strict';

/**
 * `payments` — PLAN.md Phase 6's QR self-ordering gap closure.
 *
 * A guest's card-paid QR order needs the exact same real Paystack
 * checkout machinery (`initializeTransaction`/webhook/verify) a folio
 * payment already uses — but a guest order settles against a `pos_orders`
 * tab, not a `folios` row, and this table's `folio_id` has been NOT NULL
 * since Phase 2.5. Rather than a parallel `pos_order_payments` table
 * duplicating this entire state machine, `folio_id` becomes nullable and
 * a new `pos_order_id` + `settlement_target` pair let ONE row mean either
 * "this payment funds a folio" (settlement_target: 'folio', the existing,
 * unchanged shape — `pos_order_id` null) or "this payment funds a POS
 * order" (settlement_target: 'pos_order' — `folio_id` null).
 *
 * Application-level invariant, enforced at every write site rather than a
 * DB CHECK constraint (this codebase does not use those — see
 * `initiatePaystackPaymentIntent` vs. the new
 * `initiatePosOrderPaystackPaymentIntent` in `cashiering/service.js`):
 * exactly one of `folio_id`/`pos_order_id` is set, matching
 * `settlement_target`. Every EXISTING folio-funding payment keeps
 * `settlement_target: 'folio'` (the column default) with `pos_order_id`
 * null, unchanged in every observable way.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table.bigInteger('folio_id').unsigned().nullable().alter();
  });
  await knex.schema.alterTable('payments', (table) => {
    table.bigInteger('pos_order_id').unsigned().nullable().comment('Set only when settlement_target = pos_order — the guest-ordering tab this payment funds.');
    table.enu('settlement_target', ['folio', 'pos_order']).notNullable().defaultTo('folio').comment('Which of folio_id/pos_order_id is meaningful for this row — see migration header.');
  });
  await knex.schema.alterTable('payments', (table) => {
    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'payments_tenant_id_property_id_pos_order_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
    table.index(['tenant_id', 'property_id', 'pos_order_id'], 'payments_tenant_id_property_id_pos_order_id_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table.dropForeign(['tenant_id', 'property_id', 'pos_order_id'], 'payments_tenant_id_property_id_pos_order_id_foreign');
    table.dropIndex(['tenant_id', 'property_id', 'pos_order_id'], 'payments_tenant_id_property_id_pos_order_id_index');
  });
  await knex.schema.alterTable('payments', (table) => {
    table.dropColumn('settlement_target');
    table.dropColumn('pos_order_id');
  });
  await knex.schema.alterTable('payments', (table) => {
    table.bigInteger('folio_id').unsigned().notNullable().alter();
  });
};
