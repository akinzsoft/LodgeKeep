'use strict';

/**
 * `pos.service_charge.manage` — change an outlet's service charge rate and QR mode (reason required,
 * audited). Granted to every role that holds `pos.manage` today (manager/admin/super_admin on the system
 * roles, and any custom role given it). Backfills existing tenants, skipping tenants being purged.
 */
const KEY = 'pos.service_charge.manage';
const SOURCE_KEY = 'pos.manage';

exports.up = async function up(knex) {
  const existing = await knex('permissions').where({ permission_key: KEY }).first('id');
  if (!existing) {
    await knex('permissions').insert({ permission_key: KEY, name: 'Change an outlet service charge (with a reason)', domain: 'pos' });
  }
  const permissionId = (await knex('permissions').where({ permission_key: KEY }).first('id')).id;
  const source = await knex('permissions').where({ permission_key: SOURCE_KEY }).first('id');
  if (!source) return;

  const leaving = await knex('tenants').whereIn('status', ['purging', 'purged']).select('id');
  const leavingIds = new Set(leaving.map((row) => String(row.id)));

  const holders = (await knex('role_permissions').where({ permission_id: source.id }).select('tenant_id', 'role_id')).filter(
    (row) => !leavingIds.has(String(row.tenant_id))
  );
  if (holders.length === 0) return;

  const already = await knex('role_permissions').where({ permission_id: permissionId }).select('role_id');
  const alreadyGranted = new Set(already.map((row) => String(row.role_id)));
  const toInsert = holders
    .filter((row) => !alreadyGranted.has(String(row.role_id)))
    .map((row) => ({ tenant_id: row.tenant_id, role_id: row.role_id, permission_id: permissionId }));
  if (toInsert.length) await knex('role_permissions').insert(toInsert);
};

exports.down = async function down(knex) {
  const row = await knex('permissions').where({ permission_key: KEY }).first('id');
  if (!row) return;
  await knex('role_permissions').where({ permission_id: row.id }).delete();
  await knex('permissions').where({ permission_key: KEY }).delete();
};
