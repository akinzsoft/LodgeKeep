'use strict';

/**
 * POS permission keys — PLAN.md Phase 4. Following the exact pattern
 * `20260909097000_seed_night_audit_permissions.js` established.
 *
 * `pos_operator` has existed as a system role since Phase 0
 * (`seeds/01_dev_tenants.js`'s `SYSTEM_ROLES`) but has held ZERO
 * permission grants until now — invisible for the same reason
 * `admin`/`super_admin` were before the MFA cross-cutting fix: no
 * pos.* keys existed for it to hold, and no POS screen existed to notice
 * the gap.
 *
 * SECURITY.md §5's matrix showed a plain "✓" for `pos_operator`, but this
 * session's confirmed decision splits it the same way Cashiering's own
 * "Limited" cell already is: `pos.operate` (run the register — open/view
 * orders and shifts, add/void-before-settlement items, settle including
 * charge-to-room, blind cash-up) for pos_operator/manager/admin/
 * super_admin; `pos.manage` (outlet/terminal/menu CRUD, and the "Manager
 * overrides" PRODUCT_REQUIREMENTS.md §3.4 names explicitly — discounts,
 * comps, post-settlement voids) for manager/admin/super_admin only.
 * SECURITY.md itself is updated in this same pass to record the
 * correction, not left implicit in this migration's comment alone.
 */

exports.up = async function up(knex) {
  const keys = ['pos.operate', 'pos.manage'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'pos.operate', name: 'Run the POS register — orders, settlement, cash-up', domain: 'pos' },
    { permission_key: 'pos.manage', name: 'Configure outlets/terminals/menu; manager overrides and post-settlement voids', domain: 'pos' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['pos.operate', 'pos.manage']).delete();
};
