'use strict';

/**
 * `pos.stock_request` — ask another outlet (normally the store) for stock,
 * and withdraw a request of your own outlet's while it is still pending.
 * Confirmed with the user: POS operators and managers raise requests; the
 * Storekeeper issues them (through `pos.stock_transfer`, which this does not
 * change) and does not raise them. So the key goes to pos_operator,
 * manager, admin and super_admin — not storekeeper.
 *
 * Seeded for every existing tenant except `purging`/`purged` ones — the
 * retention purge guarantees those hold no roles or grants, the same rule
 * `20261109090000`'s Storekeeper migration follows. Idempotent (check
 * before every insert) so a retry after a partial failure completes;
 * `down()` removes the grants and the key.
 */

const KEY = 'pos.stock_request';
const ROLE_CODES = ['pos_operator', 'manager', 'admin', 'super_admin'];
const DELETED_TENANT_STATUSES = ['purging', 'purged'];

exports.up = async function up(knex) {
  if (!(await knex('permissions').where({ permission_key: KEY }).first('id'))) {
    await knex('permissions').insert({ permission_key: KEY, name: 'Request stock from another outlet', domain: 'pos' });
  }
  const permission = await knex('permissions').where({ permission_key: KEY }).first('id');

  const tenantIds = (await knex('tenants').whereNotIn('status', DELETED_TENANT_STATUSES).select('id')).map((row) => row.id);
  if (!tenantIds.length) return;
  const roles = await knex('roles').whereIn('tenant_id', tenantIds).whereIn('code', ROLE_CODES).select('id', 'tenant_id');
  if (!roles.length) return;

  const already = new Set(
    (await knex('role_permissions').whereIn('role_id', roles.map((role) => role.id)).where({ permission_id: permission.id }).select('role_id')).map((row) =>
      String(row.role_id),
    ),
  );
  const rows = roles
    .filter((role) => !already.has(String(role.id)))
    .map((role) => ({ tenant_id: role.tenant_id, role_id: role.id, permission_id: permission.id }));
  if (rows.length) await knex('role_permissions').insert(rows);
};

exports.down = async function down(knex) {
  const permission = await knex('permissions').where({ permission_key: KEY }).first('id');
  if (!permission) return;
  await knex('role_permissions').where({ permission_id: permission.id }).delete();
  await knex('permissions').where({ id: permission.id }).delete();
};
