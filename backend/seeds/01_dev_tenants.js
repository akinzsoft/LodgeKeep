'use strict';

/**
 * DEV-ONLY seed data — two example tenants (the same `alpha-hotels` /
 * `beta-resorts` slugs `tests/helpers/fixtures.js` uses, per
 * PRODUCT_REQUIREMENTS.md §1: no single reference customer for this SaaS),
 * each with one property and one staff user, so PLAN.md's Phase 0 exit line
 * ("a user can log in, see an empty shell scoped to their tenant") can be
 * exercised through a real browser against a real backend rather than only
 * against test fixtures inside a rolled-back transaction.
 *
 * The seeded user holds `manager`, not `admin`, deliberately: `admin` and
 * `super_admin` are the two roles PRODUCT_REQUIREMENTS.md §3.16 makes MFA
 * mandatory for regardless of the account's own setting
 * (`src/auth/roles.js`'s `roleRequiresMfa`), and MFA verification is a fixed
 * `501 AUTH_MFA_NOT_IMPLEMENTED` stub (`src/auth/errors.js`) — an `admin`
 * account seeded here could never get past the MFA challenge and complete a
 * login at all. `manager` is the highest role that does not force that path,
 * so it is the one that actually satisfies "a user can log in."
 *
 * NEVER FOR PRODUCTION. Refuses outright when NODE_ENV === 'production' —
 * the same guard shape knexfile.js's test-database-name check uses. The
 * password below is a fixed, publicly-known value; it is safe only because
 * it is unreachable outside a local docker-compose stack.
 *
 * Idempotent by tenant slug: `npm run seed` a second time skips any tenant
 * that already exists rather than inserting duplicates. It does not attempt
 * to delete and recreate, because every table this seed writes to is
 * RESTRICT-only (ARCHITECTURE.md §1) — safe re-seeding means "do nothing if
 * it's already there," not "tear down and rebuild."
 */

const { hashPassword } = require('../src/auth/password');

const DEV_PASSWORD = 'LodgeKeepDev123!';

/** SECURITY.md §5's seven system roles, seeded per tenant like fixtures.js does. */
const SYSTEM_ROLES = ['front_desk', 'cashier', 'housekeeping', 'pos_operator', 'manager', 'admin', 'super_admin'];

const TENANTS = [
  {
    slug: 'alpha-hotels',
    name: 'Alpha Hotels',
    property: {
      slug: 'alpha-hotels-main',
      name: 'Alpha Hotels — Main Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    },
    staffUser: { email: 'manager@alpha-hotels.example.com', first_name: 'Alpha', last_name: 'Manager' },
  },
  {
    slug: 'beta-resorts',
    name: 'Beta Resorts',
    property: {
      slug: 'beta-resorts-main',
      name: 'Beta Resorts — Main Property',
      timezone: 'Europe/London',
      base_currency: 'GBP',
    },
    staffUser: { email: 'manager@beta-resorts.example.com', first_name: 'Beta', last_name: 'Manager' },
  },
];

exports.seed = async function seed(knex) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run dev seed data against NODE_ENV=production.');
  }

  const passwordHash = await hashPassword(DEV_PASSWORD);
  const ready = [];

  const setupViewPermission = await knex('permissions').where({ permission_key: 'setup.view' }).first('id');

  /** Idempotent backfill, run for both a just-created and an already-existing tenant — see this function's call sites below. */
  async function ensureManagerSetupView(tenantId) {
    if (!setupViewPermission) return; // migration not yet run — nothing to grant
    const managerRole = await knex('roles').where({ tenant_id: tenantId, code: 'manager' }).first('id');
    if (!managerRole) return;
    const existingGrant = await knex('role_permissions')
      .where({ tenant_id: tenantId, role_id: managerRole.id, permission_id: setupViewPermission.id })
      .first('id');
    if (existingGrant) return;
    await knex('role_permissions').insert({
      tenant_id: tenantId,
      role_id: managerRole.id,
      permission_id: setupViewPermission.id,
    });
  }

  /**
   * PLAN.md Phase 2's reservations module: manager gets full (not
   * read-only) access to both Reservations and Front Desk, per
   * SECURITY.md §5's matrix and this session's confirmed fixture grant
   * plan — unlike Setup, where manager is deliberately view-only. Same
   * idempotent-backfill shape as `ensureManagerSetupView` above, run for
   * both a just-created and an already-existing dev tenant.
   */
  async function ensureManagerReservationsAccess(tenantId) {
    const keys = ['reservations.view', 'reservations.manage', 'front_desk.view', 'front_desk.manage'];
    const permissions = await knex('permissions').whereIn('permission_key', keys).select('id', 'permission_key');
    if (permissions.length !== keys.length) return; // migration not yet run — nothing to grant
    const managerRole = await knex('roles').where({ tenant_id: tenantId, code: 'manager' }).first('id');
    if (!managerRole) return;

    const existingGrants = await knex('role_permissions')
      .where({ tenant_id: tenantId, role_id: managerRole.id })
      .whereIn('permission_id', permissions.map((p) => p.id))
      .select('permission_id');
    const alreadyGranted = new Set(existingGrants.map((g) => String(g.permission_id)));

    const toGrant = permissions.filter((p) => !alreadyGranted.has(String(p.id)));
    if (toGrant.length) {
      await knex('role_permissions').insert(
        toGrant.map((p) => ({ tenant_id: tenantId, role_id: managerRole.id, permission_id: p.id }))
      );
    }
  }

  /**
   * PLAN.md Phase 3: Housekeeping, Notifications, and Reports each grant
   * `manager` full/near-full access per SECURITY.md §5's matrix (Reports:
   * full; Housekeeping: full; Notifications: read-only, matching Setup's
   * own admin-configuration shape — see the notifications permissions
   * migration's own header). Same idempotent-backfill shape as the two
   * functions above, one call covering all five keys at once.
   */
  async function ensureManagerPhase3Access(tenantId) {
    const keys = ['housekeeping.view', 'housekeeping.manage', 'notifications.view', 'reports.view', 'reports.view_financial'];
    const permissions = await knex('permissions').whereIn('permission_key', keys).select('id', 'permission_key');
    if (permissions.length !== keys.length) return; // migrations not yet run — nothing to grant
    const managerRole = await knex('roles').where({ tenant_id: tenantId, code: 'manager' }).first('id');
    if (!managerRole) return;

    const existingGrants = await knex('role_permissions')
      .where({ tenant_id: tenantId, role_id: managerRole.id })
      .whereIn('permission_id', permissions.map((p) => p.id))
      .select('permission_id');
    const alreadyGranted = new Set(existingGrants.map((g) => String(g.permission_id)));

    const toGrant = permissions.filter((p) => !alreadyGranted.has(String(p.id)));
    if (toGrant.length) {
      await knex('role_permissions').insert(
        toGrant.map((p) => ({ tenant_id: tenantId, role_id: managerRole.id, permission_id: p.id }))
      );
    }
  }

  /**
   * PLAN.md Phase 2.5: Cashiering and Night Audit. `manager` gets full
   * Cashiering access (`cashiering.post_charge` + `.void_line`, SECURITY.md
   * §5's matrix) and both Night Audit keys (this session's confirmed
   * decision — closing a business date is manager-level). Same idempotent-
   * backfill shape as the functions above.
   */
  async function ensureManagerPhase25Access(tenantId) {
    const keys = ['cashiering.post_charge', 'cashiering.void_line', 'night_audit.view', 'night_audit.run'];
    const permissions = await knex('permissions').whereIn('permission_key', keys).select('id', 'permission_key');
    if (permissions.length !== keys.length) return; // migrations not yet run — nothing to grant
    const managerRole = await knex('roles').where({ tenant_id: tenantId, code: 'manager' }).first('id');
    if (!managerRole) return;

    const existingGrants = await knex('role_permissions')
      .where({ tenant_id: tenantId, role_id: managerRole.id })
      .whereIn('permission_id', permissions.map((p) => p.id))
      .select('permission_id');
    const alreadyGranted = new Set(existingGrants.map((g) => String(g.permission_id)));

    const toGrant = permissions.filter((p) => !alreadyGranted.has(String(p.id)));
    if (toGrant.length) {
      await knex('role_permissions').insert(
        toGrant.map((p) => ({ tenant_id: tenantId, role_id: managerRole.id, permission_id: p.id }))
      );
    }
  }

  for (const spec of TENANTS) {
    const existingTenant = await knex('tenants').where({ slug: spec.slug }).first('id');
    if (existingTenant) {
      console.log(`[seed] tenant "${spec.slug}" already exists — skipping.`);
      // PLAN.md Phase 1's setup module landed after this tenant did — still
      // backfill the grant so a pre-existing dev tenant gets it too, the
      // same "do nothing if it's already there" idempotence this whole
      // script follows, just for one row instead of the whole tenant.
      await ensureManagerSetupView(existingTenant.id);
      await ensureManagerReservationsAccess(existingTenant.id);
      await ensureManagerPhase3Access(existingTenant.id);
      await ensureManagerPhase25Access(existingTenant.id);
      ready.push({ slug: spec.slug, email: spec.staffUser.email, alreadyExisted: true });
      continue;
    }

    const [tenantId] = await knex('tenants').insert({ name: spec.name, slug: spec.slug, status: 'active' });

    const [propertyId] = await knex('properties').insert({
      tenant_id: tenantId,
      slug: spec.property.slug,
      name: spec.property.name,
      timezone: spec.property.timezone,
      base_currency: spec.property.base_currency,
      status: 'active',
    });

    for (const code of SYSTEM_ROLES) {
      await knex('roles').insert({
        tenant_id: tenantId,
        code,
        name: code.replace(/_/g, ' '),
        is_system: true,
        status: 'active',
      });
    }
    const [userId] = await knex('users').insert({
      tenant_id: tenantId,
      email: spec.staffUser.email,
      password_hash: passwordHash,
      first_name: spec.staffUser.first_name,
      last_name: spec.staffUser.last_name,
      status: 'active',
    });

    // `role` is the role CODE, not roles.id — user_property_access binds to
    // roles(tenant_id, code) by composite foreign key (see that migration's
    // header), so the seeded "manager" row above is what this references.
    // See the file header for why this is "manager" and not "admin".
    await knex('user_property_access').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      user_id: userId,
      role: 'manager',
    });

    // PLAN.md Phase 1's setup module: 20260905095000_seed_setup_permissions.js
    // seeds the real `setup.view`/`setup.manage` catalogue rows (once,
    // globally), but grants are per tenant — granted here so the dev-seeded
    // account can actually exercise the Setup screens live, matching this
    // session's confirmed decision (Manager: read-only Setup access) and the
    // same grant `tests/helpers/fixtures.js` gives its own fixture tenants.
    await ensureManagerSetupView(tenantId);

    // PLAN.md Phase 2's reservations module: manager gets full access here
    // (see `ensureManagerReservationsAccess`'s own header for why this
    // differs from Setup's view-only grant), so the dev-seeded account can
    // exercise Reservations and Front Desk live too.
    await ensureManagerReservationsAccess(tenantId);

    // PLAN.md Phase 3's Housekeeping/Notifications/Reports modules.
    await ensureManagerPhase3Access(tenantId);

    // PLAN.md Phase 2.5's Cashiering/Night Audit modules.
    await ensureManagerPhase25Access(tenantId);

    ready.push({ slug: spec.slug, email: spec.staffUser.email, alreadyExisted: false });
  }

  console.log('\n[seed] Dev login — never valid outside a local docker-compose stack:');
  for (const row of ready) {
    console.log(`  tenant=${row.slug}  email=${row.email}  password=${DEV_PASSWORD}${row.alreadyExisted ? '  (already seeded)' : ''}`);
  }
  console.log('  URL: http://<tenant-slug>.localhost:5173  (e.g. http://alpha-hotels.localhost:5173, with the backend running and APP_DOMAIN=localhost)\n');
};
