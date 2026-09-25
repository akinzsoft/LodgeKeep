'use strict';

/**
 * The purge plan is PINNED to the live schema. A hand-written deletion order is
 * only safe while it stays true, so this suite reads `information_schema` (the
 * `tests/setup/room-management.test.js` precedent for `ROOM_REFERENCE_TABLES`) and
 * fails the build when:
 *
 *   - a migration adds a foreign key the order violates (a child deleted AFTER its parent)
 *   - a new tenant-owned table has no purge decision (neither purged nor retained)
 *   - the self-reference map drifts from the schema's real self-referencing keys
 *   - a KEPT table gains a foreign key into a purged one that nothing clears
 *
 * Adding a table therefore forces a decision in CI instead of a `ER_ROW_IS_REFERENCED_2`
 * in production, halfway through deleting a customer's data.
 */

const { db } = require('../helpers/db');
const { TABLE_SCOPES, SCOPES } = require('../../src/shared/table-scopes');
const plan = require('../../src/modules/offboarding/purge-plan');
const { purgeQuery } = require('../../src/modules/offboarding/purge');
const { scopedDb } = require('../../src/db');
const { workerContext } = require('../../src/modules/tenancy');
const dbModule = require('../../src/db');

const PLAN_TABLES = new Set(plan.TENANT_PURGE_ORDER);
const RETAINED = new Set(plan.RETAINED_TABLES);

describe('the purge plan against information_schema', () => {
  let foreignKeys;
  let tenantIdTables;
  let primaryKeys;

  beforeAll(async () => {
    const fks = await db().raw(
      `SELECT k.TABLE_NAME child, k.REFERENCED_TABLE_NAME parent, k.CONSTRAINT_NAME name,
              GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) cols, MAX(c.IS_NULLABLE = 'YES') nullable
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.COLUMNS c
           ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
        GROUP BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME`
    );
    foreignKeys = fks[0].map((row) => ({ child: row.child, parent: row.parent, name: row.name, columns: row.cols, nullable: Number(row.nullable) === 1 }));

    const cols = await db().raw("SELECT TABLE_NAME t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id'");
    tenantIdTables = cols[0].map((row) => row.t);

    const pks = await db().raw(
      `SELECT TABLE_NAME t, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) cols
         FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' GROUP BY TABLE_NAME`
    );
    primaryKeys = new Map(pks[0].map((row) => [row.t, row.cols]));
  });

  it('classifies every tenant-owned table declared in table-scopes.js exactly once', () => {
    expect(plan.classifyAllTables()).toEqual({ unclassified: [], both: [], duplicated: [], unknownInPlan: [], ok: true });
  });

  it('accounts for every table that really carries a tenant_id column in the database', () => {
    const unplanned = tenantIdTables.filter((table) => table !== 'tenants' && !PLAN_TABLES.has(table) && !RETAINED.has(table));
    expect(unplanned).toEqual([]);
  });

  it('every planned and retained table exists and is declared in table-scopes.js', () => {
    for (const table of [...PLAN_TABLES, ...RETAINED]) expect(TABLE_SCOPES[table]).toBeDefined();
  });

  it('deletes every child before its parent, for every foreign key among the planned tables', () => {
    const position = new Map(plan.TENANT_PURGE_ORDER.map((table, index) => [table, index]));
    const violations = foreignKeys
      .filter((fk) => fk.child !== fk.parent && position.has(fk.child) && position.has(fk.parent))
      .filter((fk) => position.get(fk.child) > position.get(fk.parent))
      .map((fk) => `${fk.child} (${fk.columns}) -> ${fk.parent}`);
    expect(violations).toEqual([]);
  });

  it('the self-reference map equals the schema’s real self-referencing keys, and each is nullable', () => {
    // A self-reference is a composite key (tenant_id, property_id, <the column>): its own column is the last.
    const selfKeys = foreignKeys.filter((fk) => fk.child === fk.parent);
    expect(Object.fromEntries(selfKeys.map((fk) => [fk.child, fk.columns.split(',').pop()]))).toEqual(plan.SELF_REFERENCES);
    for (const fk of selfKeys) expect(fk.nullable).toBe(true);
  });

  it('a kept table has a foreign key into a purged one ONLY where the purge clears it', () => {
    const blockers = foreignKeys
      .filter((fk) => RETAINED.has(fk.child) && PLAN_TABLES.has(fk.parent))
      .map((fk) => `${fk.child}.${fk.columns} -> ${fk.parent}`);
    // tenant_data_exports.requested_by_user_id is NULLed before users are deleted (CLEARED_TABLES).
    expect(blockers).toEqual(['tenant_data_exports.tenant_id,requested_by_user_id -> users']);
    const cleared = foreignKeys.find((fk) => fk.child === 'tenant_data_exports' && fk.parent === 'users');
    expect(cleared.nullable).toBe(true);
    expect(Object.keys(plan.CLEARED_TABLES.tenant_data_exports.beforeUsers)).toEqual(['requested_by_user_id']);
  });

  it('nothing outside the plan has a foreign key INTO a purged table without also being purged or kept', () => {
    const outsiders = foreignKeys
      .filter((fk) => PLAN_TABLES.has(fk.parent) && !PLAN_TABLES.has(fk.child) && !RETAINED.has(fk.child) && !fk.child.startsWith('knex_'))
      .map((fk) => `${fk.child} -> ${fk.parent}`);
    expect(outsiders).toEqual([]);
  });

  it('the CLEAR of the export requester happens before the users table is reached', () => {
    const position = new Map(plan.TENANT_PURGE_ORDER.map((table, index) => [table, index]));
    expect(position.get(plan.CLEAR_EXPORT_REQUESTER_BEFORE)).toBeLessThan(position.get('users'));
    expect(plan.buildPurgeSteps().find((step) => step.clearExportRequesterBefore).table).toBe(plan.CLEAR_EXPORT_REQUESTER_BEFORE);
  });

  it('every planned table has a single-column primary key named id (the chunked delete relies on it)', () => {
    const wrong = plan.TENANT_PURGE_ORDER.filter((table) => primaryKeys.get(table) !== 'id');
    expect(wrong).toEqual([]);
  });

  it('every hooked column exists on its table', async () => {
    for (const [table, hook] of Object.entries(plan.FILE_HOOKS)) {
      const row = await db().raw('SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, hook.column]);
      expect(Number(row[0][0].n)).toBe(1);
    }
  });

  it('flags a table the plan does not know, an ambiguous one and a duplicate', () => {
    const scopes = { ...TABLE_SCOPES, brand_new_tenant_table: { scope: SCOPES.PROPERTY } };
    expect(plan.classifyAllTables({ tableScopes: scopes }).unclassified).toEqual(['brand_new_tenant_table']);
    expect(plan.classifyAllTables({ retained: [...plan.RETAINED_TABLES, 'users'] }).both).toEqual(['users']);
    expect(plan.classifyAllTables({ order: [...plan.TENANT_PURGE_ORDER, 'users'] }).duplicated).toEqual(['users']);
    expect(plan.classifyAllTables({ order: [...plan.TENANT_PURGE_ORDER, 'ghost'] }).unknownInPlan).toEqual(['ghost']);
    expect(plan.classifyAllTables({ order: plan.TENANT_PURGE_ORDER.slice(1) }).ok).toBe(false);
  });

  it('never plans a GLOBAL_REFERENCE table', () => {
    for (const table of plan.TENANT_PURGE_ORDER) expect(TABLE_SCOPES[table].scope).not.toBe(SCOPES.GLOBAL);
  });
});

describe('purgeQuery — the one door to a table', () => {
  beforeAll(() => dbModule.__setConnectionForTesting(db()));
  afterAll(() => dbModule.__resetForTesting());

  const steps = plan.buildPurgeSteps();
  const tenantId = '424242';
  const scoped = () => scopedDb().for(workerContext({ tenantId }));

  it.each(steps.filter((step) => step.access === 'platform').map((step) => [step.table, step]))(
    'always adds a tenant_id predicate to PLATFORM_SCOPED %s, on select and on delete',
    (_table, step) => {
      const select = purgeQuery(scoped(), step, tenantId).select('id').limit(5).toSQL();
      expect(select.sql).toContain('`tenant_id`');
      expect(select.bindings.map(String)).toContain(tenantId);

      const remove = purgeQuery(scoped(), step, tenantId).whereIn('id', [1, 2]).toSQL();
      expect(remove.sql).toContain('`tenant_id`');
      expect(remove.bindings.map(String)).toContain(tenantId);
    }
  );

  it('scopes every non-platform step to the tenant through the accessor', () => {
    for (const step of steps.filter((s) => s.access !== 'platform')) {
      const query = purgeQuery(scoped(), step, tenantId);
      const { required } = query.appliedScope();
      // `tenants` would need `id`; properties and the rest need `tenant_id`.
      expect(required.some((r) => String(r.value) === tenantId)).toBe(true);
      expect(required.every((r) => r.column !== 'property_id')).toBe(true); // acrossProperties: tenant-wide, never one property
    }
  });

  it('refuses a table that is not in the plan', () => {
    expect(() => purgeQuery(scoped(), { table: 'permissions', access: 'tenant' }, tenantId)).toThrow(/not in the purge plan/);
    expect(() => purgeQuery(scoped(), { table: 'plans', access: 'platform' }, tenantId)).toThrow(/not in the purge plan/);
  });

  it('a PLATFORM_SCOPED table queried without the helper carries NO predicate — which is exactly why the helper exists', () => {
    const bare = scoped().platform().table('auth_events').toSQL();
    expect(bare.sql).not.toContain('tenant_id');
  });

  it('derives how each step reaches its table from the table’s declared scope', () => {
    expect(plan.accessKindFor('auth_events')).toBe('platform');
    expect(plan.accessKindFor('reservations')).toBe('property');
    expect(plan.accessKindFor('users')).toBe('tenant');
    expect(plan.accessKindFor('properties')).toBe('tenant'); // the property scope root needs only tenant_id
    expect(() => plan.accessKindFor('no_such_table')).toThrow(/no scope declaration/);
  });
});
