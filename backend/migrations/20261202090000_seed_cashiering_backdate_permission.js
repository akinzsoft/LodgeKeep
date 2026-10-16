'use strict';

/**
 * `cashiering.backdate` (F-03, product audit) — post a charge or take a payment on a PAST business date.
 * Until now the date came straight from the request body, so anyone with `cashiering.post_charge` could post into
 * any day, audited or not. Now only the property's current business date is open to everyone; a past date needs this
 * key AND a day that Night Audit has not closed. Granted to manager, admin and super_admin (money-correcting roles).
 * Backfills existing tenants' roles, skipping tenants being purged or already purged.
 */

const KEY = 'cashiering.backdate';
const ROLE_CODES = ['manager', 'admin', 'super_admin'];

exports.up = async function up(knex) {
  const existing = await knex('permissions').where({ permission_key: KEY }).first('id');
  if (!existing) {
    await knex('permissions').insert({ permission_key: KEY, name: 'Post a charge or payment on a past, not yet audited business date', domain: 'cashiering' });
  }
  const permissionId = (await knex('permissions').where({ permission_key: KEY }).first('id')).id;

  const leaving = await knex('tenants').whereIn('status', ['purging', 'purged']).select('id');
  const leavingIds = new Set(leaving.map((row) => String(row.id)));
  const roles = (await knex('roles').whereIn('code', ROLE_CODES).select('id', 'tenant_id')).filter((row) => !leavingIds.has(String(row.tenant_id)));
  if (roles.length === 0) return;

  const already = await knex('role_permissions').where({ permission_id: permissionId }).select('role_id');
  const alreadyGranted = new Set(already.map((row) => String(row.role_id)));
  const toInsert = roles
    .filter((row) => !alreadyGranted.has(String(row.id)))
    .map((row) => ({ tenant_id: row.tenant_id, role_id: row.id, permission_id: permissionId }));
  if (toInsert.length) await knex('role_permissions').insert(toInsert);
};

exports.down = async function down(knex) {
  const row = await knex('permissions').where({ permission_key: KEY }).first('id');
  if (!row) return;
  await knex('role_permissions').where({ permission_id: row.id }).delete();
  await knex('permissions').where({ permission_key: KEY }).delete();
};
