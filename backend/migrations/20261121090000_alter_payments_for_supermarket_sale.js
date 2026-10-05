'use strict';

/**
 * `payments.settlement_target` gains `'supermarket_sale'`: a Paystack payment
 * (card today; bank transfer later) that funds ONE pending supermarket quick
 * sale (`supermarket_sale_intents`). Unlike `'pos_register'`, the capture
 * itself completes the sale on the server (settlement, stock, gapless receipt
 * number) — exactly once, whether the webhook or the till's check gets there
 * first — so a customer who paid is never left without a recorded sale.
 *
 * The value is APPENDED to the enum, so MySQL 8 changes the column's metadata
 * only: `ALGORITHM=INSTANT` makes it fail loudly rather than silently rebuild
 * the payments table, and no existing row is touched.
 *
 * `down` removes the value (a table rebuild, so no INSTANT there) and refuses (rather than deleting money records) once any payment uses
 * the new value.
 */

exports.up = async function up(knex) {
  await knex.raw(
    "ALTER TABLE payments MODIFY COLUMN settlement_target ENUM('folio','pos_order','pos_register','supermarket_sale') NOT NULL DEFAULT 'folio', ALGORITHM=INSTANT"
  );
};

exports.down = async function down(knex) {
  const used = await knex('payments').where({ settlement_target: 'supermarket_sale' }).first('id');
  if (used) throw new Error('Cannot roll back: supermarket Paystack payments exist (payments.settlement_target = supermarket_sale).');
  await knex.raw("ALTER TABLE payments MODIFY COLUMN settlement_target ENUM('folio','pos_order','pos_register') NOT NULL DEFAULT 'folio'");
};
