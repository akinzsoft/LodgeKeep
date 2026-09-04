'use strict';

/**
 * Idempotency keys — ARCHITECTURE.md §7 and §11: "every important financial
 * mutation" (§7) and, more broadly, "every reservation transition endpoint"
 * (§11) accepts an `Idempotency-Key` header, since a retried "confirm this
 * reservation" or "check out" must not double-book, double-charge, or
 * double-close a folio. No mechanism for this exists anywhere in this
 * codebase yet — PLAN.md Phase 2's reservations module is the first module
 * that needs it, so this is shared infra (`src/shared/idempotency.js`), not
 * a one-off: Cashiering and Night Audit will reuse the identical table and
 * helper rather than inventing their own.
 *
 * Scope: TENANT_SCOPED. ARCHITECTURE.md §7: "an idempotency key is scoped to
 * one tenant + one operation type + the key value itself" — no property_id
 * dimension, deliberately: the same key value under two different
 * operation_type strings is not a collision, so the scope is exactly what
 * the spec names, no narrower and no wider.
 *
 * `expires_at` is what makes TESTING.md IDEM-6 ("key reused after its
 * retention window expires — treated as a new, unrelated operation") real:
 * ARCHITECTURE.md §7 recommends a 24-hour retention window, computed and
 * stored at write time rather than derived from `created_at` at read time,
 * so the retention window is a fixed property of the row instead of a
 * moving target if the recommended duration ever changes. The service-layer
 * helper (`withIdempotency`) treats an expired row as if it were absent:
 * IDEM-5's "different parameters -> 409 conflict" check and IDEM-6's
 * "expired -> new operation" check are both keyed off comparing `now()`
 * against this column, never off deleting rows eagerly.
 *
 * `UNIQUE(tenant_id, operation_type, key_value)` is the constraint the
 * lookup and the reuse-conflict check both rely on. The
 * `(tenant_id, expires_at)` index exists for a future prune job
 * (ARCHITECTURE.md §14's outbox-dispatch-style workers) — not built in this
 * pass, since nothing yet requires the table to be pruned for correctness,
 * only for size.
 */

function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('idempotency_keys', (table) => {
    table.comment(
      'One stored response for one (tenant, operation type, key) triple. Scope: TENANT_SCOPED. ARCHITECTURE.md section 7 and section 11.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table
      .string('operation_type', 60)
      .notNullable()
      .comment('e.g. "reservations.create", "reservations.check_in" — namespaces the key so the same value under two operations never collides.');

    table.string('key_value', 255).notNullable().comment('The raw Idempotency-Key header value, as the caller sent it.');

    table
      .string('request_hash', 64)
      .notNullable()
      .comment('SHA-256 hex digest of the request payload. A replay with the same key but a different hash is a reuse conflict (ARCHITECTURE.md section 7, CONFLICT_IDEMPOTENCY_KEY_REUSE).');

    table.integer('response_status').unsigned().notNullable();
    table.json('response_body').notNullable().comment('The exact envelope the first call returned, replayed verbatim on every subsequent call with the same key.');

    table
      .datetime('expires_at')
      .notNullable()
      .comment('created_at + the retention window (24h, ARCHITECTURE.md section 7), fixed at write time. A row past this is treated as absent, not deleted eagerly.');

    timestamps(knex, table);

    table.unique(['tenant_id', 'operation_type', 'key_value'], {
      indexName: 'idempotency_keys_tenant_id_operation_type_key_value_unique',
    });
    table.index(['tenant_id', 'expires_at'], 'idempotency_keys_tenant_id_expires_at_index');

    table
      .foreign('tenant_id', 'idempotency_keys_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('idempotency_keys');
};
