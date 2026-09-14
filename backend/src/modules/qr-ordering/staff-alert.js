'use strict';

/**
 * Staff alert for a guest QR order reaching the bar/kitchen — gap closure
 * (staff notifications, user-reported: "if guest qr ordered it should prompt
 * a standard UI card with the message for who ordered").
 *
 * Fired when the order becomes `received`, NOT when the guest first taps
 * "Place order". Every guest order starts `awaiting_payment` and only becomes
 * `received` once the card capture is confirmed or the room charge is
 * OTP-verified (`pos_guest_orders` migration header) — alerting at creation
 * would pop up a card for orders a guest then abandons at checkout, which
 * staff can't act on. Paid-and-received is the moment there is real work to
 * do, so this one event (with its on-screen card) covers both "placed" and
 * "paid".
 *
 * Lives in its own small file, depending only on shared code and the
 * notifications module, because both `qr-ordering/service.js` (room charge)
 * and `cashiering/service.js` (card capture) call it, and cashiering must not
 * import the qr-ordering service (which already imports cashiering).
 */

const { notifyStaff } = require('../notifications/staff-notifications');

/**
 * @param {object} args
 * @param {object} args.db  a property-bound scoped accessor or transaction
 * @param {string|number} args.guestOrderId
 * @param {string} args.total  exact DECIMAL string actually charged
 * @param {string} args.currency
 */
async function notifyGuestOrderReceived({ db, guestOrderId, total, currency }) {
  const guestOrder = await db.table('pos_guest_orders').where({ id: guestOrderId }).first();
  if (!guestOrder) return;
  const order = await db.table('pos_orders').where({ id: guestOrder.pos_order_id }).first();
  const outlet = order ? await db.table('pos_outlets').where({ id: order.outlet_id }).first() : null;
  const items = await db
    .table('pos_order_items')
    .where({ 'pos_order_items.pos_order_id': guestOrder.pos_order_id })
    .whereNull('pos_order_items.voided_at')
    .joinScoped('pos_menu_items', (join) => join.on('pos_order_items.menu_item_id', '=', 'pos_menu_items.id'))
    .select('pos_menu_items.name as name', 'pos_order_items.quantity as quantity')
    .orderBy('pos_order_items.id');

  await notifyStaff({
    trx: db,
    eventType: 'qr_ordering.guest_order_placed',
    popup: true,
    payload: {
      guestOrderId: guestOrder.id,
      orderId: guestOrder.pos_order_id,
      outletName: outlet?.name ?? null,
      tableLabel: order?.table_label ?? null,
      guestName: guestOrder.guest_name ?? null,
      paymentMethod: guestOrder.payment_method,
      items: items.map((row) => ({ name: row.name, quantity: Number(row.quantity) })),
      total,
      currency,
    },
  });
}

module.exports = { notifyGuestOrderReceived };
