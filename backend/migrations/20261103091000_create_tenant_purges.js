'use strict';

/**
 * `tenant_purges` — progress, lease and block state for the tenant retention-
 * expiry purge (`src/modules/offboarding/purge.js`). One row per tenant.
 *
 * `tenants.status` (offboarding -> purging -> purged) remains the resume marker
 * and the source of truth for WHAT phase a tenant is in. This table holds
 * everything that is not a phase:
 *
 *   - `state`            scheduled (offboarding, waiting for the deadline),
 *                        blocked (deadline reached, not purgeable yet — see
 *                        `blocked_reason`), running (claimed, deleting),
 *                        completed
 *   - `blocked_reason`   why the purge cannot start, surfaced to platform staff
 *                        (no completed export, export file missing, ...)
 *   - `export_id`        the completed export that satisfied the gate
 *   - `lease_*`          so two backend instances do not delete the same tenant
 *                        at once. The deletes are idempotent, so this is
 *                        efficiency and safety-in-depth, not the correctness
 *                        mechanism.
 *   - `clean_passes`     consecutive verification ticks that found no tenant-owned
 *                        row left; the tenant only becomes `purged` after two
 *   - `deleted_counts`   per-table row counts, for the final audit row
 *   - `warned_*`         the T-7d / T-1d warning emails, so each is sent once
 *   - `offboarding_requested_at`  which offboarding cycle this row describes. A
 *                        tenant that is reactivated and later offboards AGAIN is
 *                        a fresh cycle: the sweep resets the row when this no
 *                        longer matches the tenant's own value.
 *
 * PLATFORM_SCOPED with `tenant_id` an `unscopedColumns` mandatory business
 * column — the shape `subscriptions`/`tenant_data_exports` established: Planmsys's
 * own bookkeeping about a job run against a tenant, not the tenant's operational
 * data. RETAINED after a purge (it is the record that one happened).
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

exports.up = async function up(knex) {
  await knex.schema.createTable('tenant_purges', (table) => {
    table.comment('Progress, lease and block state of a tenant retention purge, one row per tenant. Scope: PLATFORM_SCOPED, tenant_id mandatory. Retained after the purge.');

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table.enu('state', ['scheduled', 'blocked', 'running', 'completed']).notNullable().defaultTo('scheduled');
    table.datetime('offboarding_requested_at').nullable().comment('The offboarding cycle this row describes; a different value on the tenant means a fresh cycle.');

    table.string('blocked_reason', 64).nullable();
    table.datetime('blocked_at').nullable();

    table.bigInteger('export_id').unsigned().nullable().comment('The completed tenant_data_exports row that satisfied the export gate.');

    table.datetime('started_at').nullable();
    table.datetime('completed_at').nullable();

    table.string('lease_owner', 64).nullable();
    table.datetime('lease_expires_at').nullable();

    table.integer('attempts').unsigned().notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.tinyint('clean_passes').unsigned().notNullable().defaultTo(0);

    table.json('deleted_counts').nullable();
    table.json('files_deleted').nullable();

    table.datetime('warned_7d_at').nullable();
    table.datetime('warned_1d_at').nullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.unique(['tenant_id'], { indexName: 'tenant_purges_tenant_id_unique' });
    table.index(['state', 'lease_expires_at'], 'tenant_purges_state_lease_index');

    table.foreign('tenant_id', 'tenant_purges_tenant_id_foreign').references('id').inTable('tenants').onDelete(RESTRICT.onDelete).onUpdate(RESTRICT.onUpdate);
    table
      .foreign(['tenant_id', 'export_id'], 'tenant_purges_export_foreign')
      .references(['tenant_id', 'id'])
      .inTable('tenant_data_exports')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tenant_purges');
};
