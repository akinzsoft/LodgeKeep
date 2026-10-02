'use strict';

/**
 * Per-outlet Paystack subaccounts for online / QR / Register card payments.
 *
 * Before this, one Paystack subaccount per PROPERTY (`property_payment_subaccounts`)
 * received every outlet's online payments. An outlet that banks separately can
 * now have its own. Resolution (`startPaystackCheckout`): the order's outlet
 * account if it has one, else the property's, else the checkout is refused
 * (422) — never routed to the platform account. The property table is NOT
 * touched, so a property with no outlet accounts behaves exactly as before.
 *
 * `pos_outlet_payment_subaccounts` is APPEND-ONLY HISTORY: changing an
 * outlet's bank deactivates the old row and inserts a new one, never updates
 * it in place, so a past payment's `subaccount_code` always resolves to the
 * account it really used (reconciliation joins on the code). Exactly one
 * active row per outlet is enforced by a UNIQUE index on `active_outlet_id`
 * (the outlet id while active, NULL once deactivated; NULLs never collide).
 *
 * `payments.subaccount_source` snapshots WHICH level the payment's
 * `subaccount_code` came from ('outlet' | 'property'), written next to
 * `subaccount_code` and never re-derived. NULL on every existing row (and on
 * cash); reconciliation reads NULL-with-a-code as 'property'. A nullable
 * column with no default added at the end of the table is a metadata-only
 * (ALGORITHM=INSTANT) change in MySQL 8.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('pos_outlet_payment_subaccounts', (table) => {
    table.comment('An outlet-owned Paystack Subaccount for online card payments; append-only history, one active row per outlet. Scope: PROPERTY_SCOPED.');
    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('outlet_id').unsigned().notNullable();
    table.bigInteger('platform_payment_integration_id').unsigned().notNullable().comment('Merchant integration this subaccount was created under. Plain FK — the parent is GLOBAL_REFERENCE.');
    table.string('subaccount_code', 100).notNullable().comment('Paystack code (ACCT_...), passed as `subaccount` on every charge routed to this outlet.');
    table.string('bank_code', 10).notNullable();
    table.string('bank_name', 150).notNullable();
    table.string('account_number_last4', 4).notNullable().comment('Display only; the full number is never retained.');
    table.string('account_name', 150).notNullable().comment('The name Paystack resolved the account to.');
    table.decimal('percentage_charge', 5, 2).notNullable().defaultTo('0.00');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    table.unique(['subaccount_code'], { indexName: 'pos_outlet_payment_subaccounts_code_unique' });
    table.index(['tenant_id', 'property_id', 'outlet_id'], 'pos_outlet_payment_subaccounts_outlet_index');
    table.foreign(['tenant_id', 'property_id'], 'pos_outlet_payment_subaccounts_property_fk').references(['tenant_id', 'id']).inTable('properties').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign(['tenant_id', 'property_id', 'outlet_id'], 'pos_outlet_payment_subaccounts_outlet_fk').references(['tenant_id', 'property_id', 'id']).inTable('pos_outlets').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table.foreign('platform_payment_integration_id', 'pos_outlet_payment_subaccounts_integration_fk').references('id').inTable('platform_payment_integrations').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
  });
  await knex.raw(
    'ALTER TABLE pos_outlet_payment_subaccounts ADD COLUMN active_outlet_id BIGINT UNSIGNED GENERATED ALWAYS AS (IF(is_active, outlet_id, NULL)) VIRTUAL, ' +
      'ADD UNIQUE INDEX pos_outlet_payment_subaccounts_one_active_unique (active_outlet_id)'
  );

  await knex.raw("ALTER TABLE payments ADD COLUMN subaccount_source ENUM('outlet','property') NULL COMMENT 'Which level subaccount_code came from. Null for cash and for every payment made before this column existed.', ALGORITHM=INSTANT");
};

exports.down = async function down(knex) {
  const used = await knex('payments').where({ subaccount_source: 'outlet' }).count({ n: '*' }).first();
  if (Number(used.n) > 0) {
    throw new Error(`Refusing to roll back: ${used.n} payment(s) were routed to an outlet subaccount. Rolling back would erase which account they settled to.`);
  }
  await knex.raw('ALTER TABLE payments DROP COLUMN subaccount_source');
  await knex.schema.dropTableIfExists('pos_outlet_payment_subaccounts');
};
