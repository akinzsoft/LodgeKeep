'use strict';

/**
 * Entity scope declarations — ARCHITECTURE.md §3.
 *
 * Every table falls into exactly one of four scopes, and that classification
 * decides which columns the scoped data-access layer (SECURITY.md §2) injects
 * into every query against it:
 *
 *   PLATFORM_SCOPED    nothing tenant-related
 *   TENANT_SCOPED      tenant_id
 *   PROPERTY_SCOPED    tenant_id + property_id
 *   GLOBAL_REFERENCE   neither — seeded, tenant-independent reference data
 *
 * §3: "A new table must declare its scope before it can be queried through the
 * accessor; there is no 'unscoped' query path." This file is that declaration.
 * It is deliberately plain data with no query logic: the accessor (PLAN.md
 * Phase 0, still to build) reads it, and `tests/isolation` reads it to assert
 * that each table's real columns, indexes, and foreign keys match what it
 * claims here. A table missing from this map has no query path and no isolation
 * coverage — which is the intended failure mode, not an oversight.
 *
 * `scopeRoot` marks the two tables whose own primary key *is* the scope:
 * `tenants.id` is the tenant_id every other table carries, and `properties.id`
 * is the property_id. They are the only tables that do not repeat the column
 * they define.
 */

const SCOPES = Object.freeze({
  PLATFORM: 'PLATFORM_SCOPED',
  TENANT: 'TENANT_SCOPED',
  PROPERTY: 'PROPERTY_SCOPED',
  GLOBAL: 'GLOBAL_REFERENCE',
});

const TABLE_SCOPES = Object.freeze({
  // Tenancy & platform — 20260902213045_create_tenants_and_properties
  tenants: { scope: SCOPES.TENANT, scopeRoot: 'tenant' },
  properties: { scope: SCOPES.PROPERTY, scopeRoot: 'property' },

  // Identity & access — 20260903202134_create_identity_and_access
  users: { scope: SCOPES.TENANT },
  roles: { scope: SCOPES.TENANT },
  permissions: { scope: SCOPES.GLOBAL },
  role_permissions: { scope: SCOPES.TENANT },
  user_property_access: { scope: SCOPES.PROPERTY },
  platform_users: { scope: SCOPES.PLATFORM },
  guest_accounts: { scope: SCOPES.PROPERTY },

  // Auth credentials — 20260903210341_create_auth_credentials
  //
  // `user_invitations` is PROPERTY_SCOPED rather than TENANT_SCOPED because an
  // invitation grants a role *at a property* (SECURITY.md §4); that migration's
  // comment explains why it carries a property_id the DATABASE.md §1 column
  // list does not mention.
  sessions: { scope: SCOPES.TENANT },
  password_resets: { scope: SCOPES.TENANT },
  mfa_devices: { scope: SCOPES.TENANT },
  user_invitations: { scope: SCOPES.PROPERTY },

  // Auth audit — 20260904101500_create_auth_events
  //
  // The one table that carries tenant_id and property_id while declaring
  // PLATFORM_SCOPED, and the only place `attributionColumns` is used.
  //
  // Those two columns are nullable and record *who the event was about*, not
  // *whose data this row is*. The distinction is load-bearing: the event most
  // worth recording is a login failure for an address matching no account, and
  // that event has no tenant to resolve. A NOT NULL tenant_id would force the
  // auth module to discard exactly the rows the lockout counter and AUTH-14
  // depend on, or to invent a sentinel tenant — which is a cross-tenant bug
  // waiting for a join to find it.
  //
  // Declaring the exception here rather than leaving it implicit is what makes
  // it testable: tests/isolation/entity-scope.test.js asserts that every column
  // named below really is nullable, so this field cannot be used to slip a
  // genuine scope column past the scope check.
  //
  // The table therefore has NO tenant-scoped read path. `src/auth` is its only
  // writer, and the lockout counter its only reader. A tenant-facing sign-in
  // activity screen needs a dedicated service function that filters tenant_id
  // explicitly, reviewed as the exception it is.
  auth_events: {
    scope: SCOPES.PLATFORM,
    attributionColumns: ['tenant_id', 'property_id'],
  },

  // Auth — 20260904120000_create_tenant_domains
  //
  // Ordinary TENANT_SCOPED table for every read except one: resolving a
  // request's Host header to a tenant_id happens before a context exists at
  // all, and is not reachable through `table()`. That one read goes through
  // `bootstrapLookup` in scoped-db.js instead — see that file and this
  // migration's header for why.
  tenant_domains: { scope: SCOPES.TENANT },

  // Audit trail — 20260904150000_create_audit_log
  //
  // TENANT_SCOPED. Unlike auth_events, tenant_id is always known here — every
  // audited action happens post-authentication. property_id is the
  // attribution exception this time: most audited entities are
  // property-scoped, but a tenant-level admin action (a role definition edit)
  // has none, so property_id is real, meaningful data the accessor never
  // requires or injects.
  audit_log: {
    scope: SCOPES.TENANT,
    attributionColumns: ['property_id'],
  },

  // Property setup — PLAN.md Phase 1, 20260905090000_create_room_types
  // through 20260905094000_create_taxes.
  //
  // All PROPERTY_SCOPED, per ARCHITECTURE.md §3: "room_types, rate_codes,
  // taxes ... Two properties in the same tenant can have entirely different
  // room inventories and tax jurisdictions." `rooms` and `rate_calendar`
  // aren't named in that §3 quote directly but follow their parent
  // (`room_types`/`rate_codes`) into the same scope for the identical
  // reason.
  room_types: { scope: SCOPES.PROPERTY },
  rooms: { scope: SCOPES.PROPERTY },
  rate_codes: { scope: SCOPES.PROPERTY },
  rate_calendar: { scope: SCOPES.PROPERTY },
  taxes: { scope: SCOPES.PROPERTY },

  // Setup reference data — PLAN.md Phase 1 gap closure,
  // 20260910090000_create_market_segments.js through
  // 20260910092000_create_cancellation_policies.js. Same PROPERTY_SCOPED
  // reasoning as room_types/rate_codes above.
  market_segments: { scope: SCOPES.PROPERTY },
  booking_sources: { scope: SCOPES.PROPERTY },
  cancellation_policies: { scope: SCOPES.PROPERTY },

  // Idempotency infra — PLAN.md Phase 2, 20260906090000_create_idempotency_keys.
  //
  // TENANT_SCOPED, not PROPERTY_SCOPED: ARCHITECTURE.md §7 scopes a key to
  // "one tenant + one operation type + the key value itself" — no property
  // dimension. Shared infra, not owned by the reservations module alone.
  idempotency_keys: { scope: SCOPES.TENANT },

  // Reservations & front desk — PLAN.md Phase 2,
  // 20260906091000_create_guests through 20260906097000_create_folios.
  //
  // `guests` is TENANT_SCOPED (DATABASE.md §1: "guest_id references the
  // tenant-level guests row regardless of which property this reservation
  // is for"), confirmed independently by guest_accounts.guest_id's own
  // forward-reference comment from Phase 0. Every other table here follows
  // `reservations` into PROPERTY_SCOPED, the same reasoning room_types/
  // rate_codes gave in Phase 1: two properties in the same tenant can have
  // entirely different guests booked, room inventories, and folios.
  guests: { scope: SCOPES.TENANT },
  room_type_inventory: { scope: SCOPES.PROPERTY },
  reservations: { scope: SCOPES.PROPERTY },
  reservation_rooms: { scope: SCOPES.PROPERTY },
  reservation_daily_rates: { scope: SCOPES.PROPERTY },
  reservation_notes: { scope: SCOPES.PROPERTY },
  folios: { scope: SCOPES.PROPERTY },

  // Housekeeping — PLAN.md Phase 3, 20260907091000_create_out_of_order_periods
  // through 20260907094000_create_housekeeping_discrepancies. All
  // PROPERTY_SCOPED, following `rooms` for the same reason every other
  // rooms-adjacent table has since Phase 1: two properties in the same
  // tenant have entirely different rooms, attendants, and discrepancies.
  out_of_order_periods: { scope: SCOPES.PROPERTY },
  housekeeping_assignments: { scope: SCOPES.PROPERTY },
  housekeeping_discrepancies: { scope: SCOPES.PROPERTY },

  // Notifications — PLAN.md Phase 3, 20260907096000_create_outbox_events
  // through 20260907099000_create_in_app_notifications.
  //
  // `outbox_events` is TENANT_SCOPED, not PROPERTY_SCOPED, following
  // `idempotency_keys`' own precedent rather than every other Phase 2/3
  // table — see that migration's own header for why. `property_id` is real,
  // meaningful data (every event this pass emits carries one) but not a
  // column the accessor requires or injects, the same attribution-vs-scope
  // distinction `audit_log` already draws.
  outbox_events: { scope: SCOPES.TENANT, attributionColumns: ['property_id'] },
  email_templates: { scope: SCOPES.PROPERTY },
  notification_log: { scope: SCOPES.PROPERTY },
  // TENANT_SCOPED, following `users` — a notification belongs to one staff
  // member, not one property (see that migration's own header).
  in_app_notifications: { scope: SCOPES.TENANT },

  // Cashiering — PLAN.md Phase 2.5, 20260909091000_create_payments through
  // 20260909093000_create_folio_line_items. PROPERTY_SCOPED, following
  // `folios` (their parent) for the same reason every folio-adjacent table
  // has since Phase 2: two properties in the same tenant have entirely
  // different guests, folios, and payments.
  payments: { scope: SCOPES.PROPERTY },
  folio_line_items: { scope: SCOPES.PROPERTY },
  // PLATFORM_SCOPED with nullable tenant/property ATTRIBUTION, following
  // `auth_events`' own precedent exactly: a gateway webhook arrives with no
  // session and no tenant context to scope by — see that migration's own
  // header for the full reasoning.
  payment_webhook_events: { scope: SCOPES.PLATFORM, attributionColumns: ['tenant_id', 'property_id'] },

  // Night Audit — PLAN.md Phase 2.5, 20260909094000_create_night_audit_runs
  // and 20260909095000_create_daily_reports. PROPERTY_SCOPED, following
  // `properties` for the same reason every property-level artifact has.
  night_audit_runs: { scope: SCOPES.PROPERTY },
  daily_reports: { scope: SCOPES.PROPERTY },

  // POS core — PLAN.md Phase 4, 20260912090000_create_pos_outlets through
  // 20260912096000_create_pos_shifts. PROPERTY_SCOPED throughout, following
  // `pos_outlets` (the root of this family) for the same reason every
  // outlet-adjacent table does: two properties in the same tenant run
  // entirely separate bars/restaurants.
  pos_outlets: { scope: SCOPES.PROPERTY },
  pos_terminals: { scope: SCOPES.PROPERTY },
  pos_menu_items: { scope: SCOPES.PROPERTY },
  pos_orders: { scope: SCOPES.PROPERTY },
  pos_order_items: { scope: SCOPES.PROPERTY },
  pos_order_settlements: { scope: SCOPES.PROPERTY },
  pos_shifts: { scope: SCOPES.PROPERTY },
});

/** Throws for an undeclared table — there is no unscoped query path. */
function scopeOf(table) {
  const declared = TABLE_SCOPES[table];
  if (!declared) {
    throw new Error(
      `Table "${table}" has no scope declaration in src/shared/table-scopes.js. ` +
        'ARCHITECTURE.md §3: a table must declare its scope before it can be queried.'
    );
  }
  return declared;
}

module.exports = { SCOPES, TABLE_SCOPES, scopeOf };
