'use strict';

/**
 * `pos_outlet_terminal_accounts` becomes a free LIST of accounts per outlet
 * instead of one account per (outlet, provider). User-requested: the
 * provider stopped being the account's identity (a bank not on the provider
 * list could only be squeezed into a label) and the Register now picks an
 * ACCOUNT, not a provider.
 *
 * ONLY this table changes; `pos_order_settlements` is untouched (its
 * `terminal_account_label` / `terminal_account_last4` snapshots, which carry
 * no foreign key to this table, are what keep past sales exact).
 *
 * Additive and non-destructive:
 * - `provider` becomes nullable (existing values kept as they are);
 * - `bank_name` is new and nullable (existing rows read NULL);
 * - the unique (outlet_id, provider) index is replaced by a plain
 *   (outlet_id) index plus a unique (outlet_id, account_number) so the same
 *   account cannot be recorded twice for one outlet. The service stores
 *   account numbers without spaces; an existing row stays as it was written.
 *
 * `down` is faithful but can refuse: it cannot make `provider` NOT NULL while
 * a row has none, nor restore the unique (outlet_id, provider) while an
 * outlet holds two accounts for one provider. It fails loudly rather than
 * delete anything; resolve those rows by hand first.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_outlet_terminal_accounts', (table) => {
    table.string('bank_name', 80).nullable().comment('Optional free-text bank, e.g. "Zenith Bank". Not validated against any list.');
    table.index(['outlet_id'], 'pos_outlet_terminal_accounts_outlet_idx');
    table.unique(['outlet_id', 'account_number'], { indexName: 'pos_outlet_terminal_accounts_outlet_number_unique' });
  });
  await knex.raw('ALTER TABLE pos_outlet_terminal_accounts MODIFY provider VARCHAR(20) NULL');
  await knex.schema.alterTable('pos_outlet_terminal_accounts', (table) => {
    table.dropUnique(['outlet_id', 'provider'], 'pos_outlet_terminal_accounts_outlet_provider_unique');
  });
};

exports.down = async function down(knex) {
  const nullProvider = await knex('pos_outlet_terminal_accounts').whereNull('provider').count({ n: '*' }).first();
  if (Number(nullProvider.n) > 0) {
    throw new Error('Cannot roll back: some terminal accounts have no provider. Set or remove them first.');
  }
  await knex.schema.alterTable('pos_outlet_terminal_accounts', (table) => {
    table.unique(['outlet_id', 'provider'], { indexName: 'pos_outlet_terminal_accounts_outlet_provider_unique' });
  });
  await knex.raw('ALTER TABLE pos_outlet_terminal_accounts MODIFY provider VARCHAR(20) NOT NULL');
  await knex.schema.alterTable('pos_outlet_terminal_accounts', (table) => {
    table.dropUnique(['outlet_id', 'account_number'], 'pos_outlet_terminal_accounts_outlet_number_unique');
    table.dropIndex(['outlet_id'], 'pos_outlet_terminal_accounts_outlet_idx');
    table.dropColumn('bank_name');
  });
};
