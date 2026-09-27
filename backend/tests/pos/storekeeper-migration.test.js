'use strict';

/**
 * The storekeeper/stock-transfer migration against tenants in every
 * lifecycle state. It is the one RBAC migration that creates a role from the
 * `tenants` table alone, so it must not write into a tenant being deleted
 * (`purging`) or already deleted (`purged`) — the retention purge guarantees
 * those have no roles or grants left. A re-run must change nothing.
 */

const { useTestApp } = require('../helpers/app');
const migration = require('../../migrations/20261109090000_add_storekeeper_role_and_stock_transfer_permission');

describe('20261109090000 storekeeper role and pos.stock_transfer', () => {
  const t = useTestApp();
  const tenants = {};

  beforeAll(async () => {
    const suffix = Date.now().toString(36);
    for (const status of ['active', 'trial', 'offboarding', 'purging', 'purged']) {
      const [id] = await t.trx('tenants').insert({ name: `Storekeeper ${status}`, slug: `sk-${status}-${suffix}`, status });
      tenants[status] = id;
      // A purged tenant has no roles left; every other state still has its manager.
      if (status !== 'purged') await t.trx('roles').insert({ tenant_id: id, code: 'manager', name: 'Manager', is_system: true });
    }
    await migration.up(t.trx);
  });

  async function state(tenantId) {
    const roles = await t.trx('roles').where({ tenant_id: tenantId }).select('code');
    const grants = await t.trx('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('role_permissions.tenant_id', tenantId)
      .select('roles.code as role', 'permissions.permission_key as key');
    return {
      roles: roles.map((row) => row.code).sort(),
      grants: grants.map((row) => `${row.role}:${row.key}`).sort(),
    };
  }

  test.each(['active', 'trial', 'offboarding'])('a %s tenant gets the Storekeeper role and the transfer grants', async (status) => {
    expect(await state(tenants[status])).toEqual({
      roles: ['manager', 'storekeeper'],
      grants: ['manager:pos.stock_transfer', 'storekeeper:pos.stock_transfer', 'storekeeper:pos.stock_view'],
    });
  });

  test('a purging tenant gets nothing new — not the role, not a grant on its surviving manager role', async () => {
    expect(await state(tenants.purging)).toEqual({ roles: ['manager'], grants: [] });
  });

  test('a purged tenant stays empty', async () => {
    expect(await state(tenants.purged)).toEqual({ roles: [], grants: [] });
  });

  test('running it again changes nothing', async () => {
    const snapshot = async () => {
      const all = [];
      for (const id of Object.values(tenants)) all.push(await state(id)); // sequential: never parallel queries on one transaction
      return all;
    };
    const before = await snapshot();
    await migration.up(t.trx);
    expect(await snapshot()).toEqual(before);
  });
});
