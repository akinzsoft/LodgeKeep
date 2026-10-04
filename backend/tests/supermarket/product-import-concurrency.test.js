'use strict';

/**
 * Supermarket Stage 3 product import under real connections and real
 * commits (a shared rolled-back transaction cannot prove a rollback or a
 * race: there, a nested transaction is the same session).
 *
 *   - ALL OR NOTHING: a failure on the last row leaves nothing at all from
 *     the file; a retried attempt then imports it once.
 *   - Two commits at one property race: exactly one is accepted.
 *   - An import racing a stream of sales at the same till: everything lands,
 *     no deadlock, and every stock level equals its ledger.
 */

jest.mock('../../src/jobs/data-import', () => ({ ...jest.requireActual('../../src/jobs/data-import'), enqueueDataImportJob: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { runImportCommitJob } = require('../../src/jobs/data-import');
const stockService = require('../../src/modules/stock/service');
const { insertMenuItem, insertStockItem } = require('../helpers/catalogue');
const { sumQuantity } = require('../../src/shared/quantity');

const BUSINESS_DATE = '2027-12-01';
const HEADER = 'name,category,price,barcodes,unit,cost_price,opening_stock,reorder_level,supplier';

describe('Supermarket product import: real connections', () => {
  let req;
  let tenantId;
  let propertyId;
  let userId;
  let token;
  let martId;
  let counter = 0;
  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    [tenantId] = await db()('tenants').insert({ name: 'Import Race Tenant', slug: `import-race-${suffix}`, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `import-race-property-${suffix}`,
      name: 'Import Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: BUSINESS_DATE,
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'manager', name: 'manager', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `import-race-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Import',
      last_name: 'Manager',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'manager' });
    const keys = ['pos.operate', 'pos.manage', 'pos.stock_view', 'pos.stock_manage', 'supermarket.sales', 'supermarket.report', 'supermarket.manage'];
    const perms = await db()('permissions').whereIn('permission_key', keys).select('id');
    expect(perms).toHaveLength(keys.length);
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));
    [martId] = await db()('pos_outlets').insert({ tenant_id: tenantId, property_id: propertyId, code: 'MART', name: 'Race Mart', type: 'supermarket' });
    token = signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  });

  afterAll(async () => {
    for (const table of [
      'supermarket_sale_lines', 'supermarket_sales', 'supermarket_receipt_sequences', 'supermarket_barcodes',
      'imported_record_map', 'import_row_errors', 'import_runs',
      'stock_movements', 'pos_menu_item_components', 'stock_levels', 'stock_items', 'stock_item_categories',
      'audit_log', 'idempotency_keys', 'outbox_events', 'pos_order_settlements', 'pos_order_items', 'pos_orders',
      'pos_outlet_menu_items', 'pos_menu_items', 'pos_terminals', 'pos_outlet_categories', 'pos_menu_categories', 'pos_outlets',
      'in_app_notifications', 'user_property_access', 'role_permissions', 'users', 'roles', 'properties',
    ]) {
      await db()(table).where({ tenant_id: tenantId }).delete();
    }
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  afterEach(() => jest.restoreAllMocks());

  const auth = (r) => r.set('Authorization', `Bearer ${token}`).set('Idempotency-Key', `race-${next()}`);
  const csv = (lines) => `${HEADER}\n${lines.join('\n')}\n`;
  async function uploaded(lines) {
    const res = await auth(req.post('/api/v1/supermarket/imports')).field('outlet_id', String(martId)).attach('file', Buffer.from(csv(lines)), 'p.csv');
    expect(res.status).toBe(201);
    expect(res.body.data.summary.errors).toBe(0);
    return res.body.data.run.id;
  }
  const commit = (id) => auth(req.post(`/api/v1/supermarket/imports/${id}/commit`)).send();
  const run = (id) => db()('import_runs').where({ id }).first();

  /** Every row an import could have created, by its own unique names. */
  async function traceOf(names, categories, barcodes) {
    return {
      menuItems: await db()('pos_menu_items').where({ tenant_id: tenantId }).whereIn('name', names),
      stockItems: await db()('stock_items').where({ tenant_id: tenantId }).whereIn('name', names),
      categories: await db()('pos_menu_categories').where({ tenant_id: tenantId }).whereIn('name', categories),
      stockCategories: await db()('stock_item_categories').where({ tenant_id: tenantId }).whereIn('name', categories),
      barcodes: await db()('supermarket_barcodes').where({ tenant_id: tenantId }).whereIn('barcode', barcodes),
    };
  }

  test('a failure on the last row leaves nothing from the file; a later attempt imports it exactly once', async () => {
    const cat = `Mart All ${next()}`;
    const names = [`AON 1 ${next()}`, `AON 2 ${next()}`, `AON 3 ${next()}`];
    const codes = [`A${next()}`, `A${next()}`, `A${next()}`];
    const id = await uploaded(names.map((name, i) => `${name},${cat},10.00,${codes[i]},,6.00,5,,`));
    expect((await commit(id)).status).toBe(202);

    const real = stockService.createStockItem;
    let calls = 0;
    jest.spyOn(stockService, 'createStockItem').mockImplementation(async (args) => {
      calls += 1;
      if (calls === 3) throw new Error('disk on fire');
      return real(args);
    });

    // Not the final attempt: rethrown for BullMQ to retry, the run stays committing.
    await expect(runImportCommitJob({ tenantId, importRunId: id, attemptsMade: 0, maxAttempts: 3 })).rejects.toThrow('disk on fire');
    expect((await run(id)).status).toBe('committing');
    const empty = await traceOf(names, [cat], codes);
    expect(empty).toEqual({ menuItems: [], stockItems: [], categories: [], stockCategories: [], barcodes: [] });
    expect(await db()('stock_movements').where({ reference: `IMPORT-${id}` })).toEqual([]);
    expect(await db()('imported_record_map').where({ import_run_id: id })).toEqual([]);

    // The retry imports everything, once.
    jest.restoreAllMocks();
    await runImportCommitJob({ tenantId, importRunId: id, attemptsMade: 1, maxAttempts: 3 });
    expect((await run(id)).status).toBe('completed');
    const full = await traceOf(names, [cat], codes);
    expect(full.menuItems).toHaveLength(3);
    expect(full.stockItems).toHaveLength(3);
    expect(full.categories).toHaveLength(1);
    expect(full.barcodes).toHaveLength(3);
    expect(await db()('stock_movements').where({ reference: `IMPORT-${id}` })).toHaveLength(3);

    // A run already completed is a no-op if the job fires again.
    await runImportCommitJob({ tenantId, importRunId: id });
    expect((await traceOf(names, [cat], codes)).menuItems).toHaveLength(3);
  });

  test('the final failed attempt marks the run failed with nothing imported', async () => {
    const name = `Final ${next()}`;
    const id = await uploaded([`${name},Mart Final ${next()},10.00,,,,,,`]);
    expect((await commit(id)).status).toBe(202);
    jest.spyOn(stockService, 'createStockItem').mockRejectedValue(new Error('still on fire'));
    await expect(runImportCommitJob({ tenantId, importRunId: id, attemptsMade: 2, maxAttempts: 3 })).rejects.toThrow('still on fire');
    const failed = await run(id);
    expect(failed.status).toBe('failed');
    expect(failed.failed_reason).toBe('still on fire');
    expect(await db()('pos_menu_items').where({ tenant_id: tenantId, name })).toEqual([]);
  });

  test.each([1, 2, 3])('two commits at one property race: exactly one is accepted (round %i)', async () => {
    const first = await uploaded([`R1 ${next()},Mart R ${next()},1.00,,,,,,`]);
    const second = await uploaded([`R2 ${next()},Mart R ${next()},1.00,,,,,,`]);
    const results = await Promise.all([commit(first), commit(second)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    const accepted = results[0].status === 202 ? first : second;
    await runImportCommitJob({ tenantId, importRunId: accepted });
    expect((await run(accepted)).status).toBe('completed');
    // The refused one can commit once the slot is free.
    const refused = accepted === first ? second : first;
    expect((await commit(refused)).status).toBe(202);
    await runImportCommitJob({ tenantId, importRunId: refused });
    expect((await run(refused)).status).toBe('completed');
  });

  test.each([1, 2, 3])('an import racing sales at the same till: all land, no deadlock, ledgers consistent (round %i)', async () => {
    // A product already on sale at the mart, with stock.
    const barcode = `S${next()}`;
    const [menuItemId] = await insertMenuItem(db(), { tenant_id: tenantId, property_id: propertyId, outlet_id: martId, name: `On sale ${next()}`, category: `Mart Old ${next()}`, price: '5.00' });
    const [stockItemId] = await insertStockItem(db(), { tenant_id: tenantId, property_id: propertyId, name: `On sale stock ${next()}`, unit: 'pcs', purchase_cost: '2.00' });
    await db()('pos_menu_item_components').insert({ tenant_id: tenantId, property_id: propertyId, menu_item_id: menuItemId, stock_item_id: stockItemId, quantity: '1.000' });
    await db()('supermarket_barcodes').insert({ tenant_id: tenantId, property_id: propertyId, menu_item_id: menuItemId, barcode });
    const received = await auth(req.post('/api/v1/pos/stock/goods-received')).send({ outlet_id: martId, lines: [{ stock_item_id: stockItemId, quantity: '50', unit_cost: '2.00' }] });
    expect(received.status).toBe(201);

    const names = Array.from({ length: 20 }, (_, i) => `Bulk ${i} ${next()}`);
    const id = await uploaded(names.map((name) => `${name},Mart Bulk ${counter},3.00,B${next()},,1.50,10,2,`));
    expect((await commit(id)).status).toBe(202);

    const sale = () => auth(req.post('/api/v1/supermarket/sales')).send({ outlet_id: martId, method: 'cash', items: [{ barcode, quantity: 1 }] });
    const [, ...sales] = await Promise.all([runImportCommitJob({ tenantId, importRunId: id }), sale(), sale(), sale(), sale(), sale()]);
    expect(sales.map((s) => s.status)).toEqual([201, 201, 201, 201, 201]);
    expect((await run(id)).status).toBe('completed');

    const levels = await db()('stock_levels').where({ tenant_id: tenantId, outlet_id: martId });
    for (const level of levels) {
      const ledger = await db()('stock_movements').where({ stock_item_id: level.stock_item_id, outlet_id: martId }).select('quantity');
      expect(level.current_quantity).toBe(sumQuantity(ledger.map((m) => m.quantity)));
    }
    expect((await db()('stock_levels').where({ outlet_id: martId, stock_item_id: stockItemId }).first()).current_quantity).toBe('45.000');
  });
});
