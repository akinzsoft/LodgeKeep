'use strict';

/**
 * `payments.subaccount_code` — a snapshot of which Paystack Subaccount (if
 * any) this SPECIFIC payment was actually split through, recorded once at
 * checkout-initiation time (`startPaystackCheckout`,
 * `src/modules/cashiering/service.js`).
 *
 * Deliberately NOT re-derived from `property_payment_subaccounts` at
 * refund time — a property's subaccount can change (a new bank account
 * replaces the old subaccount, per that table's own migration header)
 * between when a payment was charged and when it's later refunded, and a
 * refund must reverse what actually happened to THIS transaction, not
 * whatever the property's current configuration happens to be.
 *
 * No `platform_payment_integration_id` column is added alongside this —
 * `payments.currency` already exists and is immutable per row, and
 * resolving "which integration processed this payment" by currency (the
 * same resolution every charge already uses) is exactly correct for a
 * refund too, since `platform_payment_integrations.currency` is UNIQUE.
 * A second column recording the same fact currency already implies would
 * be redundant, not a new fact.
 *
 * `cash` payments and any `paystack` payment made before this migration
 * (the old, single-shared-key era) simply have `subaccount_code: null` —
 * refund logic branches on this to fall back to the exact pre-existing,
 * un-split refund behaviour, so a payment predating subaccounts is never
 * affected by this change.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table
      .string('subaccount_code', 100)
      .nullable()
      .comment('Set only for a paystack payment actually split through a property subaccount. Null for cash, and for any paystack payment made before subaccounts existed.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('payments', (table) => {
    table.dropColumn('subaccount_code');
  });
};
