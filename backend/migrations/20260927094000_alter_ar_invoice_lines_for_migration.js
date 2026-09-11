'use strict';

/**
 * Data-migration support for "outstanding AR balances" — PLAN.md Phase 5,
 * PRODUCT_REQUIREMENTS.md §3.20: "bring balances forward as opening AR
 * entries rather than reconstructing closed folios." Every existing AR
 * writer (`ar/service.js`'s `generateInvoice`) invoices REAL, already-
 * posted `folio_line_items` rows — `ar_invoice_lines.folio_line_item_id`
 * has been `NOT NULL` since Phase 4, a structural requirement that a
 * migrated opening balance (by definition, no real folio behind it) cannot
 * satisfy.
 *
 * Two changes, together:
 *
 * (1) `ar_invoice_lines.folio_line_item_id` becomes NULLABLE. Safe and
 *     non-weakening: InnoDB's UNIQUE index treats every NULL as a DISTINCT
 *     value, so `UNIQUE(tenant_id, property_id, folio_line_item_id)`
 *     (20260918094000) keeps enforcing "a real folio line can be invoiced
 *     at most once" exactly as before, while permitting arbitrarily many
 *     synthetic opening-balance lines (`folio_line_item_id = NULL`) with
 *     zero constraint conflict. `source` distinguishes the two kinds
 *     explicitly rather than leaving a reader to infer it from nullness
 *     alone. `description` is new because a migrated line has no real
 *     folio charge to describe it via a join — a real folio-derived line
 *     still gets its description from `folio_line_items.description`
 *     unchanged; this column is null for that case, and only ever
 *     populated for `source = 'migration_opening_balance'`.
 *
 * (2) `ar_accounts.opening_balance_imported` is the actual balance
 *     contribution — `ar_invoice_lines` stays display/paper-trail only for
 *     a migrated balance (so it shows up on the Invoices/Ageing tabs like
 *     any other line), it does NOT feed `recomputeArAccountBalance` (that
 *     function sums real `folio_line_items`, which a migrated balance has
 *     none of). `recomputeArAccountBalance` gains a third additive term —
 *     see `src/modules/ar/service.js`'s own updated header — read from the
 *     same locking `.forUpdate()` row read already in that function, so
 *     this stays the identical "one source of truth, always re-derived"
 *     mechanism, not a second, independently-maintained total.
 *     `opening_balance_import_run_id` is purely informational (which run
 *     most recently contributed to this figure) — an account can accept
 *     more than one migration's opening balance over time in principle, so
 *     this is not itself the rollback mechanism; rollback locates and
 *     reverses the contribution via `imported_record_map` instead.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('ar_invoice_lines', (table) => {
    table.bigInteger('folio_line_item_id').unsigned().nullable().alter();
  });
  await knex.schema.alterTable('ar_invoice_lines', (table) => {
    table
      .enu('source', ['folio_line', 'migration_opening_balance'])
      .notNullable()
      .defaultTo('folio_line')
      .comment('Distinguishes a real folio-derived line from a data-migration synthetic opening-balance line. See migration header.');
    table.string('description', 255).nullable().comment('Only populated for source=migration_opening_balance — a real folio_line still describes itself via folio_line_items.description.');
  });

  await knex.schema.alterTable('ar_accounts', (table) => {
    table
      .decimal('opening_balance_imported', 12, 2)
      .notNullable()
      .defaultTo('0.00')
      .comment('A data-migration opening balance — the third additive term recomputeArAccountBalance sums alongside real charges/payments. See migration header.');
    table.bigInteger('opening_balance_import_run_id').unsigned().nullable().comment('Informational only — which run most recently contributed. Not the rollback mechanism (see imported_record_map).');
  });
  await knex.schema.alterTable('ar_accounts', (table) => {
    table
      .foreign(['tenant_id', 'opening_balance_import_run_id'], 'ar_accounts_opening_balance_import_run_foreign')
      .references(['tenant_id', 'id'])
      .inTable('import_runs')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('ar_accounts', (table) => {
    table.dropForeign(['tenant_id', 'opening_balance_import_run_id'], 'ar_accounts_opening_balance_import_run_foreign');
  });
  await knex.schema.alterTable('ar_accounts', (table) => {
    table.dropColumn('opening_balance_import_run_id');
    table.dropColumn('opening_balance_imported');
  });
  await knex.schema.alterTable('ar_invoice_lines', (table) => {
    table.dropColumn('description');
    table.dropColumn('source');
  });
  await knex.schema.alterTable('ar_invoice_lines', (table) => {
    table.bigInteger('folio_line_item_id').unsigned().notNullable().alter();
  });
};
