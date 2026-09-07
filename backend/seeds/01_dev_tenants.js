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
 * The primary seeded user holds `manager`, not `admin`, deliberately:
 * `admin` and `super_admin` are the two roles PRODUCT_REQUIREMENTS.md §3.16
 * makes MFA mandatory for regardless of the account's own setting
 * (`src/auth/roles.js`'s `roleRequiresMfa`), and MFA verification is a fixed
 * `501 AUTH_MFA_NOT_IMPLEMENTED` stub (`src/auth/errors.js`) — an `admin`
 * account seeded here could never get past the MFA challenge and complete a
 * login at all. `manager` is the highest role that does not force that path,
 * so it is the one that actually satisfies "a user can log in."
 *
 * A second `admin` user is also seeded per tenant (not by promoting the
 * manager above — the point is to keep `manager`'s own no-MFA path exercised
 * exactly as before). This is only completable at all because
 * `src/auth/mfa.js`'s dev-only bypass code now exists: submit
 * `DEV_MFA_BYPASS_CODE` ('000000') to the staff mfa-verify endpoint with the
 * `challengeToken` the login response returns, and — outside production
 * only — the login completes for real. Before that file existed, an admin
 * account had no way to ever finish logging in, seeded here or not.
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
    adminUser: { email: 'admin@alpha-hotels.example.com', first_name: 'Alpha', last_name: 'Admin' },
    posOperatorUser: { email: 'pos@alpha-hotels.example.com', first_name: 'Alpha', last_name: 'Bartender' },
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
    adminUser: { email: 'admin@beta-resorts.example.com', first_name: 'Beta', last_name: 'Admin' },
    posOperatorUser: { email: 'pos@beta-resorts.example.com', first_name: 'Beta', last_name: 'Bartender' },
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

  /**
   * PLAN.md Phase 4's POS core. SECURITY.md §5's matrix showed a plain "✓"
   * for `pos_operator`; this session's confirmed decision splits it the
   * same way Cashiering's own "Limited" cell already is — manager gets
   * BOTH `pos.operate` and `pos.manage` (full access, matching the
   * matrix's own manager row), `pos_operator` gets `pos.operate` only
   * (`ensurePosOperatorRoleAccess` below).
   */
  async function ensureManagerPosAccess(tenantId) {
    const keys = ['pos.operate', 'pos.manage'];
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
      await knex('role_permissions').insert(toGrant.map((p) => ({ tenant_id: tenantId, role_id: managerRole.id, permission_id: p.id })));
    }
  }

  /**
   * `pos_operator` has existed as a system role since Phase 0 but held ZERO
   * permission grants until now — invisible for the same reason
   * `admin`/`super_admin` were before the MFA cross-cutting fix: no POS
   * screen existed to notice. `pos.operate` only, never `pos.manage` — see
   * `ensureManagerPosAccess`'s own header for the RBAC split.
   */
  async function ensurePosOperatorRoleAccess(tenantId) {
    const permission = await knex('permissions').where({ permission_key: 'pos.operate' }).first('id');
    if (!permission) return; // migrations not yet run — nothing to grant
    const posOperatorRole = await knex('roles').where({ tenant_id: tenantId, code: 'pos_operator' }).first('id');
    if (!posOperatorRole) return;

    const existing = await knex('role_permissions')
      .where({ tenant_id: tenantId, role_id: posOperatorRole.id, permission_id: permission.id })
      .first('id');
    if (!existing) {
      await knex('role_permissions').insert({ tenant_id: tenantId, role_id: posOperatorRole.id, permission_id: permission.id });
    }
  }

  /**
   * The third seeded user per tenant (alongside the manager and admin
   * accounts above) — `pos_operator` role, no MFA (not admin/super_admin),
   * so this account's login needs no dev bypass at all — a real login
   * completes the same way the seeded manager's own always has.
   */
  async function ensurePosOperatorAccount(tenantId, propertyId, spec) {
    if (!spec.posOperatorUser) return;
    let posUserId = (await knex('users').where({ tenant_id: tenantId, email: spec.posOperatorUser.email }).first('id'))?.id;
    if (!posUserId) {
      [posUserId] = await knex('users').insert({
        tenant_id: tenantId,
        email: spec.posOperatorUser.email,
        password_hash: passwordHash,
        first_name: spec.posOperatorUser.first_name,
        last_name: spec.posOperatorUser.last_name,
        status: 'active',
      });
    }
    const existingAccess = await knex('user_property_access')
      .where({ tenant_id: tenantId, property_id: propertyId, user_id: posUserId })
      .first('id');
    if (!existingAccess) {
      await knex('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: posUserId, role: 'pos_operator' });
    }
  }

  /**
   * PLAN.md Phase 4: a real bar outlet, terminal, and two menu items per
   * dev tenant — insert-if-missing by code, the same idempotent shape
   * `ensureReferenceData` already uses.
   */
  async function ensurePosReferenceData(tenantId, propertyId) {
    let outletId = (await knex('pos_outlets').where({ tenant_id: tenantId, property_id: propertyId, code: 'BAR' }).first('id'))?.id;
    if (!outletId) {
      [outletId] = await knex('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'BAR', name: 'Main Bar', type: 'bar' });
    }

    const existingTerminal = await knex('pos_terminals')
      .where({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, device_ref: 'BAR-TERMINAL-1' })
      .first('id');
    if (!existingTerminal) {
      await knex('pos_terminals').insert({
        tenant_id: tenantId,
        property_id: propertyId,
        outlet_id: outletId,
        device_ref: 'BAR-TERMINAL-1',
        supports_contactless: true,
      });
    }

    const menuItems = [
      { name: 'House Cocktail', category: 'Cocktails', price: '20.00' },
      { name: 'Bottled Water', category: 'Soft Drinks', price: '3.00' },
    ];
    for (const item of menuItems) {
      const existingItem = await knex('pos_menu_items')
        .where({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, name: item.name })
        .first('id');
      if (!existingItem) {
        await knex('pos_menu_items').insert({ tenant_id: tenantId, property_id: propertyId, outlet_id: outletId, ...item });
      }
    }
  }

  /**
   * SECURITY.md §5's matrix gives `admin`/`super_admin` "✓" (full access)
   * on every single domain — every permission key that exists, not a
   * per-module list this function would need to keep in sync as each new
   * module lands. That's a deliberate difference from
   * `tests/helpers/fixtures.js`'s own per-key grant plan, which needs that
   * finer granularity to construct partial-access test scenarios; a dev
   * seed account has no such need — it exists so a human can exercise
   * every admin-only screen, which is exactly what the matrix's "✓" means.
   * Without this, both roles existed in `roles` but held zero grants —
   * invisible until now because no admin account could ever log in to
   * notice (see file header). Idempotent the same way every other grant
   * function here is.
   */
  async function ensureAdminSuperAdminFullAccess(tenantId) {
    const allPermissions = await knex('permissions').select('id');
    if (!allPermissions.length) return; // no permission catalogue seeded yet
    const roles = await knex('roles').where({ tenant_id: tenantId }).whereIn('code', ['admin', 'super_admin']).select('id');
    for (const role of roles) {
      const existingGrants = await knex('role_permissions').where({ tenant_id: tenantId, role_id: role.id }).select('permission_id');
      const alreadyGranted = new Set(existingGrants.map((g) => String(g.permission_id)));
      const toGrant = allPermissions.filter((p) => !alreadyGranted.has(String(p.id)));
      if (toGrant.length) {
        await knex('role_permissions').insert(toGrant.map((p) => ({ tenant_id: tenantId, role_id: role.id, permission_id: p.id })));
      }
    }
  }

  /**
   * The second seeded user (see file header) — `admin` role, only
   * completable through login via `src/auth/mfa.js`'s dev-only bypass code.
   * Idempotent the same way the primary staff user's own insert is: a
   * second `npm run seed` run must not duplicate this user or its access
   * row, so both are looked up before being inserted.
   */
  async function ensureAdminAccount(tenantId, propertyId, spec) {
    let adminUserId = (await knex('users').where({ tenant_id: tenantId, email: spec.adminUser.email }).first('id'))?.id;
    if (!adminUserId) {
      [adminUserId] = await knex('users').insert({
        tenant_id: tenantId,
        email: spec.adminUser.email,
        password_hash: passwordHash,
        first_name: spec.adminUser.first_name,
        last_name: spec.adminUser.last_name,
        status: 'active',
      });
    }
    const existingAccess = await knex('user_property_access')
      .where({ tenant_id: tenantId, property_id: propertyId, user_id: adminUserId })
      .first('id');
    if (!existingAccess) {
      await knex('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: adminUserId, role: 'admin' });
    }
  }

  /**
   * PLAN.md Phase 1 gap closure: market segments, booking sources, and a
   * cancellation policy, all previously deferred (see the migrations that
   * created these three tables). Insert-if-missing by `code`, the same
   * idempotent shape as every other `ensure*` helper in this file — a
   * second `npm run seed` run must not duplicate these rows either.
   */
  async function ensureReferenceData(tenantId, propertyId) {
    const referenceRows = [
      { table: 'market_segments', code: 'LEISURE', name: 'Leisure' },
      { table: 'market_segments', code: 'CORP', name: 'Corporate' },
      { table: 'booking_sources', code: 'DIRECT', name: 'Direct' },
      { table: 'booking_sources', code: 'OTA', name: 'OTA' },
    ];
    for (const row of referenceRows) {
      const existing = await knex(row.table).where({ tenant_id: tenantId, property_id: propertyId, code: row.code }).first('id');
      if (!existing) {
        await knex(row.table).insert({ tenant_id: tenantId, property_id: propertyId, code: row.code, name: row.name });
      }
    }
    const existingPolicy = await knex('cancellation_policies')
      .where({ tenant_id: tenantId, property_id: propertyId, code: 'STANDARD' })
      .first('id');
    if (!existingPolicy) {
      await knex('cancellation_policies').insert({
        tenant_id: tenantId,
        property_id: propertyId,
        code: 'STANDARD',
        name: 'Standard',
        cutoff_hours: 24,
        fee_type: 'first_night',
      });
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
      await ensureManagerPosAccess(existingTenant.id);
      await ensurePosOperatorRoleAccess(existingTenant.id);
      // src/auth/mfa.js's dev-only bypass: backfill the admin account and
      // its full-access grant onto a pre-existing dev tenant too, same
      // reasoning as the manager grants above.
      await ensureAdminSuperAdminFullAccess(existingTenant.id);
      const existingProperty = await knex('properties').where({ tenant_id: existingTenant.id }).first('id');
      if (existingProperty) {
        await ensureAdminAccount(existingTenant.id, existingProperty.id, spec);
        await ensurePosOperatorAccount(existingTenant.id, existingProperty.id, spec);
        await ensureReferenceData(existingTenant.id, existingProperty.id);
        await ensurePosReferenceData(existingTenant.id, existingProperty.id);
      }
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

    // The second, admin-role account and its full-access grant — see file
    // header, `ensureAdminAccount`, and `ensureAdminSuperAdminFullAccess`.
    await ensureAdminSuperAdminFullAccess(tenantId);
    await ensureAdminAccount(tenantId, propertyId, spec);

    // PLAN.md Phase 2.5's Cashiering/Night Audit modules.
    await ensureManagerPhase25Access(tenantId);

    // PLAN.md Phase 4's POS core — see `ensureManagerPosAccess`'s own header.
    await ensureManagerPosAccess(tenantId);
    await ensurePosOperatorRoleAccess(tenantId);
    await ensurePosOperatorAccount(tenantId, propertyId, spec);
    await ensurePosReferenceData(tenantId, propertyId);

    // PLAN.md Phase 1 gap closure — see `ensureReferenceData`'s own header.
    await ensureReferenceData(tenantId, propertyId);

    ready.push({ slug: spec.slug, email: spec.staffUser.email, alreadyExisted: false });
  }

  console.log('\n[seed] Dev login — never valid outside a local docker-compose stack:');
  for (const row of ready) {
    console.log(`  tenant=${row.slug}  email=${row.email}  password=${DEV_PASSWORD}${row.alreadyExisted ? '  (already seeded)' : ''}`);
  }
  console.log('  URL: http://<tenant-slug>.localhost:5173  (e.g. http://alpha-hotels.localhost:5173, with the backend running and APP_DOMAIN=localhost)\n');

  console.log('[seed] Admin (setup.manage) dev login — requires the MFA dev bypass code below:');
  for (const spec of TENANTS) {
    console.log(`  tenant=${spec.slug}  email=${spec.adminUser.email}  password=${DEV_PASSWORD}`);
  }
  console.log('  After "MFA required": submit code 000000 (src/auth/mfa.js\'s DEV_MFA_BYPASS_CODE) — never valid outside NODE_ENV!=="production".\n');

  console.log('[seed] POS operator (pos.operate) dev login — no MFA, logs in the same way the seeded manager does:');
  for (const spec of TENANTS) {
    if (!spec.posOperatorUser) continue;
    console.log(`  tenant=${spec.slug}  email=${spec.posOperatorUser.email}  password=${DEV_PASSWORD}`);
  }
  console.log('');
};
