'use strict';

/**
 * `ar_payment_applications` - a join table allocating a recorded AR payment
 * against one or more AR invoices. Required because a real wire or cheque
 * routinely covers more than one outstanding invoice at once
 * (PRODUCT_REQUIREMENTS.md section 3.9s "payment collection workflows") -
 * a single `applied_to_invoice_id` column on `ar_payments` (DATABASE.mds
 * own simplified draft) cannot express that.
 *
 * `sum(amount for one ar_payment_id) <= ar_payments.amount` for that
 * payment - a payment need not be fully applied at the moment it is
 * recorded (an "on-account" payment is a normal AR pattern). The UNAPPLIED
 * portion still reduces the accounts real exposure immediately (see
 * ar_payments own migration header) - application here is purely a
 * bookkeeping allocation deciding which invoice(s) show partially_paid/paid,
 * never a second, disagreeing notion of how much the company really owes.
 *
 * `voided_at`/`voided_by_user_id` (void, never delete, ARCHITECTURE.md
 * section 8) rather than a hard delete when an application is reversed
 * (e.g. the invoice or payment it belongs to is voided) - a query of "which
 * applications were ever made" must never be lossy. Every read that sums
 * "current applications" filters `WHERE voided_at IS NULL`.
 *
 * Scope: PROPERTY_SCOPED, following `ar_payments`/`ar_invoices`.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('ar_payment_applications', (table) => {
    table.comment(
      'Allocates part or all of one AR payment to one AR invoice. Bookkeeping only - see migration header for why it never gates the real account balance. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('ar_payment_id').unsigned().notNullable();
    table.bigInteger('ar_invoice_id').unsigned().notNullable();

    table.decimal('amount', 12, 2).notNullable().comment('Portion of the payment applied to this invoice.');

    table.datetime('voided_at').nullable();
    table.bigInteger('voided_by_user_id').unsigned().nullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    // Deliberately NOT a UNIQUE(tenant_id, property_id, ar_payment_id, ar_invoice_id) constraint:
    // applying the same payment to the same invoice more than once is a normal, legitimate
    // sequence (a payment applied in two installments, or a corrected re-application after an
    // earlier application to this exact pair was voided) - each application call is its own
    // event row, matching this codebase's void-never-delete/one-row-per-event discipline rather
    // than trying to merge repeat applications into a single mutable row. The real "don't exceed
    // what's owed" limits are enforced in application code (assertWithinCreditLimit's sibling
    // checks in ar/service.js), summing only non-voided rows for a pair - a plain index (not a
    // uniqueness guarantee) is enough to make that lookup efficient.
    table.index(['tenant_id', 'property_id', 'ar_payment_id', 'ar_invoice_id'], 'ar_payment_apps_tenant_property_payment_invoice_idx');

    table
      .foreign(['tenant_id', 'property_id'], 'ar_payment_apps_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'ar_payment_id'], 'ar_payment_apps_tenant_property_payment_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('ar_payments')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'ar_invoice_id'], 'ar_payment_apps_tenant_property_invoice_id_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('ar_invoices')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'voided_by_user_id'], 'ar_payment_apps_tenant_voided_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ar_payment_applications');
};
