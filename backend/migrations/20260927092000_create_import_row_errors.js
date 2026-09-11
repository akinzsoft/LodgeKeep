'use strict';

/**
 * `import_row_errors` — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.20.
 * DATABASE.md forward-declared `(import_run_id, row_number, column,
 * message)` — "drives the dry-run error table." Deliberately EXTENDED here,
 * not built byte-for-byte to that draft, because the dry-run -> duplicate-
 * review -> commit flow needs somewhere durable to hold the operator's
 * per-row duplicate decision between two separate requests (§3.20: "present
 * likely duplicates for a human decision... never auto-merge"), and this is
 * the one row-level table that already exists for exactly this shape.
 *
 * `column` (DATABASE.md's own name) is renamed to `column_name` here —
 * `column` is a reserved word in enough SQL contexts to be worth avoiding,
 * the same reasoning this codebase already applies elsewhere (e.g.
 * `ar_invoice_lines` never names a column `index`).
 *
 * `severity` covers three real cases dry run can flag a row for, per
 * §3.20's own text: a genuine blocking `error` (missing required field,
 * invalid date, unknown room type, departure before arrival — the row will
 * be skipped at commit, no decision needed), a `duplicate_candidate` (a
 * likely-duplicate guest — commit is BLOCKED until every one of these
 * carries a `resolution`), and an `availability_conflict` (an imported
 * future reservation that would oversell a date — informational only,
 * never blocks commit; §3.20: "shown as warnings before commit").
 *
 * `resolution`/`resolved_guest_id` are only ever set for
 * `severity = 'duplicate_candidate'` rows. Two values only —
 * `use_existing`/`create_new` — not the three §3.20's UI text literally
 * names ("keep/merge/create-new"): a real field-level merge (which phone
 * number wins, re-pointing prior history) is `guests.status = 'merged'`'s
 * own future mechanism, unbuilt anywhere in this codebase today. Routing
 * the imported activity onto the existing guest (`use_existing`) already
 * delivers the practical outcome a migration-time "merge" means, without
 * inventing new merge semantics this pass wasn't asked to build — a named
 * scope reduction against the literal spec text, not a silent substitution.
 *
 * Scope: TENANT_SCOPED, following `import_runs` (its own parent).
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('import_row_errors', (table) => {
    table.comment(
      'One per-row finding from a dry run or commit attempt — a blocking error, a duplicate-guest candidate awaiting a resolution, or an informational availability conflict. Scope: TENANT_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('import_run_id').unsigned().notNullable();

    table.integer('row_number').unsigned().notNullable().comment('1-based, data rows only — excludes the CSV header row.');
    table.string('column_name', 100).nullable();

    table
      .enu('severity', ['error', 'duplicate_candidate', 'availability_conflict'])
      .notNullable()
      .defaultTo('error');
    table.string('message', 500).notNullable();

    table
      .enu('resolution', ['use_existing', 'create_new'])
      .nullable()
      .comment('Only meaningful for severity=duplicate_candidate. Commit is blocked while any duplicate_candidate row has no resolution.');
    table.bigInteger('resolved_guest_id').unsigned().nullable().comment('Set only when resolution=use_existing — which existing guest this row was matched to.');

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table
      .foreign('tenant_id', 'import_row_errors_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'import_run_id'], 'import_row_errors_tenant_run_foreign')
      .references(['tenant_id', 'id'])
      .inTable('import_runs')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'resolved_guest_id'], 'import_row_errors_tenant_resolved_guest_foreign')
      .references(['tenant_id', 'id'])
      .inTable('guests')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'import_run_id', 'row_number'], 'import_row_errors_run_row_index');
    table.index(['tenant_id', 'import_run_id', 'severity'], 'import_row_errors_run_severity_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('import_row_errors');
};
