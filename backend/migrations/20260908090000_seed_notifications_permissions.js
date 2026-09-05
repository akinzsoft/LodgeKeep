'use strict';

/**
 * Notifications permission keys — PLAN.md Phase 3.
 *
 * SECURITY.md §5's matrix has NO "Notifications" column at all — confirmed
 * by reading that file directly; it covers Reservations/Front
 * Desk/Cashiering/Housekeeping/POS/Reports/Setup only. This session's
 * confirmed decision, following the matrix's own established shape rather
 * than inventing an unrelated one: Notifications is gated the same way
 * Setup is (an admin-configuration surface, not an operational one) —
 * `manager` gets read-only (`notifications.view`: the delivery log, "the
 * guest never got it" lookup), `admin`/`super_admin` get full access
 * (`notifications.manage`: editing templates, triggering a resend). Every
 * OTHER role gets neither key — the in-app bell itself needs no permission
 * at all, since every authenticated staff member reads only their own
 * `in_app_notifications` rows regardless of role.
 *
 * SECURITY.md is updated in this same pass (a new "Notifications" column) so
 * the matrix documents what is actually enforced, matching the discipline
 * DATABASE.md's `room_type_inventory` row was corrected under in Phase 2.
 */

exports.up = async function up(knex) {
  const keys = ['notifications.view', 'notifications.manage'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'notifications.view', name: 'View notification delivery log', domain: 'notifications' },
    { permission_key: 'notifications.manage', name: 'Manage email templates and resend failed notifications', domain: 'notifications' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['notifications.view', 'notifications.manage']).delete();
};
