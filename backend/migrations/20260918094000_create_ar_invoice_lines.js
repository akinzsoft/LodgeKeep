'use strict';

/**
 * `ar_invoice_lines` — links an AR invoice to the individual
 * `folio_line_items` rows it bills, not to a whole folio. This lets one
 * invoice legitimately span multiple folios and multiple reservations for
 * the same company (a monthly corporate invoice covering several different
 * guests stays), matching TESTING.md AR-1s own phrasing ("total matches
 * source folio lines," plural).
 *
 * `UNIQUE(tenant_id, property_id, folio_line_item_id)` is the STRUCTURAL
 * double-invoicing guard - a folio line can be invoiced at most once, ever.
 * `generateInvoice`s own `LEFT JOIN ... WHERE ail.id IS NULL` eligibility
 * filter (ar/service.js) is the primary mechanism; this constraint is the
 * belt-and-suspenders backstop, mapped to a real 409 via
 * `withDuplicateMapping`.
 *
 * `amount`/`currency`/`business_date` are copied from the source line at
 * invoice time (ARCHITECTURE.md section 8 immutability) rather than joined
 * live, so a later void of the source line item (which this pass otherwise
 * blocks once invoiced - see `voidLineItem` in cashiering/service.js) can
 * never retroactively change what an already-issued invoice says it billed.
 *
 * Scope: PROPERTY_SCOPED, following `ar_invoices`.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('ar_invoice_lines', (table) => {
    table.comment(
      'One folio_line_items row billed on one AR invoice. UNIQUE on the source line is the structural double-invoicing guard - see migration header. Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('ar_invoice_id').unsigned().notNullable();
    table.bigInteger('folio_line_item_id').unsigned().notNullable();

    table.decimal('amount', 12, 2).notNullable().comment('Snapshot copy of folio_line_items.amount at invoice time - immutable per ARCHITECTURE.md section 8.');
    table.string('currency', 3).notNullable();
    table.date('business_date').notNullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'property_id', 'folio_line_item_id'], {
      indexName: 'ar_invoice_lines_tenant_property_folio_line_unique',
    });

    table
      .foreign(['tenant_id', 'property_id'], 'ar_invoice_lines_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'ar_invoice_id'], 'ar_invoice_lines_tenant_property_invoice_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('ar_invoices')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'folio_line_item_id'], 'ar_invoice_lines_tenant_property_folio_line_foreign')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('folio_line_items')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ar_invoice_lines');
};
