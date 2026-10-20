'use strict';

/**
 * `discount.voucher_delete`: delete a voucher that has never been put on a check. super_admin ONLY: seeded to the
 * super_admin role alone, never to admin, manager or holders of `discount.manage`. Backfills existing tenants'
 * super_admin roles, skipping tenants being purged or already purged.
 */

const KEY = 'discount.voucher_delete';

exports.up = async function up(knex) {
  const existing = await knex('permissions').where({ permission_key: KEY }).first('id');
  if (!existing) {
    await knex('permissions').insert({ permission_key: KEY, name: 'Delete a voucher that has never been used', domain: 'discount' });
  }
  const permissionId = (await knex('permissions').where({ permission_key: KEY }).first('id')).id;

  const leaving = await knex('tenants').whereIn('status', ['purging', 'purged']).select('id');
  const leavingIds = new Set(leaving.map((row) => String(row.id)));
  const roles = (await knex('roles').where({ code: 'super_admin' }).select('id', 'tenant_id')).filter((row) => !leavingIds.has(String(row.tenant_id)));
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
