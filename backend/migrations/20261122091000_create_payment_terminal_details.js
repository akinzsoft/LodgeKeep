'use strict';

/**
 * `payment_terminal_details` — what a folio payment taken on a physical card terminal records about that terminal:
 * the provider, the terminal's own reference, and a SNAPSHOT of the account label and last 4 digits at the time
 * (no foreign key to `property_terminal_accounts`, so editing or removing an account never rewrites a past payment).
 *
 * A side table keyed by the payment, on purpose: a cash or Paystack payment gets no row and no new column, so
 * every existing payment, folio line and report response keeps exactly the shape it has today. Only a payment whose
 * `provider` is 'terminal' has a row here (the service writes exactly one per payment; a refund of a terminal payment
 * gets its own copy). Reconciliation LEFT JOINs it for terminal lines only.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('payment_terminal_details', (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('payment_id').unsigned().notNullable();
    table.string('terminal_provider', 20).nullable().comment('moniepoint | opay | gtbank | other, from the chosen account when it has one.');
    table.string('terminal_reference', 60).nullable().comment("The terminal's own reference, as the cashier typed it. Optional; not checked for duplicates.");
    table.string('terminal_account_label', 80).nullable().comment('Snapshot: "<bank> · <label>" of the chosen account at payment time. Display only.');
    table.string('terminal_account_last4', 4).nullable().comment('Snapshot: last 4 digits of the chosen account number.');
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['payment_id'], 'payment_terminal_details_payment_idx');
    table.foreign(['tenant_id', 'property_id'], 'payment_terminal_details_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'payment_id'], 'payment_terminal_details_payment_fk').references(['tenant_id', 'property_id', 'id']).inTable('payments').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.comment('Terminal provider, reference and account snapshot of a folio payment taken on a physical card terminal. Scope: PROPERTY_SCOPED.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('payment_terminal_details');
};
