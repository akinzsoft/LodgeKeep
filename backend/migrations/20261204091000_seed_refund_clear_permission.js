'use strict';

/**
 * `cashiering.refund_clear` — clear a Paystack refund that is stuck (accepted or sent, but never confirmed) once the
 * reconciliation sweep has checked Paystack and could not confirm it. Manager, admin and super_admin. Backfills existing
 * tenants and skips tenants being purged or already purged.
 */

const GRANT = { key: 'cashiering.refund_clear', name: 'Clear a stuck card refund after reconciliation could not confirm it', domain: 'cashiering', roles: ['manager', 'admin', 'super_admin'] };

exports.up = async function up(knex) {
  const leaving = await knex('tenants').whereIn('status', ['purging', 'purged']).select('id');
  const leavingIds = new Set(leaving.map((row) => String(row.id)));

  if (!(await knex('permissions').where({ permission_key: GRANT.key }).first('id'))) {
    await knex('permissions').insert({ permission_key: GRANT.key, name: GRANT.name, domain: GRANT.domain });
  }
  const permissionId = (await knex('permissions').where({ permission_key: GRANT.key }).first('id')).id;
  const roles = (await knex('roles').whereIn('code', GRANT.roles).select('id', 'tenant_id')).filter((row) => !leavingIds.has(String(row.tenant_id)));
  if (roles.length === 0) return;
  const already = new Set((await knex('role_permissions').where({ permission_id: permissionId }).select('role_id')).map((row) => String(row.role_id)));
  const toInsert = roles.filter((row) => !already.has(String(row.id))).map((row) => ({ tenant_id: row.tenant_id, role_id: row.id, permission_id: permissionId }));
  if (toInsert.length) await knex('role_permissions').insert(toInsert);
};

exports.down = async function down(knex) {
  const row = await knex('permissions').where({ permission_key: GRANT.key }).first('id');
  if (!row) return;
  await knex('role_permissions').where({ permission_id: row.id }).delete();
  await knex('permissions').where({ permission_key: GRANT.key }).delete();
};
