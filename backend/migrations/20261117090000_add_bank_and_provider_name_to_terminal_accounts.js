'use strict';

/**
 * Terminal accounts: a free-text bank name, and accounts under "Other".
 *
 * The bank is never validated against any list (this is a recorded label for
 * reconciliation, not a payout), so `bank_name` is plain optional text.
 * A terminal provider that is not Moniepoint/Opay/GTBank is recorded under
 * `provider = 'other'` with its own typed name in `provider_name` (required for
 * `other`, null otherwise; enforced in the application). An outlet may record
 * one `other` account (the existing unique key on outlet + provider).
 *
 * The settlement snapshots both (`terminal_account_bank_name`,
 * `terminal_account_provider_name`) with no foreign key, like the label and
 * last 4, so editing the setting never rewrites history. Additive only.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_outlet_terminal_accounts', (table) => {
    table.string('bank_name', 80).nullable().comment('Optional free text; never validated against a bank list.');
    table.string('provider_name', 60).nullable().comment("Only for provider = 'other': the terminal provider's own name, typed by the admin.");
  });
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.string('terminal_account_bank_name', 80).nullable().comment('Snapshot of the recorded account bank name at settle time.');
    table.string('terminal_account_provider_name', 60).nullable().comment("Snapshot for provider 'other': the typed provider name.");
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_order_settlements', (table) => {
    table.dropColumn('terminal_account_provider_name');
    table.dropColumn('terminal_account_bank_name');
  });
  await knex.schema.alterTable('pos_outlet_terminal_accounts', (table) => {
    table.dropColumn('provider_name');
    table.dropColumn('bank_name');
  });
};
