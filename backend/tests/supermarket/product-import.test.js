'use strict';

/**
 * Supermarket Stage 3: bulk CSV product import over HTTP — upload and dry run,
 * commit (the job run directly), what a committed import creates, the
 * commit refusing a dry run with errors or data that changed meanwhile, undo
 * (untouched products removed, touched ones refused), access rules, and the
 * generic /migration routes refusing these runs. The all-or-nothing rollback
 * and the one-commit-per-property race need real connections and are in
 * product-import-concurrency.test.js.
 */

jest.mock('../../src/jobs/data-import', () => ({ ...jest.requireActual('../../src/jobs/data-import'), enqueueDataImportJob: jest.fn().mockResolvedValue() }));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { runImportCommitJob } = require('../../src/jobs/data-import');
const { insertMenuItem } = require('../helpers/catalogue');
const { MENU_ITEM_REFERENCE_TABLES, STOCK_ITEM_REFERENCE_TABLES, commitProducts, dryRunProducts } = require('../../src/modules/supermarket/product-import');
const { scopedDb } = require('../../src/db');
const { workerContext } = require('../../src/modules/tenancy');

const HEADER = 'name,category,price,barcodes,unit,cost_price,opening_stock,reorder_level,supplier';

describe('supermarket product import', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let outletId;
  let users;
  let counter = 0;
  const DATE = '2027-11-01';

  const next = () => `${Date.now().toString(36)}${(counter += 1)}`;
  const tokenFor = (userId, tenant = ctx.a, property = propertyId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(property) });
  const as = (userId, tenant, property) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId, tenant, property)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId, tenant, property)}`).set('Idempotency-Key', `pi-${next()}`),
  });
  const csv = (lines) => `${HEADER}\n${lines.join('\n')}\n`;
  const upload = (content, { userId = users.manager, outlet = outletId, filename = 'products.csv' } = {}) =>
    as(userId).post('/api/v1/supermarket/imports').field('outlet_id', String(outlet)).attach('file', Buffer.from(content, 'utf8'), filename);
  const commit = (id, userId = users.manager) => as(userId).post(`/api/v1/supermarket/imports/${id}/commit`).send();
  const undo = (id, reason = 'Wrong price list', userId = users.manager) => as(userId).post(`/api/v1/supermarket/imports/${id}/rollback`).send({ reason });
  const run = (id) => t.trx('import_runs').where({ id }).first();

  /** Upload, then commit and run the job directly; returns the run id. */
  async function importFile(content) {
    const res = await upload(content);
    expect(res.status).toBe(201);
    expect(res.body.data.summary.errors).toBe(0);
    const id = res.body.data.run.id;
    expect((await commit(id)).status).toBe(202);
    await runImportCommitJob({ tenantId: ctx.a.id, importRunId: id });
    expect((await run(id)).status).toBe('completed');
    return id;
  }

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }
  async function newOutlet(type, name) {
    const [id] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `T${next()}`.slice(0, 30), name, type });
    return id;
  }
  const productByName = (name) => t.trx('pos_menu_items').where({ tenant_id: ctx.a.id, property_id: propertyId, name }).first();

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: DATE });
    users = { manager: ctx.a.users[0].id, operator: ctx.a.users[1].id };
    await setRole(users.manager, 'manager');
    await setRole(users.operator, 'pos_operator');
    outletId = await newOutlet('supermarket', 'Import Mart');
  });

  describe('template and upload', () => {
    it('downloads the template with an example row', async () => {
      const res = await as(users.manager).get('/api/v1/supermarket/imports/template');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text.split('\n')[0]).toBe(HEADER);
      expect(res.text.split('\n')[1]).toContain('Coca-Cola');
    });

    it('refuses a file that is not the template, before any run exists, and leaves no file behind', async () => {
      const before = await t.trx('import_runs').count({ n: '*' }).first();
      const typo = await upload('name,category,price,barcode\nA,Mart X,1.00,123\n');
      expect(typo.status).toBe(400);
      expect(typo.body.error.message).toContain('unknown column(s): barcode');
      const missing = await upload('name,price\nA,1.00\n');
      expect(missing.status).toBe(400);
      expect(missing.body.error.details.missing).toEqual(['category']);
      const repeated = await upload('name,category,price,Price\nA,Mart X,1.00,2.00\n');
      expect(repeated.status).toBe(400);
      expect(repeated.body.error.details.repeated).toEqual(['price']);
      const empty = await upload(`${HEADER}\n`);
      expect(empty.status).toBe(400);
      expect((await t.trx('import_runs').count({ n: '*' }).first()).n).toBe(before.n);
    });

    it('accepts headers in any case and order, and runs the dry run straight away (writing only findings)', async () => {
      const content = `PRICE, Name ,Category\n10.00,Loose Sweets ${next()},Mart Sweets ${next()}\n`;
      const itemsBefore = await t.trx('pos_menu_items').count({ n: '*' }).first();
      const res = await upload(content);
      expect(res.status).toBe(201);
      expect(res.body.data.run).toMatchObject({ status: 'dry_run_complete', entity_type: 'supermarket_products', outlet_id: String(outletId), rows_total: 1 });
      expect(res.body.data.summary).toMatchObject({ products: 1, categoriesToCreate: 1, errors: 0, warnings: 2 });
      expect(res.body.data.errors.map((f) => f.severity)).toEqual(['warning', 'warning']);
      expect((await t.trx('pos_menu_items').count({ n: '*' }).first()).n).toBe(itemsBefore.n);
    });
  });

  describe('commit', () => {
    it('creates the category, products, barcodes, stock items, recipes and opening stock at the outlet', async () => {
      const cat = `Mart Drinks ${next()}`;
      const coke = `Coke 50cl ${next()}`;
      const water = `Water 75cl ${next()}`;
      const b1 = `C${next()}`;
      const b2 = `C${next()}`;
      const id = await importFile(csv([`${coke},${cat},500.00,${b1}|${b2},bottle,380.00,48,12,NBC`, `${water},${cat},200.00,,bottle,,,,`]));

      const category = await t.trx('pos_menu_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: cat }).first();
      expect(category).toBeTruthy();
      expect(await t.trx('stock_item_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: cat }).first()).toBeTruthy();
      expect(await t.trx('pos_outlet_categories').where({ outlet_id: outletId, category_id: category.id }).first()).toBeTruthy();

      const item = await productByName(coke);
      expect(item).toMatchObject({ category: cat, price: '500.00', cost_price: '380.00', status: 'active' });
      expect((await t.trx('supermarket_barcodes').where({ menu_item_id: item.id }).orderBy('id')).map((r) => r.barcode)).toEqual([b1, b2]);
      const [component] = await t.trx('pos_menu_item_components').where({ menu_item_id: item.id });
      expect(component.quantity).toBe('1.000');
      const stock = await t.trx('stock_items').where({ id: component.stock_item_id }).first();
      expect(stock).toMatchObject({ name: coke, unit: 'bottle', category: cat, purchase_cost: '380.00', supplier: 'NBC', current_quantity: '48.000' });
      const level = await t.trx('stock_levels').where({ outlet_id: outletId, stock_item_id: stock.id }).first();
      expect(level).toMatchObject({ current_quantity: '48.000', reorder_level: '12.000' });
      const [movement] = await t.trx('stock_movements').where({ stock_item_id: stock.id });
      expect(movement).toMatchObject({ type: 'received', quantity: '48.000', unit_cost: '380.00', reference: `IMPORT-${id}`, outlet_id: String(outletId), user_id: String(users.manager) });
      expect(String(movement.business_date).slice(0, 10)).toBe(DATE);

      // No opening stock: a level row at the outlet, no movement.
      const waterItem = await productByName(water);
      const [waterComponent] = await t.trx('pos_menu_item_components').where({ menu_item_id: waterItem.id });
      expect(await t.trx('stock_movements').where({ stock_item_id: waterComponent.stock_item_id }).first()).toBeUndefined();
      expect(await t.trx('stock_levels').where({ outlet_id: outletId, stock_item_id: waterComponent.stock_item_id }).first()).toMatchObject({ current_quantity: '0.000' });

      const mapRows = await t.trx('imported_record_map').where({ import_run_id: id });
      expect(mapRows.map((r) => r.entity_type).sort()).toEqual(['menu_category', 'menu_item', 'menu_item', 'stock_category', 'stock_item', 'stock_item']);
      const audit = await t.trx('audit_log').where({ entity_type: 'import_runs', entity_id: id, action: 'supermarket_products_import' }).first();
      expect(audit).toBeTruthy();

      // The till can scan and sell it, and the sale deducts from the imported stock.
      const sale = await as(users.operator).post('/api/v1/supermarket/sales').send({ outlet_id: outletId, method: 'cash', items: [{ barcode: b2, quantity: 2 }] });
      expect(sale.status).toBe(201);
      expect((await t.trx('stock_levels').where({ id: level.id }).first()).current_quantity).toBe('46.000');

      // No low-stock or out-of-stock bell for the import itself.
      const bells = await t.trx('in_app_notifications').where({ tenant_id: ctx.a.id }).whereRaw("JSON_EXTRACT(payload, '$.stockItemId') = ?", [stock.id]);
      expect(bells).toEqual([]);

      const summary = await as(users.manager).get(`/api/v1/supermarket/imports/${id}`);
      expect(summary.body.data.summary).toEqual({ kind: 'imported', products: 2, categoriesCreated: 1 });
    });

    it('refuses to commit while the dry run has any error (all or nothing)', async () => {
      const res = await upload(csv([`Good ${next()},Mart Ok ${next()},1.00,,,,,,`, `Bad ${next()},Mart Ok,abc,,,,,,`]));
      expect(res.body.data.summary.errors).toBe(1);
      const refused = await commit(res.body.data.run.id);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('BUSINESS_RULE_PRODUCT_IMPORT_HAS_ERRORS');
      expect((await run(res.body.data.run.id)).status).toBe('dry_run_complete');
    });

    it('fails the run, creating nothing, when a barcode is registered by hand between the dry run and the commit', async () => {
      const barcode = `R${next()}`;
      const name = `Raced ${next()}`;
      const res = await upload(csv([`${name},Mart Race ${next()},1.00,${barcode},,,,,`]));
      const id = res.body.data.run.id;
      const [other] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `Other ${next()}`, category: 'Race Other', price: '1.00' });
      expect((await as(users.manager).post('/api/v1/supermarket/barcodes').send({ menu_item_id: other, barcode })).status).toBe(201);

      expect((await commit(id)).status).toBe(202);
      await runImportCommitJob({ tenantId: ctx.a.id, importRunId: id });
      const failed = await run(id);
      expect(failed.status).toBe('failed');
      expect(failed.failed_reason).toContain('The data changed since the dry run');
      expect(await productByName(name)).toBeUndefined();
      const findings = await t.trx('import_row_errors').where({ import_run_id: id, severity: 'error' });
      expect(findings[0].message).toContain(`"${barcode}" already belongs to`);
      expect(await t.trx('audit_log').where({ entity_type: 'import_runs', entity_id: id, action: 'supermarket_products_import_failed' }).first()).toBeTruthy();
      // A failed run is final: no second commit.
      expect((await commit(id)).status).toBe(422);
    });

    it('blocks a category the Bar already carries', async () => {
      const bar = await newOutlet('bar', `Import Bar ${next()}`);
      const shared = `Drinks ${next()}`;
      await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: bar, name: `Cocktail ${next()}`, category: shared, price: '9.00' });
      const res = await upload(csv([`Juice ${next()},${shared},3.00,,,,,,`]));
      expect(res.body.data.errors.find((f) => f.severity === 'error').message).toContain(`is sold at Import Bar`);
    });

    it('refuses a second commit at the property while one is committing', async () => {
      const first = await upload(csv([`One ${next()},Mart Q ${next()},1.00,,,,,,`]));
      const second = await upload(csv([`Two ${next()},Mart Q2 ${next()},1.00,,,,,,`]));
      expect((await commit(first.body.data.run.id)).status).toBe(202);
      const blocked = await commit(second.body.data.run.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CONFLICT_PRODUCT_IMPORT_IN_PROGRESS');
      await runImportCommitJob({ tenantId: ctx.a.id, importRunId: first.body.data.run.id });
      expect((await commit(second.body.data.run.id)).status).toBe(202);
      await runImportCommitJob({ tenantId: ctx.a.id, importRunId: second.body.data.run.id });
      expect((await run(second.body.data.run.id)).status).toBe('completed');
    });

    it('refuses a dry run of a run that is already committing, leaving it committing', async () => {
      const res = await upload(csv([`Busy ${next()},Mart B ${next()},1.00,,,,,,`]));
      const id = res.body.data.run.id;
      expect((await commit(id)).status).toBe(202);
      const again = await as(users.manager).post(`/api/v1/supermarket/imports/${id}/dry-run`).send();
      expect(again.status).toBe(422);
      expect((await run(id)).status).toBe('committing');
      // The race itself: a dry run that read the run before the commit claimed it re-checks under the row lock.
      const staleCopy = { ...(await run(id)), status: 'dry_run_complete' };
      await expect(dryRunProducts({ context: workerContext({ tenantId: ctx.a.id, propertyId }), run: staleCopy })).rejects.toMatchObject({ code: 'BUSINESS_RULE_INVALID_IMPORT_RUN_STATE' });
      expect((await run(id)).status).toBe('committing');
      await runImportCommitJob({ tenantId: ctx.a.id, importRunId: id });
    });

    it('rolls back a job that finishes after its run was released as stuck', async () => {
      const name = `Late ${next()}`;
      const res = await upload(csv([`${name},Mart L ${next()},1.00,,,,,,`]));
      const id = res.body.data.run.id;
      expect((await commit(id)).status).toBe(202);
      const committingRun = await run(id);
      await t.trx('import_runs').where({ id }).update({ status: 'failed' }); // released meanwhile
      const context = workerContext({ tenantId: ctx.a.id, propertyId });
      await expect(scopedDb().for(context).transaction((trx) => commitProducts({ trx, context, run: committingRun }))).rejects.toMatchObject({ code: 'CONFLICT_PRODUCT_IMPORT_RELEASED' });
      expect((await run(id)).status).toBe('failed');
    });

    it('releases a product import stuck committing for over 30 minutes', async () => {
      const stuck = await upload(csv([`Stuck ${next()},Mart S ${next()},1.00,,,,,,`]));
      const fresh = await upload(csv([`Fresh ${next()},Mart F ${next()},1.00,,,,,,`]));
      await t.trx('import_runs').where({ id: stuck.body.data.run.id }).update({ status: 'committing', updated_at: new Date(Date.now() - 31 * 60 * 1000) });
      expect((await commit(fresh.body.data.run.id)).status).toBe(202);
      const released = await run(stuck.body.data.run.id);
      expect(released.status).toBe('failed');
      expect(released.failed_reason).toContain('Released automatically');
      await runImportCommitJob({ tenantId: ctx.a.id, importRunId: fresh.body.data.run.id });
    });
  });

  describe('undo', () => {
    it('removes an untouched import completely, its new category included, and keeps a category that existed before', async () => {
      const existing = `Mart Existing ${next()}`;
      await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `Kept ${next()}`, category: existing, price: '1.00' });
      const fresh = `Mart Fresh ${next()}`;
      const a = `Undo A ${next()}`;
      const b = `Undo B ${next()}`;
      const id = await importFile(csv([`${a},${fresh},2.00,U${next()},,1.00,5,,`, `${b},${existing},2.00,,,,,,`]));
      // An edit to price and name does not count as touched.
      const itemA = await productByName(a);
      await t.trx('pos_menu_items').where({ id: itemA.id }).update({ price: '2.50', name: `${a} renamed` });

      const res = await undo(id);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'rolled_back', rowsRolledBack: 2, rowsRefused: [] });
      expect(await t.trx('pos_menu_items').where({ id: itemA.id }).first()).toBeUndefined();
      expect(await productByName(b)).toBeUndefined();
      expect(await t.trx('stock_movements').where({ reference: `IMPORT-${id}` }).first()).toBeUndefined();
      expect(await t.trx('pos_menu_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: fresh }).first()).toBeUndefined();
      expect(await t.trx('stock_item_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: fresh }).first()).toBeUndefined();
      expect(await t.trx('pos_menu_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: existing }).first()).toBeTruthy();
      expect(await t.trx('imported_record_map').where({ import_run_id: id })).toEqual([]);
      const audit = await t.trx('audit_log').where({ entity_type: 'import_runs', entity_id: id, action: 'rollback' }).first();
      expect(audit.reason).toBe('Wrong price list');
      // Nothing left to undo.
      expect((await undo(id)).status).toBe(422);
    });

    it('removes the stock category it registered, but never one that existed before the import', async () => {
      const preStock = `Mart PreStock ${next()}`;
      await t.trx('stock_item_categories').insert({ tenant_id: ctx.a.id, property_id: propertyId, name: preStock });
      const fresh = `Mart Twin ${next()}`;
      const id = await importFile(csv([`P1 ${next()},${preStock},1.00,,,,,,`, `P2 ${next()},${fresh},1.00,,,,,,`]));
      expect((await t.trx('imported_record_map').where({ import_run_id: id, entity_type: 'stock_category' })).length).toBe(1);
      const res = await undo(id);
      expect(res.body.data).toMatchObject({ status: 'rolled_back', rowsRefused: [] });
      expect(await t.trx('stock_item_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: preStock }).first()).toBeTruthy();
      expect(await t.trx('stock_item_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: fresh }).first()).toBeUndefined();
      expect(await t.trx('pos_menu_categories').where({ tenant_id: ctx.a.id, property_id: propertyId, name: preStock }).first()).toBeUndefined();
    });

    it('refuses a sold product and one with a changed barcode set, still removing the untouched one', async () => {
      const cat = `Mart Mixed ${next()}`;
      const sold = `Sold ${next()}`;
      const rebarcoded = `Rebarcoded ${next()}`;
      const untouched = `Untouched ${next()}`;
      const soldCode = `S${next()}`;
      const id = await importFile(csv([`${sold},${cat},3.00,${soldCode},,1.00,10,,`, `${rebarcoded},${cat},3.00,,,,,,`, `${untouched},${cat},3.00,,,,,,`]));
      expect((await as(users.operator).post('/api/v1/supermarket/sales').send({ outlet_id: outletId, method: 'cash', items: [{ barcode: soldCode, quantity: 1 }] })).status).toBe(201);
      const reItem = await productByName(rebarcoded);
      expect((await as(users.manager).post('/api/v1/supermarket/barcodes').send({ menu_item_id: reItem.id, barcode: `N${next()}` })).status).toBe(201);

      const res = await undo(id);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('partially_rolled_back');
      expect(res.body.data.rowsRolledBack).toBe(1);
      const reasons = Object.fromEntries(res.body.data.rowsRefused.map((r) => [r.name ?? r.entityType, r.reason]));
      expect(reasons[sold]).toContain('sold');
      expect(reasons[rebarcoded]).toContain('barcodes have changed');
      expect(reasons.menu_category).toContain('still used');
      expect(reasons.stock_category).toContain('still used');
      expect(await productByName(untouched)).toBeUndefined();
      expect(await productByName(sold)).toBeTruthy();
    });

    it('refuses a product rung on a tab that is still open (no sale, no stock moved yet)', async () => {
      const name = `On tab ${next()}`;
      const id = await importFile(csv([`${name},Mart T ${next()},3.00,,,1.00,10,,`]));
      const item = await productByName(name);
      const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `TAB-${next()}` });
      const tab = await as(users.manager).post('/api/v1/pos/orders').send({ outlet_id: outletId, terminal_id: terminalId });
      expect(tab.status).toBe(201);
      expect((await as(users.manager).post(`/api/v1/pos/orders/${tab.body.data.id}/items`).send({ menu_item_id: item.id, quantity: 1 })).status).toBe(200);
      const res = await undo(id);
      expect(res.body.data.rowsRefused[0].reason).toContain('rung on a tab');
    });

    it('refuses a product whose stock has moved (wastage)', async () => {
      const name = `Wasted ${next()}`;
      const id = await importFile(csv([`${name},Mart W ${next()},3.00,,,1.00,10,,`]));
      const item = await productByName(name);
      const [component] = await t.trx('pos_menu_item_components').where({ menu_item_id: item.id });
      const wasted = await as(users.manager).post(`/api/v1/pos/stock/items/${component.stock_item_id}/wastage`).send({ outlet_id: outletId, quantity: '1', reason: 'Broken' });
      expect(wasted.status).toBe(200);
      const res = await undo(id);
      expect(res.body.data.rowsRefused[0].reason).toContain('stock has moved');
    });

    it('requires a reason', async () => {
      const id = await importFile(csv([`Reasonless ${next()},Mart R ${next()},1.00,,,,,,`]));
      expect((await undo(id, '   ')).status).toBe(400);
    });
  });

  describe('undo covers every reference', () => {
    it.each([
      ['pos_menu_items', MENU_ITEM_REFERENCE_TABLES],
      ['stock_items', STOCK_ITEM_REFERENCE_TABLES],
    ])('undo knows every table with a foreign key to %s (a new one fails here until undo handles it)', async (parent, known) => {
      const [rows] = await t.trx.raw(
        'SELECT DISTINCT TABLE_NAME AS child FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ? ORDER BY TABLE_NAME',
        [parent]
      );
      expect(rows.map((row) => row.child).sort()).toEqual(Object.keys(known).sort());
    });
  });

  describe('access', () => {
    it('refuses every import route to a role without supermarket.manage', async () => {
      const id = (await upload(csv([`Gate ${next()},Mart G ${next()},1.00,,,,,,`]))).body.data.run.id;
      const op = as(users.operator);
      expect((await op.get('/api/v1/supermarket/imports/template')).status).toBe(403);
      expect((await op.get(`/api/v1/supermarket/imports?outlet_id=${outletId}`)).status).toBe(403);
      expect((await upload(csv(['A,Mart,1.00,,,,,,']), { userId: users.operator })).status).toBe(403);
      expect((await op.get(`/api/v1/supermarket/imports/${id}`)).status).toBe(403);
      expect((await op.post(`/api/v1/supermarket/imports/${id}/commit`).send()).status).toBe(403);
      expect((await op.post(`/api/v1/supermarket/imports/${id}/rollback`).send({ reason: 'x' })).status).toBe(403);
    });

    it('refuses a non-supermarket outlet', async () => {
      const bar = await newOutlet('bar', `Upload Bar ${next()}`);
      expect((await upload(csv([`X ${next()},Mart X,1.00,,,,,,`]), { outlet: bar })).status).toBe(422);
    });

    it("answers 404 for another tenant's run and for a run of another entity type", async () => {
      const id = (await upload(csv([`Iso ${next()},Mart I ${next()},1.00,,,,,,`]))).body.data.run.id;
      const other = as(ctx.b.users[0].id, ctx.b, ctx.b.properties[0].id);
      expect((await other.get(`/api/v1/supermarket/imports/${id}`)).status).toBe(404);
      const [guestsRun] = await t.trx('import_runs').insert({ tenant_id: ctx.a.id, entity_type: 'guests', status: 'uploaded', original_filename: 'g.csv', file_path: '/nonexistent', run_by_user_id: users.manager });
      expect((await as(users.manager).get(`/api/v1/supermarket/imports/${guestsRun}`)).status).toBe(404);
    });

    it('lets /migration list and read a product run but act on none of it', async () => {
      const id = (await upload(csv([`Mig ${next()},Mart M ${next()},1.00,,,,,,`]))).body.data.run.id;
      await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, user_id: ctx.a.users[1].id, property_id: ctx.a.properties[1].id, role: 'admin' });
      const admin = as(ctx.a.users[1].id, ctx.a, ctx.a.properties[1].id);
      expect((await admin.get('/api/v1/migration/imports?entity_type=supermarket_products')).body.data.map((r) => r.id)).toContain(id);
      expect((await admin.get(`/api/v1/migration/imports/${id}`)).status).toBe(200);
      for (const path of ['dry-run', 'commit']) {
        const res = await admin.post(`/api/v1/migration/imports/${id}/${path}`).send();
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_USE_SUPERMARKET_IMPORT');
      }
      expect((await admin.post(`/api/v1/migration/imports/${id}/rollback`).send({ reason: 'x' })).status).toBe(403);
      const direct = await admin
        .post('/api/v1/migration/imports')
        .field('entity_type', 'supermarket_products')
        .field('property_id', String(propertyId))
        .attach('file', Buffer.from(csv(['A,B,1.00,,,,,,'])), 'p.csv');
      expect(direct.status).toBe(403);
    });
  });
});
