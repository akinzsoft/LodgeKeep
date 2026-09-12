'use strict';

/**
 * `pos_guest_orders` — PLAN.md Phase 6's QR self-ordering gap closure.
 * One row per `pos_orders` tab that was opened by a GUEST scanning a QR
 * token, 1:1 with the underlying tab — `pos_orders` itself stays exactly
 * what it already is (a tab, however it was opened, per its own migration
 * header); this table is the guest-facing metadata layer on top: which
 * token opened it, contact details (optional — a guest may order without
 * ever giving one), how they intend to pay, and the guest-visible status
 * PRODUCT_REQUIREMENTS.md §3.4's QR-ordering section names ("received,
 * preparing, on its way").
 *
 * Scope: PROPERTY_SCOPED, following `pos_orders`.
 *
 * `status` is a SEPARATE lifecycle from `pos_orders.status` — a guest
 * order can be `awaiting_payment`/`received`/`preparing`/`on_the_way`
 * while the underlying tab is still `open`, and becomes `rejected`/
 * `auto_rejected` while the tab itself may already be `settled` (a voided
 * settlement sitting inside an otherwise-settled order — see
 * `qr-ordering/service.js`'s own header for the full reasoning) or still
 * `open` (a card order that never got past `awaiting_payment` never
 * settles the underlying order at all).
 *
 * `payment_status`: `unpaid` (initial) -> `paid` (card capture confirmed)
 * or `charged_to_room` (OTP-verified settlement) -> `refunded` (a
 * rejection/auto-rejection reverses the payment). No `PARTIALLY_REFUNDED`
 * equivalent — a guest order is always settled/reversed in full, never
 * partially, unlike the general `payments` state machine.
 *
 * `accepted_at` records the moment staff move a `received` order to
 * `preparing` — the boundary the lazy auto-reject check compares against
 * the outlet's own `guest_order_accept_timeout_minutes`
 * (`pos_outlets`, sibling migration) to decide whether an order that
 * never got accepted in time should read as auto-rejected on next read.
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
  await knex.schema.createTable('pos_guest_orders', (table) => {
    table.comment(
      'Guest-facing metadata for a pos_orders tab opened via a QR token — 1:1 with pos_orders. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('pos_order_id').unsigned().notNullable();
    table.bigInteger('token_id').unsigned().notNullable();

    table.string('guest_contact', 255).nullable().comment('An email or phone the guest optionally supplied — not an account, no login exists on this surface.');
    table.string('guest_name', 120).nullable();

    table.enu('payment_method', ['card', 'room_charge']).notNullable();
    table.enu('payment_status', ['unpaid', 'paid', 'charged_to_room', 'refunded']).notNullable().defaultTo('unpaid');

    table
      .enu('status', ['awaiting_payment', 'received', 'preparing', 'on_the_way', 'rejected', 'auto_rejected'])
      .notNullable()
      .defaultTo('awaiting_payment');

    table.datetime('accepted_at').nullable().comment('Set when staff move this order from received to preparing — the lazy auto-reject checks own timeout boundary.');
    table.string('rejected_reason', 255).nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'pos_order_id'], { indexName: 'pos_guest_orders_tenant_id_property_id_order_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'pos_guest_orders_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'pos_order_id'], 'pos_guest_orders_tenant_id_property_id_order_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_orders')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'token_id'], 'pos_guest_orders_tenant_id_property_id_token_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('pos_order_tokens')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'token_id', 'status'], 'pos_guest_orders_tenant_id_property_id_token_id_status_index');
    table.index(['tenant_id', 'property_id', 'status'], 'pos_guest_orders_tenant_id_property_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pos_guest_orders');
};
