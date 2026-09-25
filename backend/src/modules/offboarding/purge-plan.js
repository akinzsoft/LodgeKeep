'use strict';

/**
 * The tenant retention purge's PLAN — pure data, no queries. Which tables a
 * purge deletes from, in what order, what it deliberately keeps, and the one
 * check that makes a NEW table impossible to forget.
 *
 * ── ORDER ────────────────────────────────────────────────────────────────
 *
 * Every foreign key in this schema is `RESTRICT` and the property-to-property
 * ones are composite (`tenant_id, property_id, id`), so deleting a parent before
 * its children is a hard `ER_ROW_IS_REFERENCED_2`, never a silent cascade. The
 * order below is CHILDREN BEFORE PARENTS. It was derived from
 * `information_schema.KEY_COLUMN_USAGE` (not from reading migrations) and is
 * PINNED to it by `tests/offboarding/purge-plan.test.js`, which fails the build
 * if a migration adds a foreign key this order violates, or a tenant-owned table
 * this plan has no decision for. That test, not this comment, is the guarantee.
 *
 * The four SELF-REFERENCING tables (`rooms.connecting_room_id`,
 * `payments.parent_payment_id`, `folio_line_items.related_line_item_id`,
 * `stock_movements.reversed_movement_id`) cannot be bulk-deleted row by row —
 * InnoDB checks RESTRICT per row. Their self-reference is set to NULL for the
 * tenant's rows first (a composite foreign key with a NULL part is not checked,
 * MATCH SIMPLE), then the rows are deleted.
 *
 * ── WHAT IS KEPT (confirmed with the user) ───────────────────────────────
 *
 *   tenants                       the TOMBSTONE: status 'purged', slug stays reserved
 *   tenant_signups                the one-signup-per-email guard
 *   subscriptions / _invoices /   Planmsys's own billing records. The subscription is
 *   _payments                     cancelled and its stored payment-method token cleared
 *   subscription_webhook_events   raw provider events, attributed to the tenant id only
 *   platform_users                not tenant data
 *   tenant_purges                 the record that a purge happened
 *   tenant_data_exports           kept as evidence an export was handed over; the file is
 *                                 deleted and `file_path` / `requested_by_user_id` cleared
 *   (GLOBAL_REFERENCE tables)     permissions, plans, plan_entitlements,
 *                                 platform_payment_integrations — never tenant data
 *
 * Everything else that carries a `tenant_id` is deleted.
 *
 * ── PLATFORM_SCOPED TABLES ARE DANGEROUS ─────────────────────────────────
 *
 * The accessor injects NO predicate for a PLATFORM_SCOPED table, so
 * `.platform().table('auth_events').delete()` with no `where` would delete every
 * tenant's rows. Every step over such a table is therefore built only through
 * `src/modules/offboarding/purge.js`'s `purgeQuery`, which always adds
 * `where({tenant_id})` and asserts it reached the compiled SQL.
 */

const { TABLE_SCOPES, SCOPES } = require('../../shared/table-scopes');

const DEFAULT_CHUNK = 500;
const LARGE_CHUNK = 1000;

/** Tables that are kept, and why — see the file header. */
const RETAINED_TABLES = Object.freeze([
  'tenants',
  'tenant_signups',
  'subscriptions',
  'subscription_invoices',
  'subscription_payments',
  'subscription_webhook_events',
  'platform_users',
  'tenant_purges',
  'tenant_data_exports',
]);

/**
 * Kept tables whose CONTENT is partly cleared. `tenant_data_exports` holds a
 * foreign key to `users`, so `requested_by_user_id` is NULLed before the users are
 * deleted; the export FILE is deleted and `file_path` cleared at finalize.
 */
const CLEARED_TABLES = Object.freeze({
  tenant_data_exports: { beforeUsers: { requested_by_user_id: null }, atFinalize: { file_path: null } },
});

/** Files a chunk of rows owns; deleted BEFORE the rows so a crash never orphans a file. */
const FILE_HOOKS = Object.freeze({
  pos_menu_items: { kind: 'menu_image', column: 'image_path' },
  import_runs: { kind: 'import_file', column: 'file_path' },
  properties: { kind: 'property_logo', column: 'logo_url' },
});

/** The four self-referencing tables and the column that points back at the same table. */
const SELF_REFERENCES = Object.freeze({
  rooms: 'connecting_room_id',
  payments: 'parent_payment_id',
  folio_line_items: 'related_line_item_id',
  stock_movements: 'reversed_movement_id',
});

const LARGE_TABLES = new Set([
  'audit_log',
  'auth_events',
  'outbox_events',
  'idempotency_keys',
  'door_access_events',
  'reservation_daily_rates',
  'room_type_inventory',
  'rate_calendar',
]);

/** CHILDREN BEFORE PARENTS. Pinned to `information_schema` by tests/offboarding/purge-plan.test.js. */
const TENANT_PURGE_ORDER = Object.freeze([
  // side-effect and credential leaves first: nothing here is referenced by anything
  'outbox_events',
  'idempotency_keys',
  'in_app_notifications',
  'notification_log',
  'mfa_login_codes',
  'password_reset_codes',
  'mfa_devices',
  'sessions',
  'tenant_domains', // also removed at the claim, so the hostname stops resolving at once
  'guest_password_resets',
  'user_invitations',
  'pos_guest_orders',
  'pos_room_charge_otps',
  'pos_order_tokens',
  // door access
  'access_alert_events',
  'door_access_stay_confirmations',
  'access_alerts',
  'door_access_events',
  'lock_system_config',
  // expenses
  'expenses',
  'recurring_expense_schedules',
  'expense_categories',
  // accounts receivable
  'ar_payment_applications',
  'ar_payments',
  'ar_invoice_lines',
  'ar_invoices',
  'ar_invoice_sequences',
  'ar_accounts',
  // stock
  'stock_take_lines',
  'stock_movements',
  'stock_takes',
  'pos_menu_item_components',
  'stock_items',
  'stock_item_categories',
  // POS orders and the money behind them
  'pos_order_items',
  'pos_order_settlements',
  'payment_webhook_events',
  'folio_line_items',
  'payments',
  'folios',
  'pos_orders',
  'pos_shifts',
  'pos_terminals',
  'pos_menu_items',
  'pos_menu_categories',
  'pos_outlets',
  // night audit and reservations
  'daily_reports',
  'night_audit_runs',
  'reservation_notes',
  'reservation_daily_rates',
  'reservation_rooms',
  'housekeeping_discrepancies',
  'housekeeping_assignments',
  'out_of_order_periods',
  'reservations',
  'group_block_rooms',
  'group_blocks',
  // rooms, rates and property configuration
  'room_type_inventory',
  'rate_calendar',
  'rooms',
  'room_types',
  'rate_codes',
  'market_segments',
  'booking_sources',
  'cancellation_policies',
  'taxes',
  'property_payment_subaccounts',
  'email_templates',
  'email_settings',
  'notification_role_rules',
  // data migration
  'import_row_errors',
  'imported_record_map',
  'import_runs',
  // audit and identity: these hold RESTRICT foreign keys to users, properties and
  // guest_accounts, so they go before all three
  'auth_events',
  'audit_log',
  'guest_accounts',
  'guests',
  'company_profiles',
  'billing_payment_method_checkouts',
  'impersonation_sessions',
  // -- the CLEAR of tenant_data_exports.requested_by_user_id happens here (see runPurgeTick) --
  'user_property_access',
  'role_permissions',
  'roles',
  'users',
  'properties',
]);

/** Where, in the order above, `tenant_data_exports.requested_by_user_id` is NULLed: immediately before `user_property_access`. */
const CLEAR_EXPORT_REQUESTER_BEFORE = 'user_property_access';

function chunkSizeFor(table) {
  return LARGE_TABLES.has(table) ? LARGE_CHUNK : DEFAULT_CHUNK;
}

/** How a step reaches its table through the scoped accessor, derived from the table's declared scope. */
function accessKindFor(table) {
  const declared = TABLE_SCOPES[table];
  if (!declared) throw new Error(`purge plan: "${table}" has no scope declaration in src/shared/table-scopes.js.`);
  if (declared.scope === SCOPES.PLATFORM) return 'platform';
  // `properties` is the property scope root: it needs only tenant_id, so it is read like a tenant table.
  if (declared.scope === SCOPES.PROPERTY && declared.scopeRoot !== 'property') return 'property';
  return 'tenant';
}

/** The plan as ordered step descriptors, with everything a step needs to run. */
function buildPurgeSteps(order = TENANT_PURGE_ORDER) {
  return order.map((table) => ({
    table,
    access: accessKindFor(table),
    chunk: chunkSizeFor(table),
    selfReference: SELF_REFERENCES[table] ?? null,
    fileHook: FILE_HOOKS[table] ?? null,
    clearExportRequesterBefore: table === CLEAR_EXPORT_REQUESTER_BEFORE,
  }));
}

/**
 * Whether the plan accounts for EVERY tenant-owned table, exactly once. Pure over
 * a scope map so a test can hand it a broken one. GLOBAL_REFERENCE tables are
 * ignored (never tenant data); everything else must be either purged or retained.
 */
function classifyAllTables({ tableScopes = TABLE_SCOPES, order = TENANT_PURGE_ORDER, retained = RETAINED_TABLES } = {}) {
  const declared = Object.keys(tableScopes).filter((table) => tableScopes[table].scope !== SCOPES.GLOBAL);
  const purged = new Set(order);
  const kept = new Set(retained);

  const unclassified = declared.filter((table) => !purged.has(table) && !kept.has(table));
  const both = [...purged].filter((table) => kept.has(table));
  const duplicated = order.filter((table, index) => order.indexOf(table) !== index);
  const unknownInPlan = [...purged, ...kept].filter((table) => !tableScopes[table]);
  return { unclassified, both, duplicated, unknownInPlan, ok: !unclassified.length && !both.length && !duplicated.length && !unknownInPlan.length };
}

module.exports = {
  TENANT_PURGE_ORDER,
  RETAINED_TABLES,
  CLEARED_TABLES,
  FILE_HOOKS,
  SELF_REFERENCES,
  CLEAR_EXPORT_REQUESTER_BEFORE,
  DEFAULT_CHUNK,
  LARGE_CHUNK,
  chunkSizeFor,
  accessKindFor,
  buildPurgeSteps,
  classifyAllTables,
};
