'use strict';

/**
 * Reports permission keys — PLAN.md Phase 3.
 *
 * `reports.view_financial` already existed as a FIXTURE-only key
 * (`tests/helpers/fixtures.js`, granted to `manager` in every test tenant)
 * ahead of any real Reports module — the same "proven against a
 * representative catalogue before the real module lands" pattern
 * `src/auth/rbac.js`'s own header describes for the whole matrix. This
 * migration is what makes it real, following the exact select-or-insert
 * precedent `20260905095000_seed_setup_permissions.js` established for
 * exactly this situation (`setup.view`/`.manage` went from fixture-only to
 * migration-seeded the same way).
 *
 * SECURITY.md §5's matrix, quoted directly: Front desk and Cashier get
 * "Limited" on Reports, Housekeeping and POS operator get none, Manager/
 * Admin/Super-admin get full (✓). "Limited" is defined here, per that
 * section's own rule ("defined per endpoint at implementation time...
 * written down in that module's own doc"): `reports.view` is the occupancy/
 * housekeeping report only, no revenue or financial figures — `front_desk`
 * and `cashier` get exactly this key. `reports.view_financial` additionally
 * unlocks the revenue/ADR/RevPAR report and CSV export of it; only manager/
 * admin/super_admin hold it, alongside `reports.view` for the same set of
 * reports the Limited role sees plus the financial ones.
 */

exports.up = async function up(knex) {
  const keys = ['reports.view', 'reports.view_financial'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'reports.view', name: 'View occupancy and housekeeping reports', domain: 'reports' },
    { permission_key: 'reports.view_financial', name: 'View revenue and financial reports', domain: 'reports' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['reports.view', 'reports.view_financial']).delete();
};
