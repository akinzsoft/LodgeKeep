'use strict';

/**
 * `daily_reports` — PLAN.md Phase 2.5 step 3, ARCHITECTURE.md §6.2 step 9
 * ("Generate the `daily_reports` snapshot"). DATABASE.md §1's own row:
 * "property_id, business_date, room_revenue, pos_revenue,
 * payments_collected, occupancy_pct, adr, revpar." Filed as "Not built"
 * since PLAN.md Phase 3 (Reporting was live-computed instead, explicitly
 * flagged as a workaround pending this table) — this migration finally
 * builds it.
 *
 * This is what closes PLAN.md Phase 3's own named gap: "Report figures
 * reconcile against the underlying folio data for a seeded day" now has a
 * real folio ledger to reconcile against — `room_revenue`/
 * `payments_collected` here are computed from real `folio_line_items` rows
 * posted during the run (`src/modules/night-audit/service.js`), not
 * `reservation_daily_rates` snapshots the way Reporting's own live-computed
 * `computeRevenue` still does for the CURRENT (not-yet-audited) business
 * date. `pos_revenue` stays `0.00` — no POS module exists (Phase 4/6).
 *
 * `night_audit_run_id` (beyond DATABASE.md §1's baseline column list) links
 * a snapshot back to the run that generated it — a natural, low-risk
 * addition the same way `related_line_item_id` was added to
 * `folio_line_items` in this same pass, for the identical "the row that
 * produced this" traceability. Both `daily_reports` and `night_audit_runs`
 * are PROPERTY_SCOPED, so this is another PROPERTY_SCOPED-to-PROPERTY_SCOPED
 * reference (DATABASE.md §2) — the FK below is the full 3-column
 * composite against `night_audit_runs(tenant_id, property_id, id)`, not a
 * plain single-column reference.
 *
 * `UNIQUE(property_id, business_date)` — a business date is audited exactly
 * once (ARCHITECTURE.md §6.1: "A COMPLETED run for a property + business
 * date blocks any further run for that same date"), so exactly one snapshot
 * per date can ever exist.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('daily_reports', (table) => {
    table.comment(
      'The occupancy/revenue snapshot night audit generates for one property + business_date (ARCHITECTURE.md section 6.2 step 9). Scope: PROPERTY_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('night_audit_run_id').unsigned().notNullable();

    table.date('business_date').notNullable();

    table.decimal('room_revenue', 12, 2).notNullable();
    table.decimal('pos_revenue', 12, 2).notNullable().defaultTo('0.00').comment('Always 0.00 — no POS module exists yet (Phase 4/6).');
    table.decimal('payments_collected', 12, 2).notNullable();

    table.decimal('occupancy_pct', 5, 2).notNullable();
    table.decimal('adr', 12, 2).notNullable();
    table.decimal('revpar', 12, 2).notNullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['property_id', 'business_date'], { indexName: 'daily_reports_property_id_business_date_unique' });

    table
      .foreign(['tenant_id', 'property_id'], 'daily_reports_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id', 'night_audit_run_id'], 'daily_reports_tenant_id_property_id_night_audit_run_id_fk')
      .references(['tenant_id', 'property_id', 'id'])
      .inTable('night_audit_runs')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('daily_reports');
};
