'use strict';

/**
 * `pos_outlet_terminal_accounts` — which bank account each outlet's physical
 * card terminal pays into, per provider (Moniepoint, Opay, GTBank).
 *
 * RECORDING ONLY. A terminal sale never touches Paystack: the money moves via
 * the terminal's own bank binding, outside Lodgekeep, so Lodgekeep cannot
 * route it. This table is a label the hotel keeps so a sale can say which
 * account it went to, and reconciliation can be matched against that
 * account's own settlement report. It changes no money flow. Optional per
 * outlet and provider: no row means the sale simply carries no account label.
 *
 * The account number is stored in plaintext on purpose (a deliberate choice,
 * not a credential): staff need it visible. Lists mask it to the last 4.
 *
 * `pos_order_settlements` snapshots the label and last 4 at settle time
 * (`terminal_account_label`, `terminal_account_last4`) with NO foreign key to
 * this table, so editing or removing a row never rewrites history.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('pos_outlet_terminal_accounts', (table) => {
    table.bigIncrements('id').primary();
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.string('provider', 20).notNullable().comment('moniepoint | opay | gtbank (never "other": it has no single account). Enforced in the application.');
    table.string('account_number', 40).notNullable();
    table.string('account_label', 80).nullable().comment('Optional friendly name, e.g. "Bar GTB settlement".');
    table.timestamps(true, true);
    table.unique(['outlet_id', 'provider'], { indexName: 'pos_outlet_terminal_accounts_outlet_provider_unique' });
    table.foreign(['tenant_id', 'property_id'], 'pos_outlet_terminal_accounts_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_outlet_terminal_accounts_outlet_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.comment('Per-outlet, per-provider bank account recorded for external card terminals (labels only, no money routing). Scope: PROPERTY_SCOPED.');
  });

  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.string('terminal_account_label', 80).nullable().comment("Snapshot at settle time, only for tender = 'terminal' with a named provider and a recorded outlet account.");
    table.string('terminal_account_last4', 4).nullable().comment('Snapshot: last 4 digits of the recorded account number.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropColumn('terminal_account_last4');
    table.dropColumn('terminal_account_label');
  });
  await knex.schema.dropTableIfExists('pos_outlet_terminal_accounts');
};
