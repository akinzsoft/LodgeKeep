'use strict';

/**
 * `impersonation_sessions` — PLAN.md Phase 5 (Platform Foundation),
 * SECURITY.md §2 ("an explicit, time-bounded impersonation path that is
 * logged, visible to the tenant, and never a silent super-admin flag").
 * DATABASE.md's own long-standing draft named this table
 * (`platform_user_id, tenant_id, reason, started_at, ended_at`) — this
 * migration is that draft made real, with the one column the draft was
 * missing (`expires_at`) added to satisfy API.md §4's own quoted
 * requirement: "every route... requires an active impersonation grant,
 * checked per request, not just at token issuance."
 *
 * Scope: PLATFORM_SCOPED, no `attributionColumns` — unlike `auth_events`/
 * `payment_webhook_events`, `tenant_id`/`property_id` here are mandatory,
 * known-at-creation real data (a platform admin always names a real tenant
 * and property when starting a grant), not a late-arriving attribution for
 * an event that might precede tenant resolution. Every read against this
 * table is a hand-written, explicitly-reviewed query
 * (`src/modules/platform/service.js`) — never the accessor's auto-injected
 * scope, since none applies to a PLATFORM_SCOPED table by design.
 *
 * `property_id` pins one impersonation grant to one property, chosen at
 * start — this session's own confirmed simplification. Viewing a different
 * property means ending this grant and starting a fresh, separately
 * reasoned, separately audited one, not switching mid-session.
 *
 * `reason` is NOT NULL — the identical "money confirmations require a
 * reason" discipline this codebase already enforces for a credit-limit
 * override or a void, applied here to a different, equally consequential
 * kind of confirmation.
 *
 * `ended_at` is set only by an explicit "Exit impersonation" action — a
 * session whose `expires_at` has simply lapsed without ever being
 * explicitly ended is still distinguishable (`expires_at <= now() AND
 * ended_at IS NULL`), both cases correctly treated as "no longer active"
 * by `src/auth/middleware.js`'s own per-request re-verification.
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
  await knex.schema.createTable('impersonation_sessions', (table) => {
    table.comment(
      'An audited, time-bounded platform-staff grant to view one tenant/property read-only (SECURITY.md section 2). Scope: PLATFORM_SCOPED.'
    );

    table.bigIncrements('id');
    table.bigInteger('platform_user_id').unsigned().notNullable();
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    table.text('reason').notNullable();

    table.datetime('started_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('expires_at').notNullable();
    table
      .datetime('ended_at')
      .nullable()
      .comment('Set only by an explicit Exit action. NULL past expires_at means lapsed, not explicitly ended — both are "no longer active".');

    table.string('ip', 45).nullable();
    table.string('user_agent', 512).nullable();

    timestamps(knex, table);

    table
      .foreign('platform_user_id', 'impersonation_sessions_platform_user_id_foreign')
      .references('id')
      .inTable('platform_users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign('tenant_id', 'impersonation_sessions_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // Composite (tenant_id, property_id), matching every other
    // property-referencing table in this schema — a row cannot pair one
    // tenant's id with another tenant's property at the DATABASE level,
    // not merely by `service.js`'s own application-side check before
    // insert (the isolation suite's own generic "references its parents by
    // scope, not by bare id" assertion enforces this for any table
    // carrying a property_id, regardless of that table's own scope).
    table
      .foreign(['tenant_id', 'property_id'], 'impersonation_sessions_tenant_property_foreign')
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'started_at'], 'impersonation_sessions_tenant_started_index');
    table.index(['platform_user_id', 'started_at'], 'impersonation_sessions_platform_user_started_index');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('impersonation_sessions');
};
