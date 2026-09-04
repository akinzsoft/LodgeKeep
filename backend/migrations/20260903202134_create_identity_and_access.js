'use strict';

/**
 * Identity & access — DATABASE.md §1 ("Identity & access"), SECURITY.md §3–4.
 *
 * THREE IDENTITY POPULATIONS, THREE TABLES. This is the structural point of
 * this migration and the reason there is no single `users` table:
 *
 *   users            hotel staff        TENANT_SCOPED    → /api/v1/*
 *   platform_users   Planmsys staff     PLATFORM_SCOPED  → /api/v1/platform/*
 *   guest_accounts   hotel guests       PROPERTY_SCOPED  → /api/v1/portal/*
 *
 * They are separate tables, not a `type` column on one table, because a shared
 * table makes "a guest session satisfied a PMS route" a one-line mistake rather
 * than an impossibility (API.md §4, TESTING.md AUTH-12, PLAN.md Phase 4). A
 * token's audience is decided by which table minted it.
 *
 * `platform_users` deliberately has **no `tenant_id`** (DATABASE.md §1,
 * ARCHITECTURE.md §3 PLATFORM_SCOPED). Platform staff reach tenant data only
 * through the audited, time-bounded impersonation path (SECURITY.md §2); that
 * grant is `impersonation_sessions`, which lands with the platform console in
 * Phase 5 (PLAN.md).
 *
 * ROLES ARE PER PROPERTY, NEVER GLOBAL (SECURITY.md §4). `user_property_access`
 * is the whole mechanism: a user holding `manager` at property A and
 * `front_desk` at property B is the normal case, so a role can only be read
 * out of a (user, property) pair. There is deliberately no `role` column on
 * `users` — a global role column is what makes `if (user.role === 'manager')`
 * writable in the first place. The one exception SECURITY.md §4 allows,
 * tenant-level `super_admin`, is still expressed as a role held at each
 * property, so the authorization check has exactly one shape everywhere.
 *
 * Scope classification (ARCHITECTURE.md §3), which the scoped data-access layer
 * reads to decide what it injects into every query against these tables:
 *
 *   users                 TENANT_SCOPED    — tenant_id
 *   roles                 TENANT_SCOPED    — tenant_id
 *   role_permissions      TENANT_SCOPED    — tenant_id (follows its role)
 *   permissions           GLOBAL_REFERENCE — the permission-key catalogue
 *   user_property_access  PROPERTY_SCOPED  — tenant_id + property_id
 *   platform_users        PLATFORM_SCOPED  — nothing tenant-related
 *   guest_accounts        PROPERTY_SCOPED  — tenant_id + property_id
 *
 * Reference: DATABASE.md §1 (columns), §2 (unique constraints), §3 (lifecycle);
 * ARCHITECTURE.md §3 (scoping), §10 (IDs); SECURITY.md §1.1, §3–5.
 */

/**
 * Every foreign key in this file is RESTRICT/RESTRICT.
 *
 * ARCHITECTURE.md §1 and §8: a cascade that silently removes a tenant's users —
 * and with them the identities every `audit_log`, `folio_line_items` and
 * `auth_events` row points at — is worse than a failed delete. DATABASE.md §3
 * says the same thing from the lifecycle side: users deactivate, never delete.
 * ON UPDATE RESTRICT matters too: these keys are never re-pointed in place.
 */
const RESTRICT = { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };

/** created_at / updated_at, assumed on every table (DATABASE.md §1). */
function timestamps(knex, table) {
  table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  table
    .datetime('updated_at')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

exports.up = async function up(knex) {
  // ---------------------------------------------------------------------
  // properties — parent key for the composite foreign keys added below.
  // ---------------------------------------------------------------------
  //
  // `user_property_access` and `guest_accounts` reference properties by
  // (tenant_id, id) rather than by id alone, so that a child row physically
  // cannot pair a tenant with another tenant's property. InnoDB needs the
  // referenced columns to be the leftmost prefix of an index on the parent, and
  // the tenants/properties migration has no such index — (tenant_id, slug) and
  // (tenant_id, status) both diverge at the second column.
  //
  // Added here rather than by editing the earlier migration, which is checked
  // in and may already have run. Adding an index is backwards-compatible: it
  // constrains no existing data, since `id` is already unique on its own
  // (DATABASE.md, migrations run against every tenant at once).
  await knex.schema.alterTable('properties', (table) => {
    table.unique(['tenant_id', 'id'], { indexName: 'properties_tenant_id_id_unique' });
  });

  // ---------------------------------------------------------------------
  // users — hotel staff. TENANT_SCOPED.
  // ---------------------------------------------------------------------
  await knex.schema.createTable('users', (table) => {
    table.comment(
      'Hotel staff identity. Scope: TENANT_SCOPED. Deactivate, never delete — audit_log and every posted_by_user_id reference this row (DATABASE.md §3).'
    );

    // BIGINT UNSIGNED, serialized as a STRING in JSON (ARCHITECTURE.md §10).
    table.bigIncrements('id');

    table.bigInteger('tenant_id').unsigned().notNullable();

    table
      .string('email', 255)
      .notNullable()
      .comment('Login identity, unique per tenant — the same person may be staff at two unrelated tenants. utf8mb4_0900_ai_ci is case-insensitive, so the constraint treats A@x and a@x as one address.');

    // Never a plaintext or reversible password (SECURITY.md §1.1). bcrypt/argon2
    // output only; 255 leaves room for argon2id parameters, which are longer
    // than bcrypt's fixed 60 characters.
    table.string('password_hash', 255).notNullable();

    table.string('first_name', 100).notNullable();
    table.string('last_name', 100).notNullable();

    // DATABASE.md §3: users go active → inactive and are never hard-deleted.
    // A deactivated user's live session must fail on its next request
    // (TESTING.md AUTH-10), which is a check against this column.
    table.enu('status', ['active', 'inactive']).notNullable().defaultTo('active');

    table.datetime('last_login_at').nullable();

    table.boolean('mfa_enabled').notNullable().defaultTo(false);
    table
      .string('mfa_secret', 255)
      .nullable()
      .comment('Encrypted at rest like any other secret (SECURITY.md §1.1) — the column stores ciphertext, never a bare TOTP seed.');

    // No failed-attempt counter or lockout column here, deliberately.
    // Brute-force lockout is the auth rate-limit tier, and that tier is
    // per-account *and* per-IP with counters in Redis (ARCHITECTURE.md §15,
    // SECURITY.md §1.1). Duplicating the account dimension as a column would
    // create a second, divergent source of truth for the same decision.
    //
    // The Redis part of that is superseded — see the block comment in
    // 20260904101500_create_auth_events.js. Account lockout (423 LOCKED_ACCOUNT)
    // is counted from `auth_events` in MySQL so it survives a restart;
    // rate limiting (429 RATE_LIMITED) is the Redis-backed tier. Two controls,
    // two stores, two status codes. The conclusion here is unchanged: neither
    // of them is a column on this table.

    timestamps(knex, table);

    // UNIQUE(tenant_id, email) — DATABASE.md §2.
    table.unique(['tenant_id', 'email'], { indexName: 'users_tenant_id_email_unique' });

    // Not in DATABASE.md §2's list, and not a business rule: this is the parent
    // key for the composite foreign keys below, which is how a child row is
    // stopped from pairing a user with another tenant's property or role. It is
    // implied by the primary key (id is already unique), so it adds a guarantee
    // for the schema without constraining any data.
    table.unique(['tenant_id', 'id'], { indexName: 'users_tenant_id_id_unique' });

    table
      .foreign('tenant_id', 'users_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // Every index leads with tenant_id — every query filters on it
    // (DATABASE.md §1, indexing notes).
    table.index(['tenant_id', 'status'], 'users_tenant_id_status_index');
  });

  // ---------------------------------------------------------------------
  // roles — TENANT_SCOPED.
  // ---------------------------------------------------------------------
  await knex.schema.createTable('roles', (table) => {
    table.comment(
      'The role vocabulary a tenant assigns in user_property_access. Scope: TENANT_SCOPED — ARCHITECTURE.md §3 lists roles under TENANT_SCOPED, so the standard set is seeded per tenant at provisioning rather than shared globally, and the scoped accessor has no unscoped path to it.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();

    table
      .string('code', 50)
      .notNullable()
      .comment('Machine key: front_desk, cashier, housekeeping, pos_operator, manager, admin, super_admin (SECURITY.md §5). Referenced by user_property_access.role.');

    table.string('name', 100).notNullable();
    table.text('description').nullable();

    table
      .boolean('is_system')
      .notNullable()
      .defaultTo(false)
      .comment('True for the seven roles in SECURITY.md §5 authorization matrix, seeded into every tenant. System roles are not renamed or deleted by a tenant — the matrix is tested against these codes (TESTING.md AUTH suite).');

    table.enu('status', ['active', 'archived']).notNullable().defaultTo('active');

    timestamps(knex, table);

    // Not listed in DATABASE.md §2, but §2's own instruction applies: a table
    // whose entity is "a code unique per tenant" adds the constraint in the
    // migration that creates it. It is also the parent key for
    // user_property_access.role.
    table.unique(['tenant_id', 'code'], { indexName: 'roles_tenant_id_code_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'roles_tenant_id_id_unique' });

    table
      .foreign('tenant_id', 'roles_tenant_id_foreign')
      .references('id')
      .inTable('tenants')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'status'], 'roles_tenant_id_status_index');
  });

  // ---------------------------------------------------------------------
  // permissions — GLOBAL_REFERENCE.
  // ---------------------------------------------------------------------
  await knex.schema.createTable('permissions', (table) => {
    table.comment(
      'The permission-key catalogue behind SECURITY.md §5. Scope: GLOBAL_REFERENCE — defined by the codebase, seeded, and never editable by a tenant (ARCHITECTURE.md §3), which is exactly the narrow case that scope is reserved for.'
    );

    table.bigIncrements('id');

    // `key` is reserved in MySQL; `permission_key` says the same thing without
    // needing every query that touches it to quote the identifier.
    table
      .string('permission_key', 100)
      .notNullable()
      .unique('permissions_permission_key_unique')
      .comment('e.g. cashiering.void_line. The stable string application code checks; renaming one is a migration, not a config change.');

    table.string('name', 150).notNullable();
    table.text('description').nullable();

    table
      .string('domain', 50)
      .notNullable()
      .comment('The SECURITY.md §5 matrix column this key belongs to: reservations, front_desk, cashiering, housekeeping, pos, reports, setup. Kept as a string rather than an enum so a new domain is a seed row, not a schema change.');

    timestamps(knex, table);

    table.index(['domain'], 'permissions_domain_index');
  });

  // ---------------------------------------------------------------------
  // role_permissions — TENANT_SCOPED (follows its role).
  // ---------------------------------------------------------------------
  await knex.schema.createTable('role_permissions', (table) => {
    table.comment(
      'Which permission keys a tenant role grants. Scope: TENANT_SCOPED — it carries tenant_id because its role does, so an authorization query stays tenant-safe like every other query.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('role_id').unsigned().notNullable();
    table.bigInteger('permission_id').unsigned().notNullable();

    timestamps(knex, table);

    table.unique(['role_id', 'permission_id'], {
      indexName: 'role_permissions_role_id_permission_id_unique',
    });

    // Composite parent key: a role_permissions row cannot claim a tenant other
    // than the one its role belongs to.
    table
      .foreign(['tenant_id', 'role_id'], 'role_permissions_tenant_id_role_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('roles')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign('permission_id', 'role_permissions_permission_id_foreign')
      .references('id')
      .inTable('permissions')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'role_id'], 'role_permissions_tenant_id_role_id_index');
  });

  // ---------------------------------------------------------------------
  // user_property_access — PROPERTY_SCOPED. The per-property role mechanism.
  // ---------------------------------------------------------------------
  await knex.schema.createTable('user_property_access', (table) => {
    table.comment(
      'Which properties a user may work at, and in what role at each. Scope: PROPERTY_SCOPED. This table is where a role lives — SECURITY.md §4: a role is never global, so the only answerable question is "does this user hold this role AT THIS PROPERTY".'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();
    table.bigInteger('user_id').unsigned().notNullable();

    // DATABASE.md §1 names this column `role`. It stays a code rather than
    // becoming a role_id, and is bound to roles(tenant_id, code) by the
    // composite foreign key below — which keeps the readable column the spec
    // asks for while making a typo, or a role borrowed from another tenant,
    // impossible to insert.
    table
      .string('role', 50)
      .notNullable()
      .comment('Role code held at THIS property, from roles.code. A user with manager here and front_desk elsewhere is normal (SECURITY.md §4).');

    timestamps(knex, table);

    // UNIQUE(user_id, property_id) — DATABASE.md §2. One role per user per
    // property: the pair resolves to exactly one role, so an authorization
    // check can never find two answers and pick the more permissive one.
    table.unique(['user_id', 'property_id'], {
      indexName: 'user_property_access_user_id_property_id_unique',
    });

    // Three composite keys, each closing one cross-tenant hole that the
    // application layer would otherwise have to remember (SECURITY.md §2 —
    // isolation is architectural, not disciplinary):
    //   - the user must belong to this tenant
    //   - the property must belong to this tenant
    //   - the role must be defined by this tenant
    table
      .foreign(['tenant_id', 'user_id'], 'user_property_access_tenant_id_user_id_foreign')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(
        ['tenant_id', 'property_id'],
        'user_property_access_tenant_id_property_id_foreign'
      )
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table
      .foreign(['tenant_id', 'role'], 'user_property_access_tenant_id_role_foreign')
      .references(['tenant_id', 'code'])
      .inTable('roles')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    // The login lookup: every property this user may act at, with its role
    // (SECURITY.md §3 — the authorized set is fetched at login and re-verified
    // on every property-scoped request, TESTING.md ISO-6).
    table.index(['tenant_id', 'user_id'], 'user_property_access_tenant_id_user_id_index');
    // The reverse lookup: who holds a given role at a given property.
    table.index(
      ['tenant_id', 'property_id', 'role'],
      'user_property_access_tenant_id_property_id_role_index'
    );
  });

  // ---------------------------------------------------------------------
  // platform_users — PLATFORM_SCOPED. No tenant_id, by design.
  // ---------------------------------------------------------------------
  await knex.schema.createTable('platform_users', (table) => {
    table.comment(
      'Planmsys staff. Scope: PLATFORM_SCOPED — deliberately NO tenant_id (DATABASE.md §1). Tenant data is reachable only through an active, audited impersonation grant (SECURITY.md §2); without one, a platform token reads nothing (TESTING.md AUTH-13).'
    );

    table.bigIncrements('id');

    // UNIQUE(email) — DATABASE.md §2. Global, not per tenant: there is no
    // tenant to scope it by, which is the whole distinction from `users`.
    table.string('email', 255).notNullable().unique('platform_users_email_unique');

    table.string('password_hash', 255).notNullable();
    table.string('first_name', 100).notNullable();
    table.string('last_name', 100).notNullable();

    // Not nullable and not defaulted to false, unlike `users.mfa_enabled`:
    // "no long-lived tokens for privileged roles" (SECURITY.md §1.1) applies
    // hardest to the population that can impersonate a customer.
    table.boolean('mfa_enabled').notNullable().defaultTo(true);
    table
      .string('mfa_secret', 255)
      .nullable()
      .comment('Encrypted at rest (SECURITY.md §1.1).');

    table.enu('status', ['active', 'inactive']).notNullable().defaultTo('active');
    table.datetime('last_login_at').nullable();

    timestamps(knex, table);

    table.index(['status'], 'platform_users_status_index');
  });

  // ---------------------------------------------------------------------
  // guest_accounts — PROPERTY_SCOPED. Separate credential store.
  // ---------------------------------------------------------------------
  await knex.schema.createTable('guest_accounts', (table) => {
    table.comment(
      'Guest portal credentials. Scope: PROPERTY_SCOPED. Separate from `users` (DATABASE.md §1) so a guest session can never satisfy a PMS route — the highest-value test in PLAN.md Phase 4 and TESTING.md AUTH-12.'
    );

    table.bigIncrements('id');
    table.bigInteger('tenant_id').unsigned().notNullable();
    table.bigInteger('property_id').unsigned().notNullable();

    // Nullable, and without a foreign key for now: `guests` is the TENANT_SCOPED
    // guest identity table that arrives with guest profiles in Phase 2
    // (PLAN.md, DATABASE.md §1.1). The column exists from the start so portal
    // signup does not need a schema change to link an account to a profile; the
    // foreign key is added in the same migration that creates `guests`. Same
    // pattern as tenants.plan_id.
    table
      .bigInteger('guest_id')
      .unsigned()
      .nullable()
      .comment('The tenant-level guests row this login belongs to. FK added with the guests table in Phase 2.');

    table.string('email', 255).notNullable();
    table.string('password_hash', 255).notNullable();

    table.datetime('email_verified_at').nullable();
    table.enu('status', ['active', 'inactive']).notNullable().defaultTo('active');
    table.datetime('last_login_at').nullable();

    timestamps(knex, table);

    // UNIQUE(property_id, email) — DATABASE.md §2. Per property, not per
    // tenant: the portal is a property's front door, and the same guest booking
    // two properties of the same group holds two portal logins.
    table.unique(['property_id', 'email'], {
      indexName: 'guest_accounts_property_id_email_unique',
    });

    table
      .foreign(
        ['tenant_id', 'property_id'],
        'guest_accounts_tenant_id_property_id_foreign'
      )
      .references(['tenant_id', 'id'])
      .inTable('properties')
      .onDelete(RESTRICT.onDelete)
      .onUpdate(RESTRICT.onUpdate);

    table.index(['tenant_id', 'property_id'], 'guest_accounts_tenant_id_property_id_index');
    table.index(['tenant_id', 'guest_id'], 'guest_accounts_tenant_id_guest_id_index');
  });
};

exports.down = async function down(knex) {
  // Reverse dependency order: children before the tables they reference.
  await knex.schema.dropTableIfExists('guest_accounts');
  await knex.schema.dropTableIfExists('platform_users');
  await knex.schema.dropTableIfExists('user_property_access');
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('permissions');
  await knex.schema.dropTableIfExists('roles');
  await knex.schema.dropTableIfExists('users');

  // Last: nothing references properties(tenant_id, id) any more.
  await knex.schema.alterTable('properties', (table) => {
    table.dropUnique(['tenant_id', 'id'], 'properties_tenant_id_id_unique');
  });
};
