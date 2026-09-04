'use strict';

/**
 * Tenants and properties — the two tables every other table in the system
 * hangs off.
 *
 * `tenant_id` is the paying customer; `property_id` is a physical hotel, and
 * one tenant may own several. Both columns exist from day one even for
 * single-property customers, because retrofitting the split later is the single
 * most expensive mistake available on this project (PRODUCT_REQUIREMENTS.md
 * §1.1, ARCHITECTURE.md §1).
 *
 * Scope classification (ARCHITECTURE.md §3), which the scoped data-access layer
 * reads to decide what it injects into every query against these tables:
 *
 *   tenants     TENANT_SCOPED    — its own id *is* the tenant scope
 *   properties  PROPERTY_SCOPED  — carries tenant_id; its own id is property_id
 *
 * Reference: DATABASE.md §1 (columns), §2 (unique constraints), §3 (lifecycle).
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('tenants', (table) => {
    table.comment(
      'The paying customer — an independent hotel or a hotel group. Scope: TENANT_SCOPED.'
    );

    // BIGINT UNSIGNED auto-increment, serialized as a STRING in JSON
    // (ARCHITECTURE.md §10) — a high-volume tenant exceeds 2^53 over years and
    // JavaScript loses precision above it.
    table.bigIncrements('id');

    table.string('name', 255).notNullable();

    // UNIQUE(slug) — DATABASE.md §2. Tenant slugs are global, not per-tenant:
    // they address the tenant itself.
    table.string('slug', 100).notNullable().unique();

    table
      .enu('status', ['trial', 'active', 'suspended', 'offboarding'])
      .notNullable()
      .defaultTo('trial')
      .comment('Trial expiry degrades to read-only, never a hard lockout on a system holding live reservations (PLAN.md Phase 5).');

    // Nullable, and deliberately without a foreign key for now: `plans` is a
    // PLATFORM_SCOPED table that arrives with subscription billing in Phase 5
    // (PLAN.md). The column exists from the start so tenant provisioning does
    // not need a schema change to record a plan; the FK is added in the same
    // migration that creates `plans`.
    table.bigInteger('plan_id').unsigned().nullable();

    table.datetime('trial_ends_at').nullable();

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table
      .datetime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    table.index(['status'], 'tenants_status_index');
    table.index(['plan_id'], 'tenants_plan_id_index');
  });

  await knex.schema.createTable('properties', (table) => {
    table.comment(
      'A physical hotel belonging to a tenant. Scope: PROPERTY_SCOPED — its own id is the property_id every operational table carries.'
    );

    table.bigIncrements('id');

    table.bigInteger('tenant_id').unsigned().notNullable();

    table.string('slug', 100).notNullable();
    table.string('name', 255).notNullable();
    table.text('address').nullable();

    // No default on either of these two, deliberately.
    //
    // A default timezone would bake in an assumption that the platform's
    // timezone is the property's, which is exactly what the business-date
    // design forbids — every property sits at a different point in time
    // (PRODUCT_REQUIREMENTS.md §1.1, ARCHITECTURE.md §6). A default currency
    // would hardcode a market (§1.1). Both must be chosen explicitly at
    // property setup.
    table
      .string('timezone', 64)
      .notNullable()
      .comment('IANA timezone identifier, e.g. "Africa/Lagos". No default — never assume the platform timezone is the property timezone.');
    table
      .string('base_currency', 3)
      .notNullable()
      .comment('ISO 4217. Every money column carries its currency; this is the property\'s own accounting currency (ARCHITECTURE.md §12.2).');

    // DATE, not datetime: the business date is an accounting date, not an
    // instant. Nullable until the property is initialised in Phase 1 — a
    // property with no business date has not opened yet, which is a different
    // state from one sitting on a date.
    table
      .date('current_business_date')
      .nullable()
      .comment('The property\'s accounting truth, advanced only by night audit (ARCHITECTURE.md §6). Never derived from the server clock.');

    table.string('logo_url', 512).nullable();
    table
      .json('theme')
      .nullable()
      .comment('Tenant/property theming overrides for the design tokens (DESIGN_SYSTEM.md §1). Configuration, never a code branch.');

    // DATABASE.md §3 — properties are never hard-deleted: tenant history,
    // reporting, and every property-scoped table reference them.
    table
      .enu('status', ['active', 'suspended', 'archived'])
      .notNullable()
      .defaultTo('active');

    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table
      .datetime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    // UNIQUE(tenant_id, slug) — DATABASE.md §2. Enforced at the database level,
    // not in application code, which would be a race condition
    // (ARCHITECTURE.md §5).
    table.unique(['tenant_id', 'slug'], { indexName: 'properties_tenant_id_slug_unique' });

    // RESTRICT, not CASCADE (ARCHITECTURE.md §1): a cascade delete that
    // silently wipes a tenant's properties — and, transitively, the folio
    // history hanging off them — is worse than a failed delete.
    table
      .foreign('tenant_id', 'properties_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');

    table.index(['tenant_id', 'status'], 'properties_tenant_id_status_index');
  });
};

exports.down = async function down(knex) {
  // Reverse order: properties holds the foreign key into tenants.
  await knex.schema.dropTableIfExists('properties');
  await knex.schema.dropTableIfExists('tenants');
};
