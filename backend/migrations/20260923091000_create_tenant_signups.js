'use strict';

/**
 * `tenant_signups` — PLAN.md Phase 5's self-service signup, one narrow job:
 * enforce "one self-service signup per email, ever" as a real database
 * constraint, not a check-then-write.
 *
 * `users.email` is unique only PER TENANT (`UNIQUE(tenant_id, email)`,
 * `20260903202134_create_identity_and_access.js`) — an ordinary staff member
 * may legitimately share an email with someone at an unrelated tenant, and
 * every tenant signup mints a brand-new `tenant_id`, so that constraint can
 * never itself catch a repeat signup (ARCHITECTURE.md §5: "concurrency uses
 * database locks, not check-then-write" — a pre-insert SELECT-then-decide
 * check here would race two concurrent signups with the same email). This
 * table's own real `UNIQUE(email)` is the actual guard: the signup
 * transaction inserts a row here in the same transaction as the tenant it
 * creates, and a repeat attempt hits a genuine `ER_DUP_ENTRY` the database
 * itself serializes, not a race window.
 *
 * PLATFORM_SCOPED (`src/shared/table-scopes.js`) — this is platform-side
 * bookkeeping about the signup event itself, not a tenant's own operational
 * data, the same classification `impersonation_sessions` already uses for
 * an analogous reason. `tenant_id` is real, mandatory, known-at-creation
 * data (which tenant this email founded), not scope-column attribution —
 * `unscopedColumns` in `table-scopes.js` names it the same way that file
 * already does for `impersonation_sessions.tenant_id`/`property_id`.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('tenant_signups', (table) => {
    table.comment('One row per self-service tenant signup, keyed by the founding admin email. Enforces one signup per email as a real constraint, not a check-then-write (PLAN.md Phase 5).');

    table.bigIncrements('id');

    table
      .string('email', 255)
      .notNullable()
      .unique('tenant_signups_email_unique')
      .comment('The founding admin email. Case-sensitivity follows the column collation, same as users.email.');

    table.bigInteger('tenant_id').unsigned().notNullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());

    table
      .foreign('tenant_id', 'tenant_signups_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('tenant_signups');
};
