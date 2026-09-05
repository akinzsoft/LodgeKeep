'use strict';

/**
 * Night Audit permission keys — PLAN.md Phase 2.5. Following the exact
 * pattern `20260907095000_seed_housekeeping_permissions.js` established.
 *
 * SECURITY.md §5's matrix has no Night Audit column at all (confirmed by
 * reading that file directly, the same "confirmed, not guessed" discipline
 * Notifications/Reports followed in PLAN.md Phase 3) — this session's
 * confirmed decision: closing a business date is a manager-level action,
 * not an operational front-desk/cashier one, so `night_audit.view` and
 * `night_audit.run` go to manager/admin/super_admin only. Front desk,
 * cashier, housekeeping, and POS operator get neither key.
 */

exports.up = async function up(knex) {
  const keys = ['night_audit.view', 'night_audit.run'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'night_audit.view', name: 'View night audit run history and reports', domain: 'night_audit' },
    { permission_key: 'night_audit.run', name: 'Run night audit and roll the business date', domain: 'night_audit' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['night_audit.view', 'night_audit.run']).delete();
};
