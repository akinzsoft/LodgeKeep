'use strict';

/**
 * The isolation suite's entity table.
 *
 * TESTING.md Part 1: "Isolation tests are table-driven over a list of
 * tenant-scoped entities, so a newly added endpoint inherits every check
 * automatically and coverage cannot silently lag behind new routes."
 *
 * This is that list. Each entry declares how to build a valid row, how to build
 * one that collides with a seeded row on the constraint DATABASE.md §2 requires,
 * and how to build one that pairs the caller's tenant with another tenant's
 * parent row. The suites in `tests/isolation` iterate this array, so adding a
 * table here is what gives it isolation coverage — and `tests/isolation/
 * entity-scope.test.js` asserts every table declared in
 * `src/shared/table-scopes.js` appears here, so a new table cannot be given a
 * query path without also being given coverage.
 *
 * When routes exist, the same array feeds the HTTP-level ISO-1..ISO-8 cases:
 * the entries gain an `endpoint` field and the assertions become 404/403 rather
 * than a MySQL error code. Until then these are the database-level guarantees
 * those HTTP assertions will rest on — a route cannot leak what the schema
 * refuses to store.
 */

const { PASSWORD_HASH, tokenHash, hoursFromNow, byLabel } = require('./fixtures');

/** MySQL error codes the suite asserts on, named so a failure message reads. */
const ER = {
  DUPLICATE: 'ER_DUP_ENTRY',
  NO_PARENT: 'ER_NO_REFERENCED_ROW_2',
  STILL_REFERENCED: 'ER_ROW_IS_REFERENCED_2',
};

const ENTITIES = [
  {
    table: 'tenants',
    // Scope root: no tenant_id column, its own id is the tenant scope.
    uniqueKeys: [['slug']],
    newRow: (ctx, t) => ({ name: 'New tenant', slug: `${t.slug}-new`, status: 'active' }),
    duplicateRow: (ctx, t) => ({ name: 'Clash', slug: t.slug, status: 'active' }),
    restrictDelete: {
      name: 'a tenant that still has users, roles and properties',
      id: (ctx, t) => t.id,
    },
  },

  {
    table: 'properties',
    uniqueKeys: [['tenant_id', 'slug']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      slug: `${t.slug}-property-new`,
      name: 'New property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      slug: `${t.slug}-property-1`,
      name: 'Clashing slug',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    }),
    restrictDelete: {
      name: 'a property with staff access and guest accounts on it',
      id: (ctx, t) => t.properties[0].id,
    },
  },

  {
    table: 'users',
    uniqueKeys: [['tenant_id', 'email']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      email: `new-${t.slug}@example.com`,
      password_hash: PASSWORD_HASH,
      first_name: 'New',
      last_name: 'Staff',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      email: t.users[0].email,
      password_hash: PASSWORD_HASH,
      first_name: 'Clashing',
      last_name: 'Staff',
    }),
    restrictDelete: {
      name: 'a user who holds property access',
      id: (ctx, t) => t.users[0].id,
    },
  },

  {
    table: 'roles',
    // Not in DATABASE.md §2's list, but required by §2's own instruction: a code
    // unique per tenant gets its constraint in the migration that creates it.
    uniqueKeys: [['tenant_id', 'code']],
    newRow: (ctx, t) => ({ tenant_id: t.id, code: 'auditor', name: 'Auditor' }),
    duplicateRow: (ctx, t) => ({ tenant_id: t.id, code: 'manager', name: 'Second manager' }),
    restrictDelete: {
      name: 'a role that is assigned to someone at a property',
      id: (ctx, t) => t.roles.manager,
    },
  },

  {
    table: 'permissions',
    // GLOBAL_REFERENCE: one catalogue, no tenant dimension to scope by.
    uniqueKeys: [['permission_key']],
    newRow: () => ({ permission_key: 'reports.export', name: 'Export reports', domain: 'reports' }),
    duplicateRow: () => ({
      permission_key: 'cashiering.void_line',
      name: 'Clashing key',
      domain: 'cashiering',
    }),
    restrictDelete: {
      name: 'a permission that a role still grants',
      id: (ctx) => ctx.permissions['cashiering.void_line'],
    },
  },

  {
    table: 'role_permissions',
    uniqueKeys: [['role_id', 'permission_id']],
    // `newRow` uses `housekeeping`, not `manager`: PLAN.md Phase 2.5 granted
    // `manager` BOTH cashiering keys for real (SECURITY.md §5's matrix
    // gives manager full Cashiering access), so `manager` + either
    // cashiering key now already exists and would collide before ever
    // reaching the insert this case exists to prove valid. `housekeeping`
    // never holds either cashiering key (✗ in the matrix), so this
    // combination is guaranteed unused. `duplicateRow` deliberately keeps
    // the original `manager` + `cashiering.void_line` pairing — it is
    // SUPPOSED to already exist (that is what makes it a duplicate).
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      role_id: t.roles.housekeeping,
      permission_id: ctx.permissions['cashiering.post_charge'],
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      role_id: t.roles.manager,
      permission_id: ctx.permissions['cashiering.void_line'],
    }),
    crossTenant: [
      {
        name: "grants a permission through another tenant's role",
        // `setup.manage`, not `reports.view_financial`: PLAN.md Phase 3
        // granted `manager` role_id `reports.view_financial` too (SECURITY.md
        // §5's matrix gives manager full Reports access), so that combination
        // now already exists for `other`'s own manager role and would collide
        // on UNIQUE(role_id, permission_id) before ever reaching the FK check
        // this case exists to prove. `setup.manage` stays admin/super_admin
        // only — manager never holds it — so this combination is guaranteed
        // not to already exist.
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          role_id: other.roles.manager,
          permission_id: ctx.permissions['setup.manage'],
        }),
      },
    ],
  },

  {
    table: 'user_property_access',
    uniqueKeys: [['user_id', 'property_id']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[1].id,
      user_id: t.users[1].id,
      role: 'cashier',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      // Already manager here. A second row would make the (user, property)
      // pair resolve to two roles, and an authorization check would have to
      // choose — so the constraint, not the code, decides there is one answer.
      property_id: t.properties[0].id,
      user_id: t.users[0].id,
      role: 'housekeeping',
    }),
    crossTenant: [
      {
        name: "grants one of our users access to another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          user_id: own.users[1].id,
          role: 'manager',
        }),
      },
      {
        name: "grants another tenant's user access to one of our properties",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[1].id,
          user_id: other.users[1].id,
          role: 'manager',
        }),
      },
      {
        name: 'assigns a role code only the other tenant defines',
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[1].id,
          user_id: own.users[1].id,
          role: other.exclusiveRoleCode,
        }),
      },
      {
        name: "claims our own property under the other tenant's id",
        row: (ctx, own, other) => ({
          tenant_id: other.id,
          property_id: own.properties[0].id,
          user_id: other.users[1].id,
          role: 'manager',
        }),
      },
    ],
  },

  {
    table: 'guest_accounts',
    uniqueKeys: [['property_id', 'email']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      email: 'another-guest@example.com',
      password_hash: PASSWORD_HASH,
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      email: t.guestAccounts[0].email,
      password_hash: PASSWORD_HASH,
    }),
    crossTenant: [
      {
        name: "opens a guest account on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          email: 'crossing@example.com',
          password_hash: PASSWORD_HASH,
        }),
      },
    ],
  },

  // ------------------------------------------------------------------
  // Auth credentials (20260903210341_create_auth_credentials).
  //
  // The token uniques here are global rather than per-tenant, which is the one
  // place this suite asserts an unscoped constraint on a tenant-owned table. It
  // is correct for the reason that migration's header gives: a presented token
  // must resolve to at most one row, and it is looked up before the session it
  // belongs to is known.
  // ------------------------------------------------------------------
  {
    table: 'sessions',
    uniqueKeys: [['refresh_token_hash']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      user_id: t.users[0].id,
      refresh_token_hash: tokenHash(`${t.slug}-session-additional`),
      expires_at: hoursFromNow(24),
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      user_id: t.users[1].id,
      // The same digest as the live session — a second row under one token hash
      // would mean a presented refresh token resolves to two sessions, and
      // revoking one would leave the other working.
      refresh_token_hash: byLabel(t.sessions, 'live').refresh_token_hash,
      expires_at: hoursFromNow(24),
    }),
    crossTenant: [
      {
        name: "opens a session for another tenant's user",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          user_id: other.users[0].id,
          refresh_token_hash: tokenHash(`${own.slug}-session-crossing`),
          expires_at: hoursFromNow(24),
        }),
      },
      {
        name: "claims our own user's session under the other tenant's id",
        row: (ctx, own, other) => ({
          tenant_id: other.id,
          user_id: own.users[0].id,
          refresh_token_hash: tokenHash(`${own.slug}-session-crossing-mirror`),
          expires_at: hoursFromNow(24),
        }),
      },
    ],
  },

  {
    table: 'password_resets',
    uniqueKeys: [['token_hash']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      user_id: t.users[0].id,
      token_hash: tokenHash(`${t.slug}-reset-additional`),
      expires_at: hoursFromNow(1),
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      user_id: t.users[1].id,
      token_hash: byLabel(t.passwordResets, 'pending').token_hash,
      expires_at: hoursFromNow(1),
    }),
    crossTenant: [
      {
        name: "issues a reset token against another tenant's user",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          user_id: other.users[0].id,
          token_hash: tokenHash(`${own.slug}-reset-crossing`),
          expires_at: hoursFromNow(1),
        }),
      },
    ],
  },

  {
    table: 'mfa_devices',
    // Not from DATABASE.md §2's list; see the migration's note on why one
    // device per type per user is the right constraint despite the cost.
    uniqueKeys: [['tenant_id', 'user_id', 'type']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      // A second factor of a *different* type for a user who already has TOTP —
      // which the constraint permits, and must.
      user_id: t.users[0].id,
      type: 'sms',
      secret: `enc:v1:${t.slug}:additional`,
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      user_id: t.users[0].id,
      type: 'totp',
      secret: `enc:v1:${t.slug}:second-totp`,
    }),
    crossTenant: [
      {
        name: "enrols a second factor for another tenant's user",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          user_id: other.users[1].id,
          type: 'sms',
          secret: `enc:v1:${own.slug}:crossing`,
        }),
      },
    ],
  },

  {
    table: 'user_invitations',
    uniqueKeys: [['token_hash']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      email: 'invited-additional@example.com',
      role: 'housekeeping',
      token_hash: tokenHash(`${t.slug}-invite-additional`),
      expires_at: hoursFromNow(48),
      invited_by_user_id: t.users[0].id,
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      email: 'invited-clashing@example.com',
      role: 'housekeeping',
      token_hash: byLabel(t.invitations, 'pending').token_hash,
      expires_at: hoursFromNow(48),
      invited_by_user_id: t.users[0].id,
    }),
    crossTenant: [
      {
        name: "invites someone to another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          email: 'crossing@example.com',
          role: 'front_desk',
          token_hash: tokenHash(`${own.slug}-invite-crossing-property`),
          expires_at: hoursFromNow(48),
          invited_by_user_id: own.users[0].id,
        }),
      },
      {
        name: 'grants a role code only the other tenant defines',
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          email: 'crossing@example.com',
          role: other.exclusiveRoleCode,
          token_hash: tokenHash(`${own.slug}-invite-crossing-role`),
          expires_at: hoursFromNow(48),
          invited_by_user_id: own.users[0].id,
        }),
      },
      {
        name: "attributes the invitation to another tenant's user",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          email: 'crossing@example.com',
          role: 'front_desk',
          token_hash: tokenHash(`${own.slug}-invite-crossing-inviter`),
          expires_at: hoursFromNow(48),
          invited_by_user_id: other.users[0].id,
        }),
      },
    ],
  },

  {
    table: 'tenant_domains',
    uniqueKeys: [['domain']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      domain: `${t.slug}-new.example.com`,
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      domain: `${t.slug}.example.com`,
    }),
    // No crossTenant case: unlike sessions or user_invitations, this table has
    // only a single-column FK straight to `tenants.id` — there is no second
    // scoped parent for a mismatched pair to violate, so nothing here is a
    // schema-level constraint to test. The isolation guarantee this table
    // relies on is enforced at the READ side instead: `bootstrapLookup`
    // (scoped-db.js) returns the row's real tenant_id to whoever presents the
    // domain, and the caller — the auth module alone — is what must never
    // trust that value as authorization, only as which tenant to build a
    // context for next.
  },

  {
    table: 'auth_events',
    // PLATFORM_SCOPED with nullable tenant_id/property_id (attribution, not
    // scope — see table-scopes.js and the migration). Append-only, so there is
    // no natural unique key: two identical login failures a second apart are
    // two real events, not a collision. entity-scope.test.js's "declares a
    // duplicateRow case for every unique key it claims" check is what makes
    // an empty uniqueKeys list here a deliberate statement rather than an
    // oversight.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      audience: 'staff',
      event_type: 'login_success',
      tenant_id: t.id,
      user_id: t.users[0].id,
      email_attempted: t.users[0].email,
      ip: '::ffff:203.0.113.9',
    }),
    // No duplicateRow: nothing about this table is unique.
  },

  {
    table: 'audit_log',
    // Append-only, polymorphic (entity_id has no FK — see the migration
    // header), no natural unique key — the same shape as auth_events.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      entity_type: 'reservations',
      entity_id: 1,
      action: 'create',
      user_id: t.users[0].id,
      before_state: null,
      after_state: JSON.stringify({ status: 'confirmed' }),
      source: 'web',
    }),
    // No duplicateRow: nothing about this table is unique.
  },

  {
    table: 'platform_users',
    // PLATFORM_SCOPED: email is globally unique because there is no tenant to
    // scope it by — the whole distinction from `users`.
    uniqueKeys: [['email']],
    newRow: () => ({
      email: 'second-ops@planmsys.test',
      password_hash: PASSWORD_HASH,
      first_name: 'Second',
      last_name: 'Ops',
    }),
    duplicateRow: (ctx) => ({
      email: ctx.platform.email,
      password_hash: PASSWORD_HASH,
      first_name: 'Clashing',
      last_name: 'Ops',
    }),
  },

  // ------------------------------------------------------------------
  // Property setup (PLAN.md Phase 1) — 20260905090000_create_room_types.js
  // through 20260905094000_create_taxes.js. All PROPERTY_SCOPED.
  // ------------------------------------------------------------------
  {
    table: 'room_types',
    uniqueKeys: [['property_id', 'code']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'STD',
      name: 'Standard',
      default_occupancy: 2,
      base_rate: '100.00',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: t.roomTypes[0].code ?? 'DLX',
      name: 'Clashing code',
      default_occupancy: 2,
      base_rate: '100.00',
    }),
    crossTenant: [
      {
        name: "creates a room type on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          code: 'CROSS',
          name: 'Crossing',
          default_occupancy: 2,
          base_rate: '100.00',
        }),
      },
    ],
    restrictDelete: {
      name: 'a room type that a room still references',
      id: (ctx, t) => t.roomTypes[0].id,
    },
  },

  {
    table: 'rooms',
    uniqueKeys: [['property_id', 'room_number']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_number: '102',
      floor: '1',
      room_type_id: t.roomTypes[0].id,
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_number: '101',
      floor: '1',
      room_type_id: t.roomTypes[0].id,
    }),
    crossTenant: [
      {
        name: "creates a room on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          room_number: 'X1',
          floor: '1',
          room_type_id: own.roomTypes[0].id,
        }),
      },
      {
        name: "assigns a room type only the other tenant defines",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          room_number: 'X2',
          floor: '1',
          room_type_id: other.roomTypes[0].id,
        }),
      },
    ],
  },

  {
    table: 'rate_codes',
    uniqueKeys: [['property_id', 'code']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'CORP',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'BAR',
      base_rate: '100.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    }),
    crossTenant: [
      {
        name: "creates a rate code on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          code: 'CROSS',
          base_rate: '100.00',
          currency: 'NGN',
          valid_from: '2026-01-01',
        }),
      },
    ],
    restrictDelete: {
      name: 'a rate code that a rate calendar override still references',
      id: (ctx, t) => t.rateCodes[0].id,
    },
  },

  {
    table: 'rate_calendar',
    uniqueKeys: [['rate_code_id', 'room_type_id', 'stay_date']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      rate_code_id: t.rateCodes[0].id,
      room_type_id: t.roomTypes[0].id,
      stay_date: '2026-12-25',
      rate: '200.00',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      rate_code_id: t.rateCodes[0].id,
      room_type_id: t.roomTypes[0].id,
      stay_date: '2026-12-24',
      rate: '999.00',
    }),
    crossTenant: [
      {
        name: "overrides a rate for another tenant's rate code",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          rate_code_id: other.rateCodes[0].id,
          room_type_id: own.roomTypes[0].id,
          stay_date: '2026-12-26',
          rate: '200.00',
        }),
      },
      {
        name: "overrides a rate for another tenant's room type",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          rate_code_id: own.rateCodes[0].id,
          room_type_id: other.roomTypes[0].id,
          stay_date: '2026-12-27',
          rate: '200.00',
        }),
      },
    ],
  },

  {
    table: 'market_segments',
    uniqueKeys: [['property_id', 'code']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'CORP',
      name: 'Corporate',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: t.marketSegments[0].code ?? 'LEISURE', // matches seedTwoTenants' own fixture row
      name: 'Clashing code',
    }),
    crossTenant: [
      {
        name: "creates a market segment on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          code: 'CROSS',
          name: 'Crossing',
        }),
      },
    ],
  },

  {
    table: 'booking_sources',
    uniqueKeys: [['property_id', 'code']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'DIRECT',
      name: 'Direct',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: t.bookingSources[0].code ?? 'OTA', // matches seedTwoTenants' own fixture row
      name: 'Clashing code',
    }),
    crossTenant: [
      {
        name: "creates a booking source on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          code: 'CROSS',
          name: 'Crossing',
        }),
      },
    ],
  },

  {
    table: 'cancellation_policies',
    uniqueKeys: [['property_id', 'code']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'FLEX',
      name: 'Flexible',
      fee_type: 'none',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: t.cancellationPolicies[0].code ?? 'STANDARD', // matches seedTwoTenants' own fixture row
      name: 'Clashing code',
      fee_type: 'first_night',
    }),
    crossTenant: [
      {
        name: "creates a cancellation policy on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          code: 'CROSS',
          name: 'Crossing',
          fee_type: 'none',
        }),
      },
    ],
  },

  {
    table: 'taxes',
    // Effective-dated: uniqueness is (property, code, start-date), not
    // (property, code) — multiple versions of one tax_code legitimately
    // coexist over time (see the migration's own header).
    uniqueKeys: [['property_id', 'tax_code', 'effective_from']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      tax_code: 'TOURISM',
      name: 'Tourism levy',
      rate: '2.5000',
      effective_from: '2026-01-01',
      is_inclusive: false,
      calculation_method: 'percentage',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      tax_code: 'VAT',
      name: 'Clashing version',
      rate: '9.9999',
      effective_from: '2026-01-01',
      is_inclusive: false,
      calculation_method: 'percentage',
    }),
    crossTenant: [
      {
        name: "configures a tax on another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          tax_code: 'CROSS',
          name: 'Crossing',
          rate: '1.0000',
          effective_from: '2026-01-01',
          is_inclusive: false,
          calculation_method: 'percentage',
        }),
      },
    ],
  },

  // ------------------------------------------------------------------
  // Idempotency infra (PLAN.md Phase 2) — 20260906090000_create_idempotency_keys.
  // TENANT_SCOPED, no property dimension (ARCHITECTURE.md §7).
  // ------------------------------------------------------------------
  {
    table: 'idempotency_keys',
    uniqueKeys: [['tenant_id', 'operation_type', 'key_value']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      operation_type: 'reservations.create',
      key_value: `${t.slug}-additional`,
      request_hash: 'a'.repeat(64),
      response_status: 201,
      response_body: JSON.stringify({ data: { id: '1' } }),
      expires_at: hoursFromNow(24),
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      operation_type: t.idempotencyKeys[0].operation_type,
      key_value: t.idempotencyKeys[0].key_value,
      request_hash: 'b'.repeat(64),
      response_status: 201,
      response_body: JSON.stringify({ data: { id: '2' } }),
      expires_at: hoursFromNow(24),
    }),
    // No crossTenant case: like `tenant_domains`, this table has only a
    // single-column FK straight to `tenants.id` — there is no second scoped
    // parent for a mismatched pair to violate (see that table's own note
    // just above in this file for the identical reasoning).
  },

  // ------------------------------------------------------------------
  // Reservations & front desk (PLAN.md Phase 2) —
  // 20260906091000_create_guests through 20260906097000_create_folios.
  // ------------------------------------------------------------------
  {
    table: 'guests',
    // TENANT_SCOPED, no unique constraint — see the migration's own header
    // for why (two guests may legitimately share an email or phone).
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      first_name: 'New',
      last_name: 'Guest',
      email: `new-guest-${t.slug}@example.com`,
      phone: '+10000000001',
    }),
    // No duplicateRow: nothing about this table is unique.
    restrictDelete: {
      name: 'a guest that a reservation still references',
      id: (ctx, t) => t.guests[0].id,
    },
  },

  {
    table: 'room_type_inventory',
    uniqueKeys: [['property_id', 'room_type_id', 'stay_date']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_type_id: t.roomTypes[0].id,
      stay_date: '2026-12-31',
      rooms_sold: 0,
      overbooking_threshold_pct: '100.00',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_type_id: t.roomTypes[0].id,
      stay_date: '2026-12-24',
      rooms_sold: 0,
      overbooking_threshold_pct: '100.00',
    }),
    crossTenant: [
      {
        name: "creates an inventory row for another tenant's room type",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          room_type_id: other.roomTypes[0].id,
          stay_date: '2026-12-30',
          rooms_sold: 0,
          overbooking_threshold_pct: '100.00',
        }),
      },
    ],
  },

  {
    table: 'reservations',
    uniqueKeys: [['tenant_id', 'confirmation_number']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      guest_id: t.guests[0].id,
      room_type_id: t.roomTypes[0].id,
      rate_code_id: t.rateCodes[0].id,
      arrival_date: '2027-01-10',
      departure_date: '2027-01-12',
      adults: 1,
      children: 0,
      status: 'confirmed',
      confirmation_number: `NEW-${t.slug}`.toUpperCase().slice(0, 26),
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      guest_id: t.guests[0].id,
      room_type_id: t.roomTypes[0].id,
      rate_code_id: t.rateCodes[0].id,
      arrival_date: '2027-02-10',
      departure_date: '2027-02-12',
      adults: 1,
      children: 0,
      status: 'confirmed',
      confirmation_number: t.reservations[0].confirmation_number ?? `FIXTURE-${t.slug}`.toUpperCase().slice(0, 26),
    }),
    crossTenant: [
      {
        name: "books another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          guest_id: own.guests[0].id,
          room_type_id: own.roomTypes[0].id,
          rate_code_id: own.rateCodes[0].id,
          arrival_date: '2027-03-01',
          departure_date: '2027-03-03',
          status: 'confirmed',
          confirmation_number: `CROSS1-${own.slug}`.toUpperCase().slice(0, 26),
        }),
      },
      {
        name: "books another tenant's guest",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          guest_id: other.guests[0].id,
          room_type_id: own.roomTypes[0].id,
          rate_code_id: own.rateCodes[0].id,
          arrival_date: '2027-03-05',
          departure_date: '2027-03-07',
          status: 'confirmed',
          confirmation_number: `CROSS2-${own.slug}`.toUpperCase().slice(0, 26),
        }),
      },
      {
        name: "books another tenant's room type",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          guest_id: own.guests[0].id,
          room_type_id: other.roomTypes[0].id,
          rate_code_id: own.rateCodes[0].id,
          arrival_date: '2027-03-09',
          departure_date: '2027-03-11',
          status: 'confirmed',
          confirmation_number: `CROSS3-${own.slug}`.toUpperCase().slice(0, 26),
        }),
      },
      {
        name: "books another tenant's rate code",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          guest_id: own.guests[0].id,
          room_type_id: own.roomTypes[0].id,
          rate_code_id: other.rateCodes[0].id,
          arrival_date: '2027-03-13',
          departure_date: '2027-03-15',
          status: 'confirmed',
          confirmation_number: `CROSS4-${own.slug}`.toUpperCase().slice(0, 26),
        }),
      },
    ],
    restrictDelete: {
      name: 'a reservation that daily rates, room assignments, notes and a folio still reference',
      id: (ctx, t) => t.reservations[0].id,
    },
  },

  {
    table: 'reservation_rooms',
    // No natural unique key: a room can legitimately gain a second
    // assignment row once the first is closed (a room move) — uniqueness
    // isn't declared at the schema level, so isolation coverage here is
    // FK-based only (crossTenant), matching auth_events'/audit_log's shape.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      reservation_id: t.reservations[0].id,
      room_id: t.rooms[0].id,
      effective_from: hoursFromNow(-1),
      effective_to: null,
    }),
    crossTenant: [
      {
        name: "assigns another tenant's room to our reservation",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          reservation_id: own.reservations[0].id,
          room_id: other.rooms[0].id,
          effective_from: hoursFromNow(-1),
          effective_to: null,
        }),
      },
      {
        name: "assigns a room to another tenant's reservation",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          reservation_id: other.reservations[0].id,
          room_id: own.rooms[0].id,
          effective_from: hoursFromNow(-1),
          effective_to: null,
        }),
      },
    ],
  },

  {
    table: 'reservation_daily_rates',
    uniqueKeys: [['reservation_id', 'stay_date']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      reservation_id: t.reservations[0].id,
      stay_date: '2026-12-26',
      rate: '150.00',
      currency: 'NGN',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      reservation_id: t.reservations[0].id,
      stay_date: '2026-12-24',
      rate: '999.00',
      currency: 'NGN',
    }),
    crossTenant: [
      {
        name: "adds a nightly rate to another tenant's reservation",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          reservation_id: other.reservations[0].id,
          stay_date: '2026-12-27',
          rate: '150.00',
          currency: 'NGN',
        }),
      },
    ],
  },

  {
    table: 'reservation_notes',
    // Append-only, same shape as audit_log/auth_events — no natural unique key.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      reservation_id: t.reservations[0].id,
      user_id: t.users[0].id,
      note: 'A new note.',
    }),
    crossTenant: [
      {
        name: "adds a note to another tenant's reservation",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          reservation_id: other.reservations[0].id,
          user_id: own.users[0].id,
          note: 'Crossing note.',
        }),
      },
      {
        name: "attributes a note to another tenant's user",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          reservation_id: own.reservations[0].id,
          user_id: other.users[0].id,
          note: 'Crossing note.',
        }),
      },
    ],
  },

  {
    table: 'folios',
    uniqueKeys: [['reservation_id', 'folio_number']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      reservation_id: t.reservations[0].id,
      folio_number: `NEWFOLIO-${t.slug}`.toUpperCase().slice(0, 26),
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      reservation_id: t.reservations[0].id,
      folio_number: t.folios[0].folio_number ?? `FIXTUREFOLIO-${t.slug}`.toUpperCase().slice(0, 26),
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
    }),
    crossTenant: [
      {
        name: "opens a folio on another tenant's reservation",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          reservation_id: other.reservations[0].id,
          folio_number: `CROSSFOLIO-${own.slug}`.toUpperCase().slice(0, 26),
          status: 'open',
          balance: '0.00',
          currency: 'NGN',
        }),
      },
    ],
  },

  // -----------------------------------------------------------------------
  // Housekeeping — PLAN.md Phase 3
  // -----------------------------------------------------------------------

  {
    table: 'out_of_order_periods',
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_id: t.rooms[0].id,
      type: 'ooo',
      reason: 'Plumbing repair',
      start_date: '2026-12-01',
      end_date: '2026-12-03',
      created_by_user_id: t.users[0].id,
    }),
    crossTenant: [
      {
        name: "schedules an OOO period against another tenant's room",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          room_id: other.rooms[0].id,
          type: 'ooo',
          reason: 'Cross-tenant attempt',
          start_date: '2026-12-01',
          end_date: '2026-12-03',
          created_by_user_id: own.users[0].id,
        }),
      },
    ],
  },

  {
    table: 'housekeeping_assignments',
    uniqueKeys: [['property_id', 'room_id', 'business_date']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_id: t.rooms[0].id,
      attendant_user_id: t.users[0].id,
      business_date: '2026-12-05',
      status: 'assigned',
    }),
    // Collides with the fixture row seeded in seedTwoTenants (same
    // property/room/business_date).
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_id: t.rooms[0].id,
      attendant_user_id: t.users[0].id,
      business_date: '2026-12-24',
      status: 'assigned',
    }),
    crossTenant: [
      {
        name: "assigns another tenant's room for cleaning",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          room_id: other.rooms[0].id,
          attendant_user_id: own.users[0].id,
          business_date: '2026-12-07',
          status: 'assigned',
        }),
      },
      {
        name: "assigns a room to another tenant's user",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          room_id: own.rooms[0].id,
          attendant_user_id: other.users[0].id,
          business_date: '2026-12-08',
          status: 'assigned',
        }),
      },
    ],
  },

  {
    table: 'housekeeping_discrepancies',
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      room_id: t.rooms[0].id,
      business_date: '2026-12-05',
      front_desk_status: 'vacant',
      housekeeping_status: 'occupied',
    }),
    crossTenant: [
      {
        name: "raises a discrepancy against another tenant's room",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          room_id: other.rooms[0].id,
          business_date: '2026-12-05',
          front_desk_status: 'vacant',
          housekeeping_status: 'occupied',
        }),
      },
    ],
  },

  // -----------------------------------------------------------------------
  // Notifications — PLAN.md Phase 3
  // -----------------------------------------------------------------------

  {
    table: 'outbox_events',
    // TENANT_SCOPED (see table-scopes.js's own header on this table) — no
    // per-property uniqueness or FK to assert; coverage here is the
    // TENANT_SCOPED read/write isolation the generic ISO-* suite already
    // exercises for `idempotency_keys` the same way.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      event_type: 'reservation.confirmed',
      aggregate_type: 'reservations',
      aggregate_id: t.reservations[0].id,
      payload: JSON.stringify({ reservationId: t.reservations[0].id }),
      status: 'pending',
    }),
  },

  {
    table: 'email_templates',
    uniqueKeys: [['property_id', 'template_key', 'locale']],
    // A different template_key than the fixture-seeded row (which already
    // holds 'reservation_confirmed'/'en' for this property) — a genuinely
    // new, non-colliding row.
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      template_key: 'reservation_cancelled',
      locale: 'en',
      subject: 'Your booking is cancelled',
      body_html: '<p>Your booking was cancelled.</p>',
    }),
    // Collides with the fixture row seeded in seedTwoTenants.
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      template_key: 'reservation_confirmed',
      locale: 'en',
      subject: 'Clash',
      body_html: '<p>Clash</p>',
    }),
    crossTenant: [
      {
        name: "creates a template for another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          template_key: 'reservation_cancelled',
          locale: 'en',
          subject: 'Cross-tenant attempt',
          body_html: '<p>Cross-tenant attempt</p>',
        }),
      },
    ],
  },

  {
    table: 'notification_log',
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      recipient_email: 'guest@example.com',
      template_key: 'reservation_confirmed',
      channel: 'email',
      status: 'sent',
      reservation_id: t.reservations[0].id,
      sent_at: hoursFromNow(-1),
    }),
    crossTenant: [
      {
        name: "logs a send against another tenant's reservation",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          recipient_email: 'guest@example.com',
          template_key: 'reservation_confirmed',
          channel: 'email',
          status: 'sent',
          reservation_id: other.reservations[0].id,
          sent_at: hoursFromNow(-1),
        }),
      },
    ],
  },

  {
    table: 'in_app_notifications',
    // TENANT_SCOPED, following `users` — coverage is the FK-based
    // cross-tenant case only, the same shape `sessions`/`mfa_devices` use.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      user_id: t.users[0].id,
      type: 'housekeeping.discrepancy_raised',
      payload: JSON.stringify({ roomId: t.rooms[0].id }),
    }),
    crossTenant: [
      {
        name: "creates a notification for another tenant's user",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          user_id: other.users[0].id,
          type: 'housekeeping.discrepancy_raised',
          payload: JSON.stringify({ roomId: own.rooms[0].id }),
        }),
      },
    ],
  },

  // -----------------------------------------------------------------------
  // Cashiering — PLAN.md Phase 2.5
  // -----------------------------------------------------------------------

  {
    table: 'folio_line_items',
    // No natural business unique key — a folio can legitimately carry two
    // charges of the same type/amount/date (a manual charge posted twice on
    // purpose is still two real lines, not a collision), the same reasoning
    // `auth_events`/`audit_log` declare none.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      folio_id: t.folios[0].id,
      type: 'room_charge',
      description: 'New fixture charge',
      amount: '25.00',
      currency: 'NGN',
      business_date: '2026-12-24',
    }),
    crossTenant: [
      {
        name: "posts a line item against another tenant's folio",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          folio_id: other.folios[0].id,
          type: 'room_charge',
          description: 'Cross-tenant charge',
          amount: '25.00',
          currency: 'NGN',
          business_date: '2026-12-24',
        }),
      },
    ],
  },

  {
    table: 'payments',
    uniqueKeys: [['tenant_id', 'idempotency_key'], ['provider', 'provider_reference']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      folio_id: t.folios[0].id,
      idempotency_key: `NEWPAY-${t.slug}`,
      provider: 'cash',
      provider_reference: `NEWPAYREF-${t.slug}`,
      amount: '25.00',
      currency: 'NGN',
      status: 'INITIATED',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      folio_id: t.folios[0].id,
      idempotency_key: `OTHER-${t.slug}`,
      provider: 'cash',
      provider_reference: `FIXTUREPAYREF-${t.slug}`, // Matches seedTwoTenants' own fixture payment — collides on UNIQUE(provider, provider_reference).
      amount: '25.00',
      currency: 'NGN',
      status: 'INITIATED',
    }),
    crossTenant: [
      {
        name: "captures a payment against another tenant's folio",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          folio_id: other.folios[0].id,
          idempotency_key: `CROSSPAY-${own.slug}`,
          provider: 'cash',
          provider_reference: `CROSSPAYREF-${own.slug}`,
          amount: '25.00',
          currency: 'NGN',
          status: 'INITIATED',
        }),
      },
    ],
  },

  {
    table: 'payment_webhook_events',
    // PLATFORM_SCOPED with nullable tenant_id/property_id attribution
    // (`auth_events`' own precedent) — no crossTenant shape applies here for
    // the same reason it does not for auth_events: the accessor never
    // injects a tenant filter on this table at all.
    uniqueKeys: [['provider', 'provider_event_id']],
    newRow: () => ({
      provider: 'paystack',
      provider_event_id: `evt_new_${Date.now()}_${Math.random()}`,
      payload: JSON.stringify({ event: 'charge.success' }),
      verified: true,
    }),
    duplicateRow: () => ({
      provider: 'paystack',
      provider_event_id: 'FIXTURE_DUPLICATE_EVENT_ID',
      payload: JSON.stringify({ event: 'charge.success' }),
      verified: true,
    }),
  },

  // -----------------------------------------------------------------------
  // Night Audit — PLAN.md Phase 2.5
  // -----------------------------------------------------------------------

  {
    table: 'night_audit_runs',
    uniqueKeys: [['property_id', 'business_date']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      business_date: '2027-01-05',
      status: 'RUNNING',
      worker_id: 'test-worker',
      heartbeat_at: hoursFromNow(0),
      started_at: hoursFromNow(0),
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      business_date: '2026-12-01', // Matches seedTwoTenants' own fixture run.
      status: 'RUNNING',
      worker_id: 'test-worker',
      heartbeat_at: hoursFromNow(0),
      started_at: hoursFromNow(0),
    }),
    crossTenant: [
      {
        name: "starts a night audit run against another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          business_date: '2027-01-06',
          status: 'RUNNING',
          worker_id: 'test-worker',
          heartbeat_at: hoursFromNow(0),
          started_at: hoursFromNow(0),
        }),
      },
    ],
  },

  {
    table: 'daily_reports',
    uniqueKeys: [['property_id', 'business_date']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      night_audit_run_id: t.nightAuditRuns[0].id,
      business_date: '2027-01-05',
      room_revenue: '0.00',
      pos_revenue: '0.00',
      payments_collected: '0.00',
      occupancy_pct: '0.00',
      adr: '0.00',
      revpar: '0.00',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      night_audit_run_id: t.nightAuditRuns[0].id,
      business_date: '2026-12-01', // Matches seedTwoTenants' own fixture snapshot.
      room_revenue: '0.00',
      pos_revenue: '0.00',
      payments_collected: '0.00',
      occupancy_pct: '0.00',
      adr: '0.00',
      revpar: '0.00',
    }),
    crossTenant: [
      {
        name: "generates a snapshot against another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          night_audit_run_id: own.nightAuditRuns[0].id,
          business_date: '2027-01-07',
          room_revenue: '0.00',
          pos_revenue: '0.00',
          payments_collected: '0.00',
          occupancy_pct: '0.00',
          adr: '0.00',
          revpar: '0.00',
        }),
      },
    ],
  },

  // -----------------------------------------------------------------------
  // POS core — PLAN.md Phase 4
  // -----------------------------------------------------------------------

  {
    table: 'pos_outlets',
    uniqueKeys: [['property_id', 'code']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'NEWOUTLET',
      name: 'New Fixture Outlet',
      type: 'restaurant',
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      code: 'BAR', // Matches seedTwoTenants' own fixture outlet.
      name: 'Duplicate Bar',
      type: 'bar',
    }),
    crossTenant: [
      {
        name: "creates an outlet against another tenant's property",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: other.properties[0].id,
          code: 'CROSSOUTLET',
          name: 'Cross-Tenant Outlet',
          type: 'bar',
        }),
      },
    ],
  },

  {
    table: 'pos_terminals',
    uniqueKeys: [['outlet_id', 'device_ref']],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      outlet_id: t.posOutlets[0].id,
      device_ref: `NEWTERMINAL-${t.slug}`,
    }),
    duplicateRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      outlet_id: t.posOutlets[0].id,
      device_ref: `FIXTURE-TERMINAL-${t.slug}`, // Matches seedTwoTenants' own fixture terminal.
    }),
    crossTenant: [
      {
        name: "assigns a terminal to another tenant's outlet",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          outlet_id: other.posOutlets[0].id,
          device_ref: `CROSSTERMINAL-${own.slug}`,
        }),
      },
    ],
  },

  {
    table: 'pos_menu_items',
    // No natural business unique key — two menu items can legitimately
    // share a name/category/price, the same reasoning `folio_line_items`
    // declares none.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      outlet_id: t.posOutlets[0].id,
      name: 'New Fixture Item',
      category: 'Starters',
      price: '10.00',
    }),
    crossTenant: [
      {
        name: "creates a menu item against another tenant's outlet",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          outlet_id: other.posOutlets[0].id,
          name: 'Cross-Tenant Item',
          category: 'Starters',
          price: '10.00',
        }),
      },
    ],
  },

  {
    table: 'pos_orders',
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      outlet_id: t.posOutlets[0].id,
      terminal_id: t.posTerminals[0].id,
      opened_by_user_id: t.users[0].id,
      table_label: 'T2',
    }),
    crossTenant: [
      {
        name: "opens a tab against another tenant's outlet",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          outlet_id: other.posOutlets[0].id,
          terminal_id: other.posTerminals[0].id,
          opened_by_user_id: own.users[0].id,
          table_label: 'CROSS',
        }),
      },
    ],
  },

  {
    table: 'pos_order_items',
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      pos_order_id: t.posOrders[0].id,
      menu_item_id: t.posMenuItems[0].id,
      quantity: 1,
      unit_price: '20.00',
    }),
    crossTenant: [
      {
        name: "adds a line item to another tenant's order",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          pos_order_id: other.posOrders[0].id,
          menu_item_id: own.posMenuItems[0].id,
          quantity: 1,
          unit_price: '20.00',
        }),
      },
    ],
  },

  {
    table: 'pos_order_settlements',
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      pos_order_id: t.posOrders[0].id,
      method: 'card',
      subtotal: '20.00',
      currency: 'NGN',
      settled_by_user_id: t.users[0].id,
    }),
    crossTenant: [
      {
        name: "settles against another tenant's order",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          pos_order_id: other.posOrders[0].id,
          method: 'card',
          subtotal: '20.00',
          currency: 'NGN',
          settled_by_user_id: own.users[0].id,
        }),
      },
    ],
  },

  {
    table: 'pos_shifts',
    // `UNIQUE(terminal_id, closed_at)` cannot enforce "one open shift" —
    // MySQL treats every NULL as distinct (see the migration's own
    // header) — so this table, like `folio_line_items`, declares no
    // natural unique key for the isolation suite either.
    uniqueKeys: [],
    newRow: (ctx, t) => ({
      tenant_id: t.id,
      property_id: t.properties[0].id,
      terminal_id: t.posTerminals[0].id,
      user_id: t.users[0].id,
      opening_float: '100.00',
      currency: 'NGN',
    }),
    crossTenant: [
      {
        name: "opens a shift against another tenant's terminal",
        row: (ctx, own, other) => ({
          tenant_id: own.id,
          property_id: own.properties[0].id,
          terminal_id: other.posTerminals[0].id,
          user_id: own.users[0].id,
          opening_float: '100.00',
          currency: 'NGN',
        }),
      },
    ],
  },
];

const byTable = (table) => ENTITIES.find((e) => e.table === table);

module.exports = { ENTITIES, ER, byTable };
