'use strict';

/**
 * `tenant_data_exports` — PLAN.md Phase 5, PRODUCT_REQUIREMENTS.md §3.22.
 * One row per export ATTEMPT (not one row per tenant) — a failed attempt
 * gets retried as a fresh row, the identical "attempt is its own entity"
 * reasoning `subscription_payments` already established for dunning
 * retries, applied here to a job attempt instead of a charge attempt.
 *
 * PLATFORM_SCOPED with `tenant_id` an `unscopedColumns` mandatory business
 * column — the identical shape `impersonation_sessions`/`tenant_signups`/
 * `subscriptions` already established (Planmsys' own record of a job run
 * against a tenant, not the tenant's own operational data), reached only
 * through hand-written queries in `src/modules/offboarding/service.js`,
 * never the accessor's generic `table()` path.
 *
 * Exactly one of `requested_by_user_id` / `requested_by_platform_user_id`
 * is set, never both — confirmed with the user: offboarding can be
 * tenant-initiated (a real admin/super_admin self-service request) OR
 * platform-initiated (a support-handled cancellation). No DB CHECK
 * constraint enforces the exclusivity; `src/modules/offboarding/service.js`
 * is the one writer for each column and never sets both, the same
 * "the service layer is the one place this invariant is guaranteed"
 * shape this codebase already accepts for plenty of business rules that
 * aren't worth a schema-level CHECK.
 *
 * `requested_by_user_id` uses the same 3-column composite FK
 * `(tenant_id, requested_by_user_id) -> users(tenant_id, id)` pattern
 * `room_types`/`rate_codes` first established for a real cross-table
 * reference, here crossing from a PLATFORM_SCOPED table into a
 * TENANT_SCOPED one via the shared `tenant_id`.
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
  await knex.schema.createTable('tenant_data_exports', (table) => {
    table.comment(
      'One export ATTEMPT for a tenant, never one row per tenant — a failed attempt is retried as a fresh row. Scope: PLATFORM_SCOPED, tenant_id mandatory (unscoped, not attribution).'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table
      .enu('status', ['pending', 'processing', 'completed', 'failed'])
      .notNullable()
      .defaultTo('pending');

    table.bigInteger('requested_by_user_id').unsigned().nullable().comment('Set for a tenant-initiated request; null for a platform-initiated one.');
    table.bigInteger('requested_by_platform_user_id').unsigned().nullable().comment('Set for a platform-initiated request; null for a tenant-initiated one.');
    table.text('reason').nullable();

    table.string('file_path', 500).nullable().comment('Path under EXPORT_STORAGE_DIR — never a public URL. Set only once status is completed.');
    table.bigInteger('file_size_bytes').unsigned().nullable();
    table.datetime('completed_at').nullable();
    table.datetime('downloaded_at').nullable().comment('Last successful download — informational only, never enforced as a limit.');
    table.text('failed_reason').nullable();

    timestamps(knex, table);

    table.unique(['tenant_id', 'id'], { indexName: 'tenant_data_exports_tenant_id_id_unique' });

    table
      .foreign('tenant_id', 'tenant_data_exports_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'requested_by_user_id'], 'tenant_data_exports_requested_by_user_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign('requested_by_platform_user_id', 'tenant_data_exports_requested_by_platform_user_foreign')
      .references('id')
      .inTable('platform_users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'status'], 'tenant_data_exports_tenant_id_status_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tenant_data_exports');
};
