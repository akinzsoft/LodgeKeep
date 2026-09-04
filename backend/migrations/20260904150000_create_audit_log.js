'use strict';

/**
 * audit_log — SECURITY.md §6, DATABASE.md's "Migration & audit" section,
 * PLAN.md Phase 0 ("Audit trail — audit_log write path, usable as middleware
 * from any module").
 *
 * SECURITY.md §6 gives the full field set and the reason for each field
 * beyond the obvious entity/action/before/after — "who changed this and was
 * it a person or a job" is a question that comes up constantly in a financial
 * system. This migration is that field set, verbatim.
 *
 * ── SCOPE: TENANT_SCOPED, WITH property_id AS ATTRIBUTION ─────────────────
 *
 * Every audited action happens post-authentication — unlike `auth_events`,
 * there is no "we don't know the tenant yet" case here, so `tenant_id` is a
 * normal, NOT NULL, accessor-enforced scope column.
 *
 * `property_id` is different. Most audited entities are property-scoped
 * (a reservation, a folio, a room-status change), but SECURITY.md §1.1 also
 * requires auditing tenant-level admin actions — "user role changes,
 * permission grants, rate overrides" — and a role definition edit
 * (`roles`, `role_permissions`) has no property at all. Forcing NOT NULL here
 * would make tenant-level actions unauditable; forcing PROPERTY_SCOPED
 * through the accessor would mean no admin screen could ever query "everything
 * this tenant's audit log holds" without threading `acrossProperties()`
 * through code that has nothing to do with properties. So `property_id` is
 * nullable and declared as an `attributionColumns` entry in
 * `table-scopes.js` — present and meaningful when the action has one, never
 * part of the scope guarantee the accessor injects. See the auth_events
 * migration for the precedent this follows.
 *
 * ── entity_id HAS NO FOREIGN KEY, DELIBERATELY ─────────────────────────────
 *
 * This table is polymorphic by design — `entity_type` names which table
 * `entity_id` refers to, and that table changes row to row. A real foreign
 * key can only ever point at one table, so there is structurally no
 * declarable FK here; ARCHITECTURE.md §10's BIGINT UNSIGNED convention is
 * followed anyway; so a manual join to the entity's own table by id is at
 * least type-correct. This is the one place in the schema a `_id`-shaped
 * column intentionally carries no referential integrity — the write path
 * (`src/audit/service.js`) is what is trusted to only ever pass a real id.
 *
 * ── action IS A VARCHAR, NOT AN ENUM ────────────────────────────────────
 *
 * `auth_events.event_type` is an ENUM because that vocabulary is fixed and
 * small (~17 values, all in one migration). `audit_log.action` is not: API.md
 * §5 ties this column one-to-one with an endpoint action name ("check-in",
 * "void", "cancel", "refund", ...) across the 23 modules PRODUCT_REQUIREMENTS.md
 * describes, and that vocabulary is meant to grow by one value every time a
 * future module adds a mutating endpoint. An ENUM would turn every new
 * endpoint into a migration against this table specifically — exactly the
 * "configuration, not code branches" instinct PRODUCT_REQUIREMENTS.md §1.1
 * argues against, applied to a schema column instead of a code branch.
 *
 * ── WHY NOT THE OUTBOX (ARCHITECTURE.md §13) ───────────────────────────────
 *
 * The outbox pattern is for side effects that leave the database — email, an
 * external webhook call, anything ARCHITECTURE.md §13 says "cannot commit
 * atomically with a payment provider" and so must be dispatched after the
 * fact by a worker. An audit row is not a side effect leaving the database;
 * it is data as durable and as internal as the row it describes, and
 * `src/audit/service.js` is written to be called inside the SAME transaction
 * as the mutation it records — an audit row that silently failed to write
 * would be worse than useless in a financial system, so there is no
 * "eventually" here.
 *
 * Reference: SECURITY.md §1.1, §6; ARCHITECTURE.md §3, §10, §13; API.md §5;
 * DATABASE.md §2–3; PLAN.md Phase 0.
 */

const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
const IP_LENGTH = 45;

/**
 * SECURITY.md §6: "source ... lets a manager answer 'was this reservation
 * change made by a person or by night audit rolling the date forward'
 * without guessing." Fixed set, unlike `action` — these six describe WHERE a
 * mutation originated, a much smaller and much more stable vocabulary than
 * WHAT it did.
 */
const SOURCES = ['web', 'api', 'job', 'migration', 'platform_impersonation', 'integration'];

exports.up = async function up(knex) {
  await knex.schema.createTable('audit_log', (table) => {
    table.comment(
      'Full audit trail — who changed what, when, and why. Scope: TENANT_SCOPED; property_id is attribution, not scope (SECURITY.md §6, §1.1). Append-only: no update or delete path, ever — a wrong entry is corrected by a new entry, exactly like a financial record (ARCHITECTURE.md §8).'
    );

    table.bigIncrements('id');

    table.bigInteger('tenant_id').unsigned().notNullable();

    table
      .bigInteger('property_id')
      .unsigned()
      .nullable()
      .comment('NULL for a tenant-level action (a role definition edit, a rate-plan template) that has no single property. Attribution, not scope — see the file header.');

    table
      .string('entity_type', 100)
      .notNullable()
      .comment('The table the row describes, e.g. "reservations", "folios". Together with entity_id this is a polymorphic reference with no declared foreign key — see the file header.');

    table.bigInteger('entity_id').unsigned().nullable().comment('NULL only for an action with no single row, e.g. a bulk import summary.');

    table
      .string('action', 100)
      .notNullable()
      .comment('One-to-one with the endpoint that performed it (API.md §5) — check-in, void, cancel, refund, create, update, status_change, .... VARCHAR, not ENUM: see the file header for why.');

    table.bigInteger('user_id').unsigned().nullable().comment('NULL when source is a job or a migration, not a person.');

    table.json('before_state').nullable().comment('NULL on create.');
    table.json('after_state').nullable().comment('NULL on a genuine hard delete — rare; DATABASE.md §3 prefers void/archive.');

    table
      .datetime('occurred_at')
      .notNullable()
      .defaultTo(knex.fn.now());

    table
      .string('request_id', 64)
      .nullable()
      .comment('Correlates to the request_id in the API.md §2 error envelope and to the matching auth_events row for the same request. NULL for job/migration-sourced entries, which have no HTTP request.');

    table.string('ip_address', IP_LENGTH).nullable();
    table.string('user_agent', 512).nullable();

    table.enu('source', SOURCES).notNullable();

    table
      .text('reason')
      .nullable()
      .comment('Populated where the action required one — voids, refunds, overrides (SECURITY.md §6). NULL elsewhere; not a substitute for a UI-level required-field check, which is DESIGN_SYSTEM.md §2\'s job.');

    table
      .foreign('tenant_id', 'audit_log_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'property_id'], 'audit_log_tenant_id_property_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The generic rule tests/isolation/entity-scope.test.js enforces on any
    // table carrying user_id: reached through (tenant_id, user_id), never a
    // bare user_id (SECURITY.md §2).
    table
      .foreign(['tenant_id', 'user_id'], 'audit_log_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The hot query: "the history of this one record."
    table.index(
      ['tenant_id', 'entity_type', 'entity_id', 'occurred_at'],
      'audit_log_tenant_id_entity_type_entity_id_occurred_at_index'
    );

    // "What did this person do" — support for the users FK too.
    table.index(['tenant_id', 'user_id', 'occurred_at'], 'audit_log_tenant_id_user_id_occurred_at_index');

    // Date-range exports/compliance reads across every entity type.
    table.index(['tenant_id', 'occurred_at'], 'audit_log_tenant_id_occurred_at_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('audit_log');
};
