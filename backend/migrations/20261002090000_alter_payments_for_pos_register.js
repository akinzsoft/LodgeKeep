'use strict';

/**
 * `payments` — staff POS Register card/NQR checkout through Paystack.
 *
 * `settlement_target` gains `'pos_register'`: a payment that funds ONE check
 * (split group) of a staff Register tab. Unlike `'pos_order'` (QR guest
 * orders, which `applyGatewayResult` settles automatically on capture), a
 * `'pos_register'` payment is only ever CAPTURED by the gateway result — the
 * cashier's own `settleOrder` call later links it to a settlement, after
 * checking it covers that check's exact total (subtotal + tax + service).
 * Auto-settling here would skip the service charge and break split bills.
 *
 * - `split_group`: which check this payment funds (null = the default check),
 *   matching `pos_order_items.split_group`.
 * - `tender`: 'card' | 'nqr' — which Register button started it, so card and
 *   QR payments can be told apart (both settle as `method: 'card'`).
 * - `provider_access_code`: Paystack's `access_code` for this transaction, so
 *   a retry after the popup closed unpaid reopens the SAME transaction
 *   instead of starting a second charge.
 *
 * Rollback caveat (same as earlier enum-narrowing migrations): narrowing the
 * enum fails once real `'pos_register'` rows exist.
 */

exports.up = async function up(knex) {
  await knex.raw(
    "ALTER TABLE payments MODIFY COLUMN settlement_target ENUM('folio','pos_order','pos_register') NOT NULL DEFAULT 'folio'"
  );
  await knex.schema.alterTable('payments', (table) => {
    table.integer('split_group').unsigned().nullable().comment("Set only when settlement_target = pos_register — the Register check this payment funds (null = the default check).");
    table.string('tender', 10).nullable().comment("Set only when settlement_target = pos_register — 'card' or 'nqr'.");
    table.string('provider_access_code', 255).nullable().comment("Paystack access_code for this transaction, so an unpaid popup can be reopened without starting a second charge.");
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table.dropColumn('provider_access_code');
    table.dropColumn('tender');
    table.dropColumn('split_group');
  });
  await knex.raw("ALTER TABLE payments MODIFY COLUMN settlement_target ENUM('folio','pos_order') NOT NULL DEFAULT 'folio'");
};
