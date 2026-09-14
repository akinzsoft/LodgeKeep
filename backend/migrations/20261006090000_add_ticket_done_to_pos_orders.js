'use strict';

/**
 * `pos_orders.ticket_done_at` / `ticket_done_by_user_id` — when the kitchen
 * or bar marked a tab's ticket done on POS → Tickets.
 *
 * The ticket queue cannot be "open tabs": a tab paid at the point of order
 * (a guest QR card order, or the Register's "Send to Bar & Checkout") is
 * settled seconds after it is placed, long before anything is made. A
 * ticket instead stays on the queue until someone marks it done, whether
 * the tab is open or already paid. Adding an item to a tab clears the mark,
 * so the new item reaches the kitchen.
 *
 * Backfill: every existing order is marked done at its close time (or now),
 * so years of past sales do not flood the queue on deploy — except guest QR
 * orders still received or being prepared, which really are waiting.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_orders', (table) => {
    table.datetime('ticket_done_at').nullable().comment('Set when the ticket is marked done on POS Tickets; cleared when an item is added.');
    table.bigInteger('ticket_done_by_user_id').unsigned().nullable().comment('Who marked the ticket done. No FK: users are tenant-scoped and this is attribution only.');
  });

  await knex('pos_orders')
    .whereNull('ticket_done_at')
    .whereNotExists(
      knex('pos_guest_orders')
        .whereRaw('pos_guest_orders.pos_order_id = pos_orders.id')
        .whereIn('pos_guest_orders.status', ['received', 'preparing'])
    )
    .update({ ticket_done_at: knex.raw('COALESCE(closed_at, NOW())') });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_orders', (table) => {
    table.dropColumn('ticket_done_by_user_id');
    table.dropColumn('ticket_done_at');
  });
};
