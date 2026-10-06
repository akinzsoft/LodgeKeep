'use strict';

/**
 * `property_terminal_accounts` — the bank accounts the HOTEL's own physical card terminals pay into, for room and
 * folio payments taken at the front desk. The hotel-side twin of `pos_outlet_terminal_accounts`, which is
 * per OUTLET: the front desk has no outlet, so a hotel-wide terminal needs a property-level list.
 *
 * RECORDING ONLY. A terminal payment never touches Paystack: the money moves through the terminal's own bank
 * binding, outside Lodgekeep. This is a label the hotel keeps so a payment can say which account it went to, and
 * reconciliation can be matched against that account's own settlement report. It changes no money flow.
 *
 * The account number is stored in plaintext on purpose (staff need it visible, as for the outlet accounts); lists
 * to operators show the last 4 only. A payment snapshots the label and last 4 (`payment_terminal_details`) with NO
 * foreign key back to this table, so editing or removing an account never rewrites history.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('property_terminal_accounts', (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.string('provider', 20).nullable().comment('moniepoint | opay | gtbank | other; optional. Enforced in the application.');
    table.string('bank_name', 80).nullable().comment('Optional free-text bank, e.g. "Zenith Bank". Not validated against any list.');
    table.string('account_label', 80).nullable().comment('Optional friendly name, e.g. "Front desk POS".');
    table.string('account_number', 40).notNullable();
    table.timestamps(true, true);
    table.unique(['tenant_id', 'property_id', 'account_number'], { indexName: 'property_terminal_accounts_number_unique' });
    table.foreign(['tenant_id', 'property_id'], 'property_terminal_accounts_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.comment('Bank accounts the hotel front desk card terminals pay into (labels only, no money routing). Scope: PROPERTY_SCOPED.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('property_terminal_accounts');
};
