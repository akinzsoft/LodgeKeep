'use strict';

/**
 * `ar_invoices` — PLAN.md Phase 4, PRODUCT_REQUIREMENTS.md section 3.9
 * ("Company invoicing"), TESTING.md AR-1 ("Invoice from folios - Total
 * matches source folio lines").
 *
 * Scope: PROPERTY_SCOPED, following `ar_accounts`.
 *
 * No `draft` status - generation directly produces `issued` (this session's
 * confirmed AR scope has no review/approval workflow before an invoice is
 * real). `overdue` is never a stored status - it is a derived label
 * computed at report time from `due_at` vs the propertys own
 * `current_business_date` (ARCHITECTURE.md section 6, business date is
 * never wall clock), avoiding a background job to flip statuses nothing
 * else in this codebase has a precedent for.
 *
 * `total_amount` is a snapshot taken at generation time, immutable
 * afterward (ARCHITECTURE.md section 8) - it is never recomputed from
 * `ar_invoice_lines` after the fact.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('ar_invoices', (table) => {
    table.comment('One generated AR invoice against a company account. total_amount is an immutable snapshot at generation time. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('ar_account_id').unsigned().notNullable();

    table.string('invoice_number', 40).notNullable();
    table.string('currency', 3).notNullable();
    table.decimal('total_amount', 12, 2).notNullable();
    table.enu('status', ['issued', 'partially_paid', 'paid', 'void']).notNullable().defaultTo('issued');

    table.date('issued_at').notNullable();
    table.date('due_at').notNullable();
    table.date('business_date').notNullable();

    table.bigInteger('created_by_user_id').unsigned().nullable();
    table.datetime('voided_at').nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();
    table.string('void_reason', 500).nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'property_id', 'invoice_number'], { indexName: 'ar_invoices_tenant_property_invoice_number_unique' });
    // Parent key for ar_invoice_lines and ar_payment_applications below.
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'ar_invoices_tenant_property_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'ar_invoices_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'ar_account_id'], 'ar_invoices_tenant_property_account_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('ar_accounts')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'created_by_user_id'], 'ar_invoices_tenant_created_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'ar_invoices_tenant_voided_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id', 'ar_account_id', 'status'], 'ar_invoices_tenant_property_account_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ar_invoices');
};
