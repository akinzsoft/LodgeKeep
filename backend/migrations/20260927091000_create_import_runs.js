'use strict';

/**
 * `import_runs` — PLAN.md Phase 5's last unbuilt bullet, PRODUCT_REQUIREMENTS.md
 * §3.20 ("Data Migration"). DATABASE.md's own "Migration & audit (3.20, 4.1)"
 * section forward-declared this table's shape (tenant_id, entity_type,
 * file_ref, status, rows_total, rows_created, rows_skipped, run_by,
 * completed_at — "Rollback unit") since Phase 5's platform-foundation pass;
 * unbuilt until now.
 *
 * Scope: TENANT_SCOPED, matching DATABASE.md's own column list (just
 * `tenant_id`) — an import run is real tenant-owned history ("what was
 * imported, what was skipped, and why" — §3.20's own "migration report"
 * requirement), not Planmsys-internal bookkeeping the way
 * `tenant_data_exports`/`subscriptions` are. `property_id` is added as a
 * nullable ATTRIBUTION column, not a scope column — the identical shape
 * `audit_log.property_id` already establishes: a `guests`/`companies`
 * import has no single property (guests and companies are both
 * TENANT_SCOPED), so this column is real, meaningful data for the two
 * entity types that DO need one (`reservations`, `ar_balances`) without the
 * accessor ever requiring or injecting it.
 *
 * `status` covers the full lifecycle a run actually passes through:
 * uploaded (file received, nothing validated yet) -> dry_run_complete (a
 * preview exists, nothing written) -> committing (the operator confirmed;
 * the async job is working) -> completed -> failed (the job itself blew up,
 * e.g. couldn't re-read the file) -> rolled_back / partially_rolled_back
 * (see `imported_record_map`'s own header for why "partially" is a real,
 * distinct, honestly-reported outcome, not swept into "rolled_back").
 *
 * `rows_created`/`rows_skipped` carry the dry run's PREDICTED counts first,
 * then are overwritten with commit's ACTUAL counts once the job finishes —
 * the same "recomputed, not incrementally maintained" discipline this
 * codebase already applies to every other derived total (`folios.balance`,
 * `ar_accounts.current_balance`).
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
  await knex.schema.createTable('import_runs', (table) => {
    table.comment(
      'One data-migration import attempt — PRODUCT_REQUIREMENTS.md §3.20, the rollback unit imported_record_map hangs off of. Scope: TENANT_SCOPED, property_id a nullable attribution column.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table
      .bigInteger('property_id')
      .unsigned()
      .nullable()
      .comment('Attribution, not scope — only meaningful for reservations/ar_balances entity_types; guests/companies are tenant-wide and carry null here.');

    table
      .enu('entity_type', ['guests', 'reservations', 'companies', 'ar_balances'])
      .notNullable()
      .comment('§3.20\'s own four supported inputs. One CSV template, and one run, per entity type — never a mixed-entity file.');

    table
      .enu('status', ['uploaded', 'dry_run_complete', 'committing', 'completed', 'failed', 'rolled_back', 'partially_rolled_back'])
      .notNullable()
      .defaultTo('uploaded');

    table.string('original_filename', 255).notNullable();
    table.string('file_path', 500).notNullable().comment('Path under IMPORT_STORAGE_DIR — never a public URL, the same shape tenant_data_exports.file_path already established.');

    table.integer('rows_total').unsigned().nullable();
    table.integer('rows_created').unsigned().nullable().comment('Dry run\'s PREDICTED count, overwritten with commit\'s ACTUAL count. See migration header.');
    table.integer('rows_skipped').unsigned().nullable();

    table.bigInteger('run_by_user_id').unsigned().notNullable();

    table.datetime('completed_at').nullable();
    table.datetime('rolled_back_at').nullable();
    table.bigInteger('rolled_back_by_user_id').unsigned().nullable();
    table.string('failed_reason', 2000).nullable();

    timestamps(knex, table);

    // Parent key for import_row_errors/imported_record_map's composite FKs.
    table.unique(['tenant_id', 'id'], { indexName: 'import_runs_tenant_id_id_unique' });

    table
      .foreign('tenant_id', 'import_runs_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id'], 'import_runs_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'run_by_user_id'], 'import_runs_tenant_run_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'rolled_back_by_user_id'], 'import_runs_tenant_rolled_back_by_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'entity_type', 'status'], 'import_runs_tenant_entity_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('import_runs');
};
