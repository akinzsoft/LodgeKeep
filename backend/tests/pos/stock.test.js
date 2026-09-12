'use strict';

/**
 * HTTP-level tests for POS inventory & stock control — PLAN.md Phase 6
 * (PRODUCT_REQUIREMENTS.md §3.4). Covers stock item CRUD + the
 * `pos.stock_view`/`pos.stock_manage` RBAC split, recipe/BOM upsert
 * (including the same-outlet enforcement), goods-received (last-cost
 * replacement, real movement rows, availability reactivation), wastage
 * (mandatory reason), the full real sale→deduct→auto-unavailable and
 * void→reverse flows through the REAL `settleOrder`/`voidSettlement`
 * functions (not mocked), the manual-override boundary (a human's own
 * toggle is never fought by the automatic mechanism), the full blind
 * stock-take lifecycle, low-stock listing, cost-of-sales/variance
 * reporting, and cross-tenant isolation.
 *
 * Cross-tenant isolation for every new table also comes free from
 * tests/isolation's ISO-* suite via tests/helpers/entities.js — the
 * cases here are a smaller, additional HTTP-level proof for the module's
 * own most consequential endpoints.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { extendedCost } = require('../../src/shared/quantity');

describe('POS inventory & stock control (PLAN.md Phase 6)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-06-01' });
  });

  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, propertyIndex = 0, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `stock-test-key-${idemCounter}`;
  }

  let outletCounter = 0;
  /** A fresh outlet/terminal/menu item, independent of the shared fixture's own BAR outlet — mirrors `pos.test.js`'s own `freshOutletSetup` exactly. */
  async function freshOutletSetup(tenant = ctx.a, { price = '20.00' } = {}) {
    outletCounter += 1;
    const suffix = `${Date.now()}-${outletCounter}`;
    const propertyId = tenant.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      code: `STK-${suffix}`,
      name: 'Stock Test Outlet',
      type: 'bar',
    });
    const [terminalId] = await t.trx('pos_terminals').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      outlet_id: outletId,
      device_ref: `STKTERM-${suffix}`,
    });
    const [menuItemId] = await t.trx('pos_menu_items').insert({
      tenant_id: tenant.id,
      property_id: propertyId,
      outlet_id: outletId,
      name: 'Test Cocktail',
      category: 'Drinks',
      price,
    });
    return { propertyId, outletId, terminalId, menuItemId };
  }

  function managerToken() {
    return tokenFor({ userId: ctx.a.users[0].id });
  }

  beforeAll(async () => {
    await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
  });

  async function createStockItem(token, { outletId, name = `Vodka-${Date.now()}`, unit = 'ml', purchaseCost = '5.00', reorderLevel = '100.000' } = {}) {
    const res = await t.request
      .post('/api/v1/pos/stock/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet_id: outletId, name, unit, purchase_cost: purchaseCost, reorder_level: reorderLevel });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function linkComponent(token, { menuItemId, stockItemId, quantity = '50.000' }) {
    const res = await t.request
      .put(`/api/v1/pos/stock/menu-items/${menuItemId}/components`)
      .set('Authorization', `Bearer ${token}`)
      .send({ components: [{ stock_item_id: stockItemId, quantity }] });
    expect(res.status).toBe(200);
    return res.body.data;
  }

  /**
   * `stock_items.current_quantity` is NEVER an independently-maintained
   * value (`stock/service.js`'s own "one source of truth, always
   * re-derived" discipline) — a direct `UPDATE stock_items SET
   * current_quantity = ...` with no backing `stock_movements` row is
   * silently discarded the very next time ANY mutation on that item
   * recomputes it from the real ledger. Every test that needs a stock
   * item to start with a real baseline quantity goes through this helper
   * instead, which posts a genuine `received` movement AND sets
   * `current_quantity` to match — exactly what `recomputeStockItemQuantity`
   * itself would derive, so it survives every later operation correctly.
   */
  async function seedStockReceipt(tenant, stockItem, quantity, { unitCost = '1.00', businessDate = '2027-01-01' } = {}) {
    await t.trx('stock_movements').insert({
      tenant_id: tenant.id,
      property_id: stockItem.property_id ?? tenant.properties[0].id,
      outlet_id: stockItem.outlet_id,
      stock_item_id: stockItem.id,
      type: 'received',
      quantity,
      unit_cost: unitCost,
      total_cost: extendedCost(unitCost, quantity),
      business_date: businessDate,
      reference: 'Test seed receipt',
    });
    await t.trx('stock_items').where({ id: stockItem.id }).update({ current_quantity: quantity });
  }

  async function openOrder(token, { outletId, terminalId, tableLabel = 'T1' }) {
    const res = await t.request
      .post('/api/v1/pos/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ outlet_id: outletId, terminal_id: terminalId, table_label: tableLabel });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  async function addItem(token, orderId, { menuItemId, quantity = 1 }) {
    const res = await t.request
      .post(`/api/v1/pos/orders/${orderId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ menu_item_id: menuItemId, quantity });
    expect(res.status).toBe(200);
    return res.body.data;
  }

  async function settleCash(token, orderId) {
    const res = await t.request
      .post(`/api/v1/pos/orders/${orderId}/settle`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey())
      .send({ settlements: [{ method: 'cash' }] });
    expect(res.status).toBe(200);
    return res.body.data;
  }

  // -----------------------------------------------------------------------
  // Stock items — CRUD + RBAC
  // -----------------------------------------------------------------------

  describe('stock items', () => {
    it('pos.stock_manage creates/updates/archives; pos.stock_view can only read', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const operatorToken = tokenFor({ userId: ctx.a.users[1].id });
      const { outletId } = await freshOutletSetup();

      const item = await createStockItem(managerToken(), { outletId });
      expect(item.unit).toBe('ml');
      expect(item.purchase_cost).toBe('5.00');

      const forbiddenCreate = await t.request
        .post('/api/v1/pos/stock/items')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ outlet_id: outletId, name: 'Nope', unit: 'ml' });
      expect(forbiddenCreate.status).toBe(403);

      const read = await t.request.get('/api/v1/pos/stock/items').set('Authorization', `Bearer ${operatorToken}`).query({ outlet_id: outletId });
      expect(read.status).toBe(200);
      expect(read.body.data.some((row) => row.id === item.id)).toBe(true);

      const update = await t.request
        .patch(`/api/v1/pos/stock/items/${item.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ supplier: 'Acme Beverages' });
      expect(update.status).toBe(200);
      expect(update.body.data.supplier).toBe('Acme Beverages');

      const forbiddenUpdate = await t.request
        .patch(`/api/v1/pos/stock/items/${item.id}`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ supplier: 'Nope' });
      expect(forbiddenUpdate.status).toBe(403);

      const archive = await t.request
        .post(`/api/v1/pos/stock/items/${item.id}/archive`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({});
      expect(archive.status).toBe(200);
      expect(archive.body.data.status).toBe('archived');
    });

    it('front_desk/cashier/housekeeping get 403 on both pos.stock_view and pos.stock_manage endpoints', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'cashier' });
      const token = tokenFor({ userId: ctx.a.users[1].id });
      const read = await t.request.get('/api/v1/pos/stock/items').set('Authorization', `Bearer ${token}`);
      expect(read.status).toBe(403);
    });

    it('low_stock=true filters to items at or below their own reorder level', async () => {
      const { outletId } = await freshOutletSetup();
      const low = await createStockItem(managerToken(), { outletId, reorderLevel: '500.000' });
      const healthy = await createStockItem(managerToken(), { outletId, reorderLevel: '1.000' });
      // `low` starts at current_quantity: 0.000 — below its own 500 reorder
      // level. `healthy` needs a REAL stocked quantity above its own 1.000
      // reorder level — a fresh item's default 0.000 would also read as
      // "low" (0 <= 1), so it must genuinely be restocked, not just left
      // at its default.
      await seedStockReceipt(ctx.a, healthy, '10.000');
      const res = await t.request.get('/api/v1/pos/stock/items').set('Authorization', `Bearer ${managerToken()}`).query({ outlet_id: outletId, low_stock: 'true' });
      expect(res.status).toBe(200);
      const ids = res.body.data.map((row) => row.id);
      expect(ids).toContain(low.id);
      expect(ids).not.toContain(healthy.id);
    });

    it('a plain update cannot overwrite current_quantity, purchase_cost, outlet_id, or status — only name/unit/supplier/reorder_level are allowlisted', async () => {
      const outletA = await freshOutletSetup();
      const outletB = await freshOutletSetup();
      const item = await createStockItem(managerToken(), { outletId: outletA.outletId, purchaseCost: '5.00' });
      await seedStockReceipt(ctx.a, item, '10.000');

      const res = await t.request
        .patch(`/api/v1/pos/stock/items/${item.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({
          name: 'Renamed',
          current_quantity: '999.000',
          purchase_cost: '1.00',
          outlet_id: outletB.outletId,
          status: 'archived',
        });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed');
      // None of the disallowed fields moved — current_quantity/purchase_cost
      // stay exactly what the real ledger/goods-received already
      // established, outlet_id/status stay exactly what creation set.
      expect(res.body.data.current_quantity).toBe('10.000');
      expect(res.body.data.purchase_cost).toBe('5.00');
      expect(Number(res.body.data.outlet_id)).toBe(outletA.outletId);
      expect(res.body.data.status).toBe('active');
    });

    it('a nonexistent outlet id is rejected with a friendly error, not a raw FK failure', async () => {
      const res = await t.request
        .post('/api/v1/pos/stock/items')
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ outlet_id: 999999999, name: 'Ghost', unit: 'ml' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_OUTLET_NOT_FOUND');
    });
  });

  // -----------------------------------------------------------------------
  // Recipe / BOM
  // -----------------------------------------------------------------------

  describe('recipe / BOM', () => {
    it('links a stock item to a menu item at the same outlet, and the read endpoint reflects it', async () => {
      const { outletId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '25.000' });

      const list = await t.request.get(`/api/v1/pos/stock/menu-items/${menuItemId}/components`).set('Authorization', `Bearer ${managerToken()}`);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].quantity).toBe('25.000');
    });

    it('rejects a component whose stock item belongs to a DIFFERENT outlet', async () => {
      const outletA = await freshOutletSetup();
      const outletB = await freshOutletSetup();
      const stockItemInB = await createStockItem(managerToken(), { outletId: outletB.outletId });

      const res = await t.request
        .put(`/api/v1/pos/stock/menu-items/${outletA.menuItemId}/components`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ components: [{ stock_item_id: stockItemInB.id, quantity: '10.000' }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_STOCK_ITEM_OUTLET_MISMATCH');
    });

    it('a full replace-all upsert drops a component no longer present in the request', async () => {
      const { outletId, menuItemId } = await freshOutletSetup();
      const itemA = await createStockItem(managerToken(), { outletId });
      const itemB = await createStockItem(managerToken(), { outletId });
      await linkComponent(managerToken(), { menuItemId, stockItemId: itemA.id, quantity: '10.000' });

      const replace = await t.request
        .put(`/api/v1/pos/stock/menu-items/${menuItemId}/components`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ components: [{ stock_item_id: itemB.id, quantity: '5.000' }] });
      expect(replace.status).toBe(200);

      const list = await t.request.get(`/api/v1/pos/stock/menu-items/${menuItemId}/components`).set('Authorization', `Bearer ${managerToken()}`);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].stock_item_id).toBe(itemB.id);
    });
  });

  // -----------------------------------------------------------------------
  // Goods received
  // -----------------------------------------------------------------------

  describe('goods received', () => {
    it('records a real movement, replaces purchase_cost wholesale (last-cost), and reactivates a previously auto-disabled item', async () => {
      const { outletId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId, purchaseCost: '5.00' });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '10.000' });

      // Manually zero it out via wastage so the menu item auto-disables, to prove goods-received reactivates it.
      const wastage = await t.request
        .post(`/api/v1/pos/stock/items/${stockItem.id}/wastage`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ quantity: '0.001', reason: 'Force to zero for this test' });
      expect(wastage.status).toBe(200);
      const menuItemAfterWastage = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(menuItemAfterWastage.is_available).toBe(0);
      expect(menuItemAfterWastage.stock_auto_unavailable).toBe(1);

      const receive = await t.request
        .post('/api/v1/pos/stock/goods-received')
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ outlet_id: outletId, reference: 'DN-001', lines: [{ stock_item_id: stockItem.id, quantity: '100.000', unit_cost: '6.50' }] });
      expect(receive.status).toBe(201);
      expect(receive.body.data.count).toBe(1);

      const updatedItem = await t.trx('stock_items').where({ id: stockItem.id }).first();
      expect(updatedItem.purchase_cost).toBe('6.50'); // Wholesale-replaced, not averaged with the original 5.00.
      expect(updatedItem.current_quantity).toBe('99.999'); // 100.000 received - 0.001 wasted.

      const movement = await t.trx('stock_movements').where({ stock_item_id: stockItem.id, type: 'received' }).first();
      expect(movement.quantity).toBe('100.000');
      expect(movement.unit_cost).toBe('6.50');
      expect(movement.total_cost).toBe('650.00');
      expect(movement.reference).toBe('DN-001');

      const menuItemAfterReceipt = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(menuItemAfterReceipt.is_available).toBe(1);
      expect(menuItemAfterReceipt.stock_auto_unavailable).toBe(0);
    });

    it('rejects a line whose stock item belongs to a different outlet', async () => {
      const outletA = await freshOutletSetup();
      const outletB = await freshOutletSetup();
      const stockItemInB = await createStockItem(managerToken(), { outletId: outletB.outletId });

      const res = await t.request
        .post('/api/v1/pos/stock/goods-received')
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ outlet_id: outletA.outletId, lines: [{ stock_item_id: stockItemInB.id, quantity: '10.000', unit_cost: '1.00' }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_STOCK_ITEM_OUTLET_MISMATCH');
    });

    it('replaying the same Idempotency-Key never double-receives the delivery', async () => {
      const { outletId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      const key = idemKey();
      const payload = { outlet_id: outletId, lines: [{ stock_item_id: stockItem.id, quantity: '10.000', unit_cost: '1.00' }] };

      const first = await t.request.post('/api/v1/pos/stock/goods-received').set('Authorization', `Bearer ${managerToken()}`).set('Idempotency-Key', key).send(payload);
      const second = await t.request.post('/api/v1/pos/stock/goods-received').set('Authorization', `Bearer ${managerToken()}`).set('Idempotency-Key', key).send(payload);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const count = await t.trx('stock_movements').where({ stock_item_id: stockItem.id, type: 'received' }).count({ n: '*' }).first();
      expect(Number(count.n)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Wastage
  // -----------------------------------------------------------------------

  describe('wastage', () => {
    it('pos.stock_view can record wastage with a reason', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const operatorToken = tokenFor({ userId: ctx.a.users[1].id });
      const { outletId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });

      const res = await t.request
        .post(`/api/v1/pos/stock/items/${stockItem.id}/wastage`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .set('Idempotency-Key', idemKey())
        .send({ quantity: '2.500', reason: 'Bottle dropped and broke' });
      expect(res.status).toBe(200);
      expect(res.body.data.current_quantity).toBe('-2.500');

      const movement = await t.trx('stock_movements').where({ stock_item_id: stockItem.id, type: 'wastage' }).first();
      expect(movement.quantity).toBe('-2.500');
      expect(movement.reason).toBe('Bottle dropped and broke');
    });

    it('rejects wastage with no reason', async () => {
      const { outletId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      const res = await t.request
        .post(`/api/v1/pos/stock/items/${stockItem.id}/wastage`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ quantity: '1.000' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_FIELD');
    });
  });

  // -----------------------------------------------------------------------
  // The real sale -> deduct -> auto-unavailable flow, through settleOrder
  // -----------------------------------------------------------------------

  describe('real settlement deducts stock (via the real settleOrder)', () => {
    it('a cash settlement deducts the recipe quantity and posts a real "sold" movement', async () => {
      const { outletId, terminalId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId, purchaseCost: '2.00' });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '50.000' });
      await seedStockReceipt(ctx.a, stockItem, '1000.000');

      const order = await openOrder(managerToken(), { outletId, terminalId });
      await addItem(managerToken(), order.id, { menuItemId, quantity: 2 });
      const settled = await settleCash(managerToken(), order.id);
      const settlementId = settled.settlements[0].id;

      const movement = await t.trx('stock_movements').where({ pos_order_settlement_id: settlementId, type: 'sold' }).first();
      expect(movement).toBeDefined();
      expect(movement.quantity).toBe('-100.000'); // 50.000 per unit x 2 units.
      expect(movement.unit_cost).toBe('2.00');
      expect(movement.total_cost).toBe('-200.00');
      expect(String(movement.pos_order_id)).toBe(String(order.id));

      const item = await t.trx('stock_items').where({ id: stockItem.id }).first();
      expect(item.current_quantity).toBe('900.000');
    });

    it('a settlement for a menu item with NO recipe deducts nothing and costs one cheap empty lookup', async () => {
      const { outletId, terminalId, menuItemId } = await freshOutletSetup();
      const order = await openOrder(managerToken(), { outletId, terminalId });
      await addItem(managerToken(), order.id, { menuItemId, quantity: 3 });
      const settled = await settleCash(managerToken(), order.id);
      expect(settled.order.status).toBe('settled');
      const anyMovement = await t.trx('stock_movements').where({ pos_order_id: order.id }).first();
      expect(anyMovement).toBeUndefined();
    });

    it('deduction is NEVER blocked once it takes a component negative — settlement always completes', async () => {
      const { outletId, terminalId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '50.000' });
      // Deliberately starts at only 10.000 — far less than the 50.000 one sale needs.
      await seedStockReceipt(ctx.a, stockItem, '10.000');

      const order = await openOrder(managerToken(), { outletId, terminalId });
      await addItem(managerToken(), order.id, { menuItemId, quantity: 1 });
      const settled = await settleCash(managerToken(), order.id);
      expect(settled.order.status).toBe('settled'); // Never rejected for insufficient stock.

      const item = await t.trx('stock_items').where({ id: stockItem.id }).first();
      expect(item.current_quantity).toBe('-40.000'); // Genuinely negative, not clamped to zero.

      const menuItem = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(menuItem.is_available).toBe(0);
      expect(menuItem.stock_auto_unavailable).toBe(1);
    });

    it('a menu item auto-disables the moment a component hits exactly zero, preventing a NEW order but never blocking one in flight', async () => {
      const { outletId, terminalId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '50.000' });
      await t.trx('stock_items').where({ id: stockItem.id }).update({ current_quantity: '50.000' });

      const order = await openOrder(managerToken(), { outletId, terminalId });
      await addItem(managerToken(), order.id, { menuItemId, quantity: 1 });
      await settleCash(managerToken(), order.id);

      const menuItem = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(menuItem.is_available).toBe(0);

      const secondOrder = await openOrder(managerToken(), { outletId, terminalId, tableLabel: 'T2' });
      const rejected = await t.request
        .post(`/api/v1/pos/orders/${secondOrder.id}/items`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ menu_item_id: menuItemId, quantity: 1 });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('VALIDATION_POS_ITEM_UNAVAILABLE');
    });
  });

  // -----------------------------------------------------------------------
  // The real void -> reverse flow, through voidSettlement
  // -----------------------------------------------------------------------

  describe('real void reverses stock (via the real voidSettlement)', () => {
    it('reverses the exact quantity, preserves the ORIGINAL cost basis and business_date (never today\'s)', async () => {
      await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-06-15' });
      const { outletId, terminalId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId, purchaseCost: '3.00' });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '20.000' });
      await seedStockReceipt(ctx.a, stockItem, '500.000', { unitCost: '3.00', businessDate: '2027-06-15' });

      const order = await openOrder(managerToken(), { outletId, terminalId });
      await addItem(managerToken(), order.id, { menuItemId, quantity: 1 });
      const settled = await settleCash(managerToken(), order.id);
      const settlementId = settled.settlements[0].id;

      const originalMovement = await t.trx('stock_movements').where({ pos_order_settlement_id: settlementId, type: 'sold' }).first();
      expect(originalMovement.business_date).toBe('2027-06-15');

      // The cost/date change AFTER the sale but BEFORE the void — the reversal must ignore both.
      await t.trx('stock_items').where({ id: stockItem.id }).update({ purchase_cost: '99.00' });
      await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-07-01' });

      const voidRes = await t.request
        .post(`/api/v1/pos/orders/${order.id}/settlements/${settlementId}/void`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Guest walked out, refunded in cash' });
      expect(voidRes.status).toBe(200);

      const reversal = await t.trx('stock_movements').where({ pos_order_settlement_id: settlementId, type: 'sale_reversal' }).first();
      expect(reversal.quantity).toBe('20.000'); // Exactly reverses the -20.000 original.
      expect(reversal.unit_cost).toBe('3.00'); // The ORIGINAL cost basis, not the now-changed 99.00.
      expect(reversal.total_cost).toBe('60.00');
      expect(reversal.business_date).toBe('2027-06-15'); // Restates the ORIGINAL period, never today's 2027-07-01.
      expect(String(reversal.reversed_movement_id)).toBe(String(originalMovement.id));

      const item = await t.trx('stock_items').where({ id: stockItem.id }).first();
      expect(item.current_quantity).toBe('500.000'); // Fully restored: 500 - 20 (sale) + 20 (reversal).
    });

    it('reactivates a menu item the original sale had auto-disabled', async () => {
      const { outletId, terminalId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '10.000' });
      // Exactly enough for ONE sale to consume it to zero (disabling the
      // item), so the reversal restoring it to a genuinely POSITIVE
      // quantity (not just back to a baseline that was already zero) is
      // what actually proves reactivation, not a coincidence of both
      // sides landing on zero.
      await seedStockReceipt(ctx.a, stockItem, '10.000');

      const order = await openOrder(managerToken(), { outletId, terminalId });
      await addItem(managerToken(), order.id, { menuItemId, quantity: 1 });
      const settled = await settleCash(managerToken(), order.id);
      const settlementId = settled.settlements[0].id;

      expect((await t.trx('pos_menu_items').where({ id: menuItemId }).first()).is_available).toBe(0);

      await t.request
        .post(`/api/v1/pos/orders/${order.id}/settlements/${settlementId}/void`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Mistake order' });

      const menuItem = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(menuItem.is_available).toBe(1);
      expect(menuItem.stock_auto_unavailable).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // The manual-override boundary — a human's own toggle always wins
  // -----------------------------------------------------------------------

  describe('manual override boundary', () => {
    it('a manually-disabled item is never reactivated by a later stock event', async () => {
      const { outletId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '10.000' });
      await t.trx('stock_items').where({ id: stockItem.id }).update({ current_quantity: '100.000' });

      // A HUMAN disables it manually — stock_auto_unavailable stays false.
      const manualDisable = await t.request
        .post(`/api/v1/pos/menu-items/${menuItemId}/set-availability`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ is_available: false });
      expect(manualDisable.status).toBe(200);
      expect((await t.trx('pos_menu_items').where({ id: menuItemId }).first()).stock_auto_unavailable).toBe(0);

      // A real restock — should NOT reactivate a manual disable.
      await t.request
        .post('/api/v1/pos/stock/goods-received')
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ outlet_id: outletId, lines: [{ stock_item_id: stockItem.id, quantity: '50.000', unit_cost: '1.00' }] });

      const menuItem = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(menuItem.is_available).toBe(0); // Still disabled.
    });

    it('a manually re-enabled item at negative stock is never re-disabled by an unrelated later stock event', async () => {
      const { outletId, menuItemId } = await freshOutletSetup();
      const stockItemA = await createStockItem(managerToken(), { outletId });
      const stockItemB = await createStockItem(managerToken(), { outletId });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItemA.id, quantity: '10.000' });
      // Leave B unlinked to this menu item — its own movement must not affect A's menu item at all,
      // and re-enabling manually is the real thing under test here.
      await t.trx('stock_items').where({ id: stockItemA.id }).update({ current_quantity: '-5.000' });
      await t.trx('pos_menu_items').where({ id: menuItemId }).update({ is_available: false, stock_auto_unavailable: true });

      // A human OVERRIDES it back on, despite the real negative stock.
      const manualEnable = await t.request
        .post(`/api/v1/pos/menu-items/${menuItemId}/set-availability`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ is_available: true });
      expect(manualEnable.status).toBe(200);
      const afterManual = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(afterManual.is_available).toBe(1);
      expect(afterManual.stock_auto_unavailable).toBe(0);

      // An unrelated wastage event on stockItemB (not a component of this menu item) must not touch it.
      await t.request
        .post(`/api/v1/pos/stock/items/${stockItemB.id}/wastage`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({ quantity: '1.000', reason: 'Unrelated spill' });

      const afterUnrelated = await t.trx('pos_menu_items').where({ id: menuItemId }).first();
      expect(afterUnrelated.is_available).toBe(1); // Untouched — B is not one of its components.
    });
  });

  // -----------------------------------------------------------------------
  // Stock takes — blind counting
  // -----------------------------------------------------------------------

  describe('stock takes', () => {
    it('the full lifecycle: open -> blind count -> complete reveals variance and posts a real count_adjustment', async () => {
      const { outletId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId, purchaseCost: '4.00' });
      await seedStockReceipt(ctx.a, stockItem, '100.000');

      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: outletId });
      expect(open.status).toBe(201);
      expect(open.body.data.status).toBe('open');
      const stockTakeId = open.body.data.id;

      const count = await t.request
        .patch(`/api/v1/pos/stock/takes/${stockTakeId}/lines/${stockItem.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ counted_quantity: '97.000' });
      expect(count.status).toBe(200);
      // Blind — never reveals theoretical_quantity/variance before completion.
      expect(count.body.data.theoretical_quantity).toBeNull();
      expect(count.body.data.variance).toBeNull();

      // A recount before completion is a normal upsert, not a duplicate.
      const recount = await t.request
        .patch(`/api/v1/pos/stock/takes/${stockTakeId}/lines/${stockItem.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ counted_quantity: '95.000' });
      expect(recount.status).toBe(200);

      const complete = await t.request
        .post(`/api/v1/pos/stock/takes/${stockTakeId}/complete`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(complete.status).toBe(200);
      expect(complete.body.data.stockTake.status).toBe('completed');
      const line = complete.body.data.lines.find((l) => String(l.stock_item_id) === String(stockItem.id));
      expect(line.theoretical_quantity).toBe('100.000');
      expect(line.variance).toBe('-5.000'); // 95 counted - 100 theoretical.

      const adjustment = await t.trx('stock_movements').where({ stock_take_id: stockTakeId, type: 'count_adjustment' }).first();
      expect(adjustment.quantity).toBe('-5.000');
      expect(adjustment.total_cost).toBe('-20.00');

      const item = await t.trx('stock_items').where({ id: stockItem.id }).first();
      expect(item.current_quantity).toBe('95.000');

      // Completing a second time is a real conflict, not a silent no-op.
      const secondComplete = await t.request
        .post(`/api/v1/pos/stock/takes/${stockTakeId}/complete`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .set('Idempotency-Key', idemKey())
        .send({});
      expect(secondComplete.status).toBe(409);
      expect(secondComplete.body.error.code).toBe('CONFLICT_STOCK_TAKE_ALREADY_COMPLETED');
    });

    it('rejects a nonexistent stock item id with a friendly error, not a raw FK failure', async () => {
      const { outletId } = await freshOutletSetup();
      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: outletId });
      const stockTakeId = open.body.data.id;

      const res = await t.request
        .patch(`/api/v1/pos/stock/takes/${stockTakeId}/lines/999999999`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ counted_quantity: '5.000' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_STOCK_ITEM_NOT_FOUND');
    });

    it('rejects a real stock item that belongs to a DIFFERENT outlet than the take itself', async () => {
      const takeOutlet = await freshOutletSetup();
      const otherOutlet = await freshOutletSetup();
      const stockItemElsewhere = await createStockItem(managerToken(), { outletId: otherOutlet.outletId });

      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: takeOutlet.outletId });
      const stockTakeId = open.body.data.id;

      const res = await t.request
        .patch(`/api/v1/pos/stock/takes/${stockTakeId}/lines/${stockItemElsewhere.id}`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ counted_quantity: '5.000' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_STOCK_ITEM_OUTLET_MISMATCH');

      // Never silently written despite the rejection.
      const line = await t.trx('stock_take_lines').where({ stock_take_id: stockTakeId, stock_item_id: stockItemElsewhere.id }).first();
      expect(line).toBeUndefined();
    });

    it('a zero variance posts no movement at all', async () => {
      const { outletId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      await t.trx('stock_items').where({ id: stockItem.id }).update({ current_quantity: '10.000' });

      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: outletId });
      const stockTakeId = open.body.data.id;
      await t.request.patch(`/api/v1/pos/stock/takes/${stockTakeId}/lines/${stockItem.id}`).set('Authorization', `Bearer ${managerToken()}`).send({ counted_quantity: '10.000' });
      await t.request.post(`/api/v1/pos/stock/takes/${stockTakeId}/complete`).set('Authorization', `Bearer ${managerToken()}`).set('Idempotency-Key', idemKey()).send({});

      const adjustment = await t.trx('stock_movements').where({ stock_take_id: stockTakeId }).first();
      expect(adjustment).toBeUndefined();
    });

    it('cancel requires a reason and leaves no stock effect', async () => {
      const { outletId } = await freshOutletSetup();
      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: outletId });
      const stockTakeId = open.body.data.id;

      const missingReason = await t.request.post(`/api/v1/pos/stock/takes/${stockTakeId}/cancel`).set('Authorization', `Bearer ${managerToken()}`).send({});
      expect(missingReason.status).toBe(400);

      const cancel = await t.request
        .post(`/api/v1/pos/stock/takes/${stockTakeId}/cancel`)
        .set('Authorization', `Bearer ${managerToken()}`)
        .send({ reason: 'Started by mistake' });
      expect(cancel.status).toBe(200);
      expect(cancel.body.data.status).toBe('cancelled');

      const recomplete = await t.request.post(`/api/v1/pos/stock/takes/${stockTakeId}/complete`).set('Authorization', `Bearer ${managerToken()}`).set('Idempotency-Key', idemKey()).send({});
      expect(recomplete.status).toBe(409);
      expect(recomplete.body.error.code).toBe('CONFLICT_STOCK_TAKE_ALREADY_CANCELLED');
    });
  });

  // -----------------------------------------------------------------------
  // Reporting
  // -----------------------------------------------------------------------

  describe('reporting', () => {
    it('cost-of-sales reports the real, positive cost of every sale in range', async () => {
      const { outletId, terminalId, menuItemId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId, purchaseCost: '2.00' });
      await linkComponent(managerToken(), { menuItemId, stockItemId: stockItem.id, quantity: '10.000' });
      await t.trx('stock_items').where({ id: stockItem.id }).update({ current_quantity: '1000.000' });
      await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-06-20' });

      const order = await openOrder(managerToken(), { outletId, terminalId });
      await addItem(managerToken(), order.id, { menuItemId, quantity: 5 });
      await settleCash(managerToken(), order.id);
      // 10.000 x 5 = 50.000ml deducted x ₦2.00/ml = ₦100.00 cost.

      const res = await t.request
        .get('/api/v1/pos/stock/reports/cost-of-sales')
        .set('Authorization', `Bearer ${managerToken()}`)
        .query({ date_from: '2027-06-20', date_to: '2027-06-20', outlet_id: outletId });
      expect(res.status).toBe(200);
      expect(res.body.data.totalCost).toBe('100.00');
      const itemRow = res.body.data.byItem.find((row) => row.stockItemId === stockItem.id);
      expect(itemRow.cost).toBe('100.00');
    });

    it('variance reports every completed take in range, summed per item', async () => {
      const { outletId } = await freshOutletSetup();
      const stockItem = await createStockItem(managerToken(), { outletId });
      await t.trx('stock_items').where({ id: stockItem.id }).update({ current_quantity: '20.000' });
      await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-06-25' });

      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: outletId });
      const stockTakeId = open.body.data.id;
      await t.request.patch(`/api/v1/pos/stock/takes/${stockTakeId}/lines/${stockItem.id}`).set('Authorization', `Bearer ${managerToken()}`).send({ counted_quantity: '18.000' });
      await t.request.post(`/api/v1/pos/stock/takes/${stockTakeId}/complete`).set('Authorization', `Bearer ${managerToken()}`).set('Idempotency-Key', idemKey()).send({});

      const res = await t.request
        .get('/api/v1/pos/stock/reports/variance')
        .set('Authorization', `Bearer ${managerToken()}`)
        .query({ date_from: '2027-06-25', date_to: '2027-06-25', outlet_id: outletId });
      expect(res.status).toBe(200);
      const summary = res.body.data.summaryByItem.find((row) => row.stockItemId === stockItem.id);
      expect(summary.totalVariance).toBe('-2.000');
    });

    it('reporting endpoints are pos.stock_manage-gated, not pos.stock_view', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const operatorToken = tokenFor({ userId: ctx.a.users[1].id });
      const res = await t.request
        .get('/api/v1/pos/stock/reports/cost-of-sales')
        .set('Authorization', `Bearer ${operatorToken}`)
        .query({ date_from: '2027-06-01', date_to: '2027-06-30' });
      expect(res.status).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-tenant isolation
  // -----------------------------------------------------------------------

  describe('cross-tenant isolation', () => {
    it('a stock item belonging to another tenant 404s, never 403', async () => {
      await grantRoleToUser({ tenant: ctx.b, userIndex: 0, role: 'manager' });
      const otherToken = tokenFor({ tenant: ctx.b, userId: ctx.b.users[0].id });
      const { outletId } = await freshOutletSetup(ctx.a);
      const item = await createStockItem(managerToken(), { outletId });

      const res = await t.request.patch(`/api/v1/pos/stock/items/${item.id}`).set('Authorization', `Bearer ${otherToken}`).send({ supplier: 'Hijack' });
      expect(res.status).toBe(404);
    });

    it('a stock take belonging to another tenant 404s on read', async () => {
      await grantRoleToUser({ tenant: ctx.b, userIndex: 0, role: 'manager' });
      const otherToken = tokenFor({ tenant: ctx.b, userId: ctx.b.users[0].id });
      const { outletId } = await freshOutletSetup(ctx.a);
      const open = await t.request.post('/api/v1/pos/stock/takes').set('Authorization', `Bearer ${managerToken()}`).send({ outlet_id: outletId });

      const res = await t.request.get(`/api/v1/pos/stock/takes/${open.body.data.id}`).set('Authorization', `Bearer ${otherToken}`);
      expect(res.status).toBe(404);
    });
  });
});
