'use strict';

/**
 * The outbox — ARCHITECTURE.md §13, PLAN.md Phase 3's Notifications module.
 * "The business transaction writes its normal state changes *and* an outbox
 * event row, in the same commit. A separate worker polls ... and dispatches
 * the actual side effect afterwards, independently, with its own retry
 * logic." This is the first table built against that pattern in this
 * codebase — `src/shared/outbox.js` is the write-side helper (mirroring
 * `src/shared/idempotency.js`'s shape), `src/jobs/outbox-dispatcher.js` is
 * the read/dispatch side.
 *
 * Scope: TENANT_SCOPED, not PROPERTY_SCOPED, deliberately following
 * `idempotency_keys`' own precedent rather than every other Phase 2 table:
 * ARCHITECTURE.md §13's own field list gives `property_id` as an ordinary
 * (non-scope-defining) column an event carries for context, and a handful of
 * genuinely tenant-level events (a future subscription/billing event, a
 * platform-wide notice) would otherwise need an invented property_id. Every
 * event this pass actually emits does carry a real property_id, but the
 * dispatcher and any tenant-level event this table needs to support in a
 * future pass should not need a schema change to do so.
 *
 * `event_type` is a short dotted string (`reservation.confirmed`), not an
 * enum: ARCHITECTURE.md §13's own list is explicitly "not exhaustive — add
 * an event type when a module genuinely needs one," and an enum would need a
 * migration for every new one.
 */

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('outbox_events', (table) => {
    table.comment(
      'A durable record of a side effect to dispatch after its triggering transaction commits (ARCHITECTURE.md section 13). Scope: TENANT_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().nullable().comment('Context, not scope — see file header.');

    table.string('event_type', 100).notNullable();
    table.string('aggregate_type', 60).notNullable();
    table.bigInteger('aggregate_id').unsigned().notNullable();
    table.json('payload').notNullable();

    table.enu('status', ['pending', 'processing', 'sent', 'failed']).notNullable().defaultTo('pending');
    table.integer('attempt_count').unsigned().notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.datetime('processed_at').nullable();

    timestamps(knex, table);

    table
      .foreign('tenant_id', 'outbox_events_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');

    // tests/isolation/entity-scope.test.js's generic rule: any table carrying
    // a property_id column — attribution or not — reaches `properties`
    // through (tenant_id, property_id), never a bare id, the same pattern
    // `auth_events` already established for a nullable attribution column.
    // MySQL's composite-FK match semantics mean this constraint simply does
    // not apply to a row whose property_id is NULL.
    table
      .foreign(['tenant_id', 'property_id'], 'outbox_events_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');

    // The dispatcher's own poll: pending rows, oldest first.
    table.index(['status', 'created_at'], 'outbox_events_status_created_at_index');
    table.index(['tenant_id', 'aggregate_type', 'aggregate_id'], 'outbox_events_aggregate_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('outbox_events');
};
