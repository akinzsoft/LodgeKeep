'use strict';

/**
 * `ar_invoice_sequences` — a small per-property counter table backing
 * human-readable invoice numbers (`INV-{propertyId}-{padded number}`), not
 * a ULID. DATABASE.md's own AR draft names `invoice_number` as a real
 * business-facing field a company would quote back on a wire transfer or a
 * query - a ULID (ARCHITECTURE.md section 10, "safe to expose without
 * revealing sequence/volume information") is exactly wrong for that; a
 * confirmation number and an invoice number are different in kind.
 *
 * Lazily created, one row per property, locked and incremented atomically
 * inside `generateInvoice`s own transaction (ar/service.js) - the identical
 * insert-if-missing-then-SELECT-FOR-UPDATE-then-increment sequence
 * `room_type_inventory`s last-room race already established
 * (ARCHITECTURE.md section 5), reused here for a different resource.
 *
 * Scope: PROPERTY_SCOPED, following `ar_accounts`.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('ar_invoice_sequences', (table) => {
    table.comment('One row per property, locked and incremented to allocate the next sequential AR invoice number. Scope: PROPERTY_SCOPED.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.integer('next_number').unsigned().notNullable().defaultTo(1);

    table.unique(['tenant_id', 'property_id'], { indexName: 'ar_invoice_sequences_tenant_property_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'ar_invoice_sequences_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ar_invoice_sequences');
};
