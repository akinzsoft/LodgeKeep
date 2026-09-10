'use strict';

/**
 * Accounts Receivable permission keys - PLAN.md Phase 4. Following the exact
 * select-or-insert idempotent pattern `20260909096000_seed_cashiering_permissions.js`
 * established.
 *
 * `ar.view` (front_desk, cashier, manager, admin, super_admin) - see a
 * company accounts balance, invoices, payment history and the ageing
 * report; see the over-limit/AR-owing informational state at checkout.
 * `ar.manage` (manager, admin, super_admin only, NOT cashier) - company AR
 * account configuration, billing a folio to an account, credit-limit
 * overrides, invoice generation/void, payment recording/apply/void.
 * Following Night Audits own precedent: closing a business date is
 * manager-level, not operational - the identical reasoning applies to
 * credit and collections decisions.
 *
 * SECURITY.md section 5s matrix gains an AR column in this same pass; see
 * that files own updated text for the written definition.
 */

exports.up = async function up(knex) {
  const keys = ['ar.view', 'ar.manage'];
  const existing = await knex('permissions').whereIn('permission_key', keys).select('permission_key');
  const already = new Set(existing.map((row) => row.permission_key));

  const rows = [
    { permission_key: 'ar.view', name: 'View Accounts Receivable accounts, invoices and ageing', domain: 'ar' },
    { permission_key: 'ar.manage', name: 'Manage Accounts Receivable accounts, invoices and payments', domain: 'ar' },
  ].filter((row) => !already.has(row.permission_key));

  if (rows.length) await knex('permissions').insert(rows);
};

exports.down = async function down(knex) {
  await knex('permissions').whereIn('permission_key', ['ar.view', 'ar.manage']).delete();
};
