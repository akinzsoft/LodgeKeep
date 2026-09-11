'use strict';

/**
 * `imported_record_map` — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.20:
 * "each import run gets an id, every created record is tagged with it, and
 * a run can be rolled back wholesale." DATABASE.md's own forward-declared
 * shape (`import_run_id, entity_type, entity_id` — "enables wholesale
 * rollback") is exactly what's built here.
 *
 * `entity_id` carries NO foreign key, by design — the same polymorphic-
 * reference precedent `audit_log.entity_id` already established: this one
 * row can point at a `guests`, `reservations`, `company_profiles`,
 * `ar_accounts`, or `ar_invoices` row, and a single FK can't reference five
 * different parent tables at once.
 *
 * `created` (TINYINT/boolean) is the field that makes rollback correct
 * rather than merely simple: `true` when this run's commit actually
 * INSERTed the row, `false` when the row merely REUSED a pre-existing one
 * (a guest row the operator resolved `use_existing` against, or an
 * `ar_accounts` row that already existed before this run touched it).
 * Rollback only ever reverses `created = true` rows — reusing an existing
 * guest must never let a later rollback delete that guest out from under
 * every OTHER reservation/folio that also legitimately references them.
 *
 * `(import_run_id, row_number, entity_type)` is the unique key, not
 * `(import_run_id, row_number)` alone — one CSV row can map to more than
 * one entity (an `ar_balances` row creates both an `ar_accounts` row, if
 * one didn't already exist, and a synthetic `ar_invoices` row). The same
 * key also makes the commit job's per-row retry-after-crash resumability
 * possible: `WHERE import_run_id = ? AND row_number IN (...)` tells the
 * job exactly which rows a prior, crashed attempt already finished.
 *
 * `inventory_reserved` (reservation rows only; always `false` for every
 * other entity_type) is a code-review finding, added before this branch
 * ever shipped: rollback originally re-derived "did this reservation
 * actually hold real room_type_inventory" by comparing its departure_date
 * against the property's CURRENT business date at rollback time — wrong,
 * because the business date advances (Night Audit runs daily) between
 * commit and a later rollback, so a reservation that genuinely held
 * inventory at commit time could look "historical, never held it" by the
 * time someone rolls the run back, silently leaking a permanent +1 on
 * `room_type_inventory.rooms_sold`. This column instead records the true,
 * frozen fact at the one moment it's actually known — commit time — so
 * rollback only ever consults its own prior write, never re-derives
 * anything from a value that can drift out from under it.
 *
 * Scope: TENANT_SCOPED, following `import_runs`.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('imported_record_map', (table) => {
    table.comment(
      'Which real row each committed CSV row created (or reused) — the rollback unit for one import run. entity_id is deliberately FK-less, a polymorphic reference like audit_log.entity_id. Scope: TENANT_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('import_run_id').unsigned().notNullable();

    table.integer('row_number').unsigned().notNullable();
    table
      .enu('entity_type', ['guest', 'reservation', 'company_profile', 'ar_account', 'ar_invoice'])
      .notNullable();
    table.bigInteger('entity_id').unsigned().notNullable().comment('Deliberately FK-less — a polymorphic reference across five possible parent tables. See migration header.');

    table
      .boolean('created')
      .notNullable()
      .defaultTo(true)
      .comment('true: this run INSERTed the row. false: this run merely reused a pre-existing one — rollback never touches these. See migration header.');

    table
      .boolean('inventory_reserved')
      .notNullable()
      .defaultTo(false)
      .comment('entity_type=reservation only: true iff this row actually incremented room_type_inventory at commit time. Rollback consults this directly rather than re-deriving it from the CURRENT business date. See migration header.');

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'import_run_id', 'row_number', 'entity_type'], {
      indexName: 'imported_record_map_run_row_entity_unique',
    });

    table
      .foreign('tenant_id', 'imported_record_map_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'import_run_id'], 'imported_record_map_tenant_run_foreign')
      .references(['tenant_id', 'id'])
      .inTable('import_runs')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'import_run_id', 'created'], 'imported_record_map_run_created_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('imported_record_map');
};
