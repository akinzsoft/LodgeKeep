'use strict';

/**
 * `pos_order_settlements` — a card sale taken on the hotel's OWN physical
 * terminal (Moniepoint, Opay, a bank POS, ...). User-requested: with no way
 * to record these, staff were keying them as cash, which corrupts revenue
 * by tender AND inflates the shift's expected cash (so the till looks short).
 *
 * Lodgekeep only RECORDS that the card transaction happened on hardware it
 * cannot talk to: no gateway, no `payments` row (`payment_id` stays null),
 * nothing to verify. The method and tender are both `terminal` (fits the
 * existing `tender` column), and the two new columns are the optional
 * detail a hotel needs to tick Lodgekeep against that terminal provider's
 * own settlement report:
 *
 * - `terminal_provider`: moniepoint | opay | gtbank | other. Optional —
 *   enforced in the application (the list may grow), not as an enum.
 * - `terminal_reference`: the terminal's own transaction reference. Always
 *   optional: staff will not reliably type a 12-digit reference at a busy
 *   bar, and a required field that gets faked is worse than an empty one.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.string('terminal_provider', 20).nullable().comment("Only for tender = 'terminal': moniepoint | opay | gtbank | other. Optional.");
    table.string('terminal_reference', 60).nullable().comment("Only for tender = 'terminal': the physical terminal's own transaction reference. Optional, never required.");
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropColumn('terminal_reference');
    table.dropColumn('terminal_provider');
  });
};
