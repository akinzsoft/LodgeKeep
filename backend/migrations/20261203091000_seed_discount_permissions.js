'use strict';

/**
 * Discount and comp permissions (PR 1): `discount.apply` (give a discount within your limit), `discount.approve`
 * (approve one above a limit, with your PIN), `discount.comp` (apply or approve a 100% comp), `discount.manage`
 * (reasons and role limits) and `reports.view_discounts`. Backfills existing tenants' roles and skips tenants being
 * purged or already purged. Default reasons are seeded lazily the first time a property lists them.
 */

const GRANTS = [
  { key: 'discount.apply', name: 'Give a discount within your limit', domain: 'discount', roles: ['pos_operator', 'manager', 'admin', 'super_admin'] },
  { key: 'discount.approve', name: 'Approve a discount above a limit with a PIN', domain: 'discount', roles: ['manager', 'admin', 'super_admin'] },
  { key: 'discount.comp', name: 'Apply or approve a comp (100% discount)', domain: 'discount', roles: ['manager', 'admin', 'super_admin'] },
  { key: 'discount.manage', name: 'Manage discount reasons and role limits', domain: 'discount', roles: ['manager', 'admin', 'super_admin'] },
  { key: 'reports.view_discounts', name: 'View the discounts and comps report', domain: 'reports', roles: ['manager', 'admin', 'super_admin'] },
];

exports.up = async function up(knex) {
  const leaving = await knex('tenants').whereIn('status', ['purging', 'purged']).select('id');
  const leavingIds = new Set(leaving.map((row) => String(row.id)));

  for (const grant of GRANTS) {
    if (!(await knex('permissions').where({ permission_key: grant.key }).first('id'))) {
      await knex('permissions').insert({ permission_key: grant.key, name: grant.name, domain: grant.domain });
    }
    const permissionId = (await knex('permissions').where({ permission_key: grant.key }).first('id')).id;
    const roles = (await knex('roles').whereIn('code', grant.roles).select('id', 'tenant_id')).filter((row) => !leavingIds.has(String(row.tenant_id)));
    if (roles.length === 0) continue;
    const already = new Set((await knex('role_permissions').where({ permission_id: permissionId }).select('role_id')).map((row) => String(row.role_id)));
    const toInsert = roles.filter((row) => !already.has(String(row.id))).map((row) => ({ tenant_id: row.tenant_id, role_id: row.id, permission_id: permissionId }));
    if (toInsert.length) await knex('role_permissions').insert(toInsert);
  }
};

exports.down = async function down(knex) {
  for (const grant of GRANTS) {
    const row = await knex('permissions').where({ permission_key: grant.key }).first('id');
    if (!row) continue;
    await knex('role_permissions').where({ permission_id: row.id }).delete();
    await knex('permissions').where({ permission_key: grant.key }).delete();
  }
};
