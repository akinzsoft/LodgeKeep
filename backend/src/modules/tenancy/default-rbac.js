'use strict';

/**
 * The canonical role/permission matrix a brand-new tenant is seeded with —
 * PLAN.md Phase 5's self-service signup, SECURITY.md §5's authorization
 * matrix.
 *
 * This is the SAME matrix `tests/helpers/fixtures.js`'s per-domain grant
 * blocks already encode (verified line-by-line against that file before
 * writing this), NOT `seeds/01_dev_tenants.js`'s narrower one — that dev
 * script only grants `manager`/`admin`/`super_admin`/`pos_operator` (just
 * enough for its own three demo accounts), leaving `front_desk`/`cashier`/
 * `housekeeping` with zero real grants, a pre-existing gap this file does
 * not repeat for a real tenant born from a real signup. `seeds/01_dev_tenants.js`
 * itself is left untouched by this pass — it is a separate, already-working
 * dev/test fixture path, not a regression this feature introduces.
 *
 * Kept as plain data, not because it needs to be, but because SECURITY.md §5
 * IS a table — this module should read like the thing it implements.
 */

const SYSTEM_ROLES = Object.freeze([
  'front_desk',
  'cashier',
  'housekeeping',
  'pos_operator',
  'manager',
  'admin',
  'super_admin',
]);

const ALL_PERMISSION_KEYS = Object.freeze([
  'setup.view',
  'setup.manage',
  'room_types.update',
  'reservations.view',
  'reservations.manage',
  'front_desk.view',
  'front_desk.manage',
  'housekeeping.view',
  'housekeeping.manage',
  'notifications.view',
  'notifications.manage',
  'reports.view',
  'reports.view_financial',
  'cashiering.post_charge',
  'cashiering.void_line',
  'night_audit.view',
  'night_audit.run',
  'pos.operate',
  'pos.manage',
  'ar.view',
  'ar.manage',
  'group_blocks.view',
  'group_blocks.manage',
  'billing.view',
  'billing.manage',
  'offboarding.manage',
]);

/** Every catalogue key except `room_types.update` — `admin`'s own exact exclusion (SECURITY.md §5). */
const ADMIN_PERMISSION_KEYS = ALL_PERMISSION_KEYS.filter((key) => key !== 'room_types.update');

const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  front_desk: [
    'reservations.view', 'reservations.manage',
    'front_desk.view', 'front_desk.manage',
    'housekeeping.view',
    'cashiering.post_charge',
    'reports.view',
    'ar.view',
    'group_blocks.view',
  ],
  cashier: [
    'reservations.view',
    'cashiering.post_charge', 'cashiering.void_line',
    'reports.view',
    'ar.view',
    'group_blocks.view',
  ],
  housekeeping: [
    'housekeeping.view', 'housekeeping.manage',
  ],
  pos_operator: [
    'pos.operate',
  ],
  manager: [
    'reservations.view', 'reservations.manage',
    'front_desk.view', 'front_desk.manage',
    'cashiering.post_charge', 'cashiering.void_line',
    'housekeeping.view', 'housekeeping.manage',
    'pos.operate', 'pos.manage',
    'reports.view', 'reports.view_financial',
    'setup.view',
    'notifications.view',
    'night_audit.view', 'night_audit.run',
    'ar.view', 'ar.manage',
    'group_blocks.view', 'group_blocks.manage',
  ],
  admin: ADMIN_PERMISSION_KEYS,
  super_admin: ALL_PERMISSION_KEYS,
});

module.exports = { SYSTEM_ROLES, ALL_PERMISSION_KEYS, DEFAULT_ROLE_PERMISSIONS };
