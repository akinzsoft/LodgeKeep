'use strict';

/**
 * `ar_payments` — a manually-recorded payment against a companys AR
 * account (this sessions confirmed decision: no gateway integration for AR
 * - staff record amount/method/reference/date; a real B2B wire or cheque is
 * collected outside this app). Deliberately NOT the `payments` table/state
 * machine (ARCHITECTURE.md section 7) - that machine is folio-shaped, one
 * payment per folio, where an AR payment can span multiple invoices/folios/
 * reservations at once (see `ar_payment_applications`).
 *
 * The full `amount` reduces `ar_accounts.current_balance` immediately on
 * recording, regardless of how much of it has been allocated to a specific
 * invoice yet - see ar/service.js`s `recomputeArAccountBalance` and
 * `ar_payment_applications`s own migration header for why application is
 * bookkeeping only, never a gate on the real balance.
 *
 * Void, never delete (ARCHITECTURE.md section 8) - only the three audited
 * void fields ever change after insert.
 *
 * Scope: PROPERTY_SCOPED, following `ar_accounts`.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('ar_payments', (table) => {
    table.comment('A manually-recorded payment against a company AR account - no gateway involved. Void, never delete. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('ar_account_id').unsigned().notNullable();

    table.decimal('amount', 12, 2).notNullable().comment('Total amount received, positive. Reduces the account balance immediately - see migration header.');
    table.string('currency', 3).notNullable();
    table.string('method_label', 50).notNullable().comment('Free text, e.g. "wire", "cheque", "bank_transfer" - no enum, this is a description staff supply.');
    table.string('reference', 100).nullable();
    table.date('received_at').notNullable();
    table.date('business_date').notNullable();

    table.bigInteger('recorded_by_user_id').unsigned().nullable();
    table.text('notes').nullable();

    table.datetime('voided_at').nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();
    table.string('void_reason', 500).nullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    // Parent key for ar_payment_applications below.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'ar_payments_tenant_property_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'ar_payments_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'ar_account_id'], 'ar_payments_tenant_property_account_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('ar_accounts')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'recorded_by_user_id'], 'ar_payments_tenant_recorded_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'ar_payments_tenant_voided_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'ar_account_id'], 'ar_payments_tenant_property_account_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ar_payments');
};
