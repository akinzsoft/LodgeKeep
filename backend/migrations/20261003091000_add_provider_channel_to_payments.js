'use strict';

/**
 * `payments.provider_channel` — how the guest actually paid inside the
 * gateway's checkout (Paystack's `channel`: card, bank, ussd, qr,
 * mobile_money, bank_transfer, ...). The Register's Card button now opens
 * Paystack with every channel the account supports, so the button pressed
 * no longer says how the money arrived; the POS sales report shows this.
 * Recorded when the payment is captured (verify or webhook); null before.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table.string('provider_channel', 30).nullable().comment("Gateway-reported payment channel at capture, e.g. 'card', 'ussd', 'bank_transfer', 'qr'.");
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table.dropColumn('provider_channel');
  });
};
