'use strict';

/**
 * Stock transfer between outlets (user-requested) needs its own permission
 * and a role to hold it.
 *
 * `pos.stock_transfer` — issue stock from one outlet to another, and read
 * the transfer history (quantities only, no cost). A separate key rather
 * than either existing stock key (confirmed with the user): `pos.stock_view`
 * is held by every POS operator, and `pos.stock_manage` also brings item
 * editing, recipes, goods received, stock takes and cost reports.
 *
 * `storekeeper` — a new system role (the eighth; SECURITY.md §5) for the
 * person who runs the store: view stock, record wastage, issue transfers.
 * Not `pos.operate` (a storekeeper does not sell at the Register) and not
 * `pos.stock_manage`. Created here for every existing tenant, because
 * `default-rbac.js` only provisions tenants that sign up after this ships.
 *
 * Grants: storekeeper gets `pos.stock_view` + `pos.stock_transfer`;
 * manager, admin and super_admin get `pos.stock_transfer`.
 *
 * Never writes into a tenant being deleted (`purging`) or already deleted
 * (`purged`): the retention purge guarantees such a tenant's roles and
 * grants are gone, and this is the one kind of migration that creates a
 * row from the `tenants` table alone rather than onto an existing role. An
 * `offboarding` tenant does get the role — it can still be reactivated with
 * all its data, and if it is purged instead, the purge removes the role.
 *
 * Idempotent (every insert is check-first), so a retry after a partial
 * failure completes rather than colliding — the lesson of the shared
 * catalogue migration's own production incident. `down()` removes the
 * grants, then the role (refusing, rather than orphaning access, if any
 * user still holds it), then the key.
 */

const TRANSFER_KEY = 'pos.stock_transfer';
const ROLE_CODE = 'storekeeper';
const STOREKEEPER_KEYS = ['pos.stock_view', TRANSFER_KEY];
const TRANSFER_ROLE_CODES = ['manager', 'admin', 'super_admin', ROLE_CODE];
const DELETED_TENANT_STATUSES = ['purging', 'purged'];

async function grant(knex, roleRows, permissionId) {
  if (!roleRows.length) return;
  const existing = await knex('role_permissions')
    .whereIn('role_id', roleRows.map((row) => row.id))
    .where('permission_id', permissionId)
    .select('role_id');
  const already = new Set(existing.map((row) => String(row.role_id)));
  const rows = roleRows
    .filter((role) => !already.has(String(role.id)))
    .map((role) => ({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permissionId }));
  if (rows.length) await knex('role_permissions').insert(rows);
}

exports.up = async function up(knex) {
  if (!(await knex('permissions').where({ permission_key: TRANSFER_KEY }).first('id'))) {
    await knex('permissions').insert({
      permission_key: TRANSFER_KEY,
      name: 'Transfer stock between outlets',
      domain: 'pos',
    });
  }

  const tenants = await knex('tenants').whereNotIn('status', DELETED_TENANT_STATUSES).select('id');
  const tenantIds = tenants.map((tenant) => tenant.id);
  const withRole = new Set((await knex('roles').where({ code: ROLE_CODE }).select('tenant_id')).map((row) => String(row.tenant_id)));
  const missing = tenants.filter((tenant) => !withRole.has(String(tenant.id)));
  if (missing.length) {
    await knex('roles').insert(
      missing.map((tenant) => ({
        tenant_id: tenant.id,
        code: ROLE_CODE,
        name: 'Storekeeper',
        description: 'Runs the store: views stock, records wastage, and issues stock to other outlets.',
        is_system: true,
        status: 'active',
      })),
    );
  }

  const permissions = await knex('permissions').whereIn('permission_key', STOREKEEPER_KEYS).select('id', 'permission_key');
  const idByKey = new Map(permissions.map((row) => [row.permission_key, row.id]));

  if (!tenantIds.length) return;
  await grant(knex, await knex('roles').whereIn('tenant_id', tenantIds).whereIn('code', TRANSFER_ROLE_CODES).select('id', 'tenant_id'), idByKey.get(TRANSFER_KEY));
  if (idByKey.has('pos.stock_view')) {
    await grant(knex, await knex('roles').whereIn('tenant_id', tenantIds).where({ code: ROLE_CODE }).select('id', 'tenant_id'), idByKey.get('pos.stock_view'));
  }
};

exports.down = async function down(knex) {
  const holders = await knex('user_property_access').where({ role: ROLE_CODE }).count({ n: '*' }).first();
  const invites = await knex('user_invitations').where({ role: ROLE_CODE }).count({ n: '*' }).first();
  if (Number(holders.n) > 0 || Number(invites.n) > 0) {
    throw new Error(`Cannot remove the storekeeper role: ${holders.n} user grant(s) and ${invites.n} invitation(s) still name it. Reassign them first.`);
  }
  await knex('notification_role_rules').where({ role: ROLE_CODE }).delete();
  const roleIds = (await knex('roles').where({ code: ROLE_CODE }).select('id')).map((row) => row.id);
  if (roleIds.length) await knex('role_permissions').whereIn('role_id', roleIds).delete();

  const transfer = await knex('permissions').where({ permission_key: TRANSFER_KEY }).first('id');
  if (transfer) await knex('role_permissions').where({ permission_id: transfer.id }).delete();

  if (roleIds.length) await knex('roles').whereIn('id', roleIds).delete();
  if (transfer) await knex('permissions').where({ id: transfer.id }).delete();
};
