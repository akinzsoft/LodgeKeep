'use strict';

/**
 * `night_audit_runs` — PLAN.md Phase 2.5 step 3, ARCHITECTURE.md §6 (the
 * full run-state machine, recovery model, and exact sequence). DATABASE.md
 * §1's own row for this table (`property_id, business_date, status,
 * worker_id, heartbeat_at, started_at, completed_at, failed_at, error,
 * run_by_user_id`) — that row was written down before this table was built
 * (PLAN.md Phase 3's own note: "Not built (Night Audit is not this pass's
 * scope)"); this migration is what finally builds it.
 *
 * ── ONE ROW PER (property, business_date), REUSED ACROSS RETRIES ────────
 *
 * ARCHITECTURE.md §6's concurrency table gives the mechanism explicitly:
 * "a `night_audit_runs` row inserted at the START of the run (UNIQUE on
 * property + business date) before any posting happens — the second run
 * sees the row exists and refuses immediately." That unique constraint only
 * makes sense as ONE row per date, reused across a retry — §6.1 already
 * says "A FAILED run returns the property to READY for that date, so a
 * retry can start clean," which means the retry claims the SAME row (an
 * `UPDATE ... WHERE status = 'FAILED'` guard, atomically re-checked the
 * identical way the insert-or-conflict is) rather than inserting a second
 * row that would collide on this exact constraint. See
 * `src/modules/night-audit/service.js`'s `runNightAudit` for the full
 * insert-or-reclaim logic this schema is built for.
 *
 * `exceptions` (JSON, beyond DATABASE.md §1's baseline column list — added
 * here the same way earlier phases extended a table beyond that file's
 * initial sketch and then updated it to match) holds §6.2 step 10's
 * "flagged exceptions" (an in-house reservation with no open folio, an
 * unresolved housekeeping discrepancy) — "these do not block the run, but
 * must appear in the output," which needs somewhere durable to live.
 *
 * This migration also adds this table's own 3-column composite parent key
 * (DATABASE.md §2's rule) — `daily_reports` (this pass's other new table)
 * is another PROPERTY_SCOPED table referencing this one, so the same
 * pattern `folios`'/`payments`' own migrations in this pass already needed
 * applies here too.
 *
 * `worker_id` is a real per-process identifier (`crypto.randomUUID()` at
 * module load), not a hostname — §6.1: "two workers on the same host must
 * be distinguishable." No separate monitor process sweeps `heartbeat_at`
 * in this pass (flagged in `src/modules/night-audit/service.js`'s own
 * header) — recovery is evaluated lazily, on the next run attempt for that
 * property, rather than by a continuously-polling background process.
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
  await knex.schema.createTable('night_audit_runs', (table) => {
    table.comment(
      'One night-audit execution per (property, business_date), reused across retries. Scope: PROPERTY_SCOPED. Follows the state machine in ARCHITECTURE.md section 6 — see migration header.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.date('business_date').notNullable();

    table
      .enu('status', ['RUNNING', 'COMPLETED', 'FAILED', 'STALE', 'RECOVERABLE'])
      .notNullable()
      .comment('ARCHITECTURE.md section 6.1. READY is not a stored value — it is the absence of a row, or a terminal (COMPLETED/FAILED) one.');

    table.string('worker_id', 100).notNullable().comment('A real per-process identifier, not a hostname (section 6.1).');
    table.datetime('heartbeat_at').notNullable();
    table.datetime('started_at').notNullable();
    table.datetime('completed_at').nullable();
    table.datetime('failed_at').nullable();
    table.text('error').nullable();

    table
      .json('exceptions')
      .nullable()
      .comment('Section 6.2 step 10\'s flagged exceptions — do not block the run, but must appear in the output. See migration header.');

    table.bigInteger('run_by_user_id').unsigned().nullable().comment('Null when the run was resumed/reclaimed by a recovery path rather than an explicit staff trigger.');

    timestamps(knex, table);

    table.unique(['property_id', 'business_date'], { indexName: 'night_audit_runs_property_id_business_date_unique' });
    table.unique(['tenant_id', 'property_id', 'id'], { indexName: 'night_audit_runs_tenant_id_property_id_id_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'night_audit_runs_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'run_by_user_id'], 'night_audit_runs_tenant_id_run_by_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('night_audit_runs');
};
