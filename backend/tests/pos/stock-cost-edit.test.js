'use strict';

/**
 * Stock item cost correction: `purchase_cost` is editable through PATCH only with
 * `pos.stock_cost_edit` and a reason; it is audited, and past movements keep the
 * cost they were recorded with.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');

describe('Stock item cost correction', () => {
  const t = useTestApp();
  let ctx;
  let outletId;

  const tokenFor = (tenant, userId) =>
    signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });

  async function setRole(tenant, userIndex, role) {
    const userId = tenant.users[userIndex].id;
    const pid = tenant.properties[0].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: pid }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: pid, user_id: userId, role });
  }

  const manager = () => tokenFor(ctx.a, ctx.a.users[0].id);
  const other = () => tokenFor(ctx.b, ctx.b.users[0].id);

  async function newItem(cost = '2000.00') {
    const res = await t.request
      .post('/api/v1/pos/stock/items')
      .set('Authorization', `Bearer ${manager()}`)
      .send({ outlet_id: outletId, name: `Fanta ${Date.now()}-${Math.random()}`, unit: 'bottle', purchase_cost: cost });
    expect(res.status).toBe(201);
    return res.body.data;
  }
  const patch = (id, body, token = manager()) => t.request.patch(`/api/v1/pos/stock/items/${id}`).set('Authorization', `Bearer ${token}`).send(body);

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await setRole(ctx.a, 0, 'manager');
    await setRole(ctx.b, 0, 'manager');
    outletId = ctx.a.posOutlets[0].id;
  });

  it('corrects the cost with a reason, audits it, and leaves past movements alone', async () => {
    const item = await newItem('2000.00');
    const [movementId] = await t.trx('stock_movements').insert({
      tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, outlet_id: outletId, stock_item_id: item.id,
      type: 'sold', quantity: '-1.000', unit_cost: '2000.00', total_cost: '-2000.00', business_date: '2026-01-01',
    });

    const res = await patch(item.id, { purchase_cost: '200.00', reason: 'Data entry error' });
    expect(res.status).toBe(200);
    expect(res.body.data.purchase_cost).toBe('200.00');

    const movement = await t.trx('stock_movements').where({ id: movementId }).first();
    expect(movement.unit_cost).toBe('2000.00');
    expect(movement.total_cost).toBe('-2000.00');

    const audit = await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: String(item.id), action: 'cost_correction' }).first();
    expect(audit.reason).toBe('Data entry error');
    expect(JSON.stringify(audit.before_state)).toContain('2000.00');
    expect(JSON.stringify(audit.after_state)).toContain('200.00');
  });

  it('requires a reason and a valid amount, and changes nothing when refused', async () => {
    const item = await newItem('50.00');
    expect((await patch(item.id, { purchase_cost: '10.00' })).status).toBe(400);
    expect((await patch(item.id, { purchase_cost: '10.00', reason: '   ' })).status).toBe(400);
    for (const bad of ['-5', '1.234', 'abc', '']) {
      expect((await patch(item.id, { purchase_cost: bad, reason: 'x' })).status).toBe(400);
    }
    const after = await t.trx('stock_items').where({ id: item.id }).first();
    expect(after.purchase_cost).toBe('50.00');
  });

  it('is refused without pos.stock_cost_edit even for a holder of pos.stock_manage', async () => {
    const item = await newItem('50.00');
    const perm = await t.trx('permissions').where({ permission_key: 'pos.stock_cost_edit' }).first('id');
    await t.trx('role_permissions').where({ tenant_id: ctx.a.id, role_id: ctx.a.roles.manager, permission_id: perm.id }).delete();
    const res = await patch(item.id, { purchase_cost: '10.00', reason: 'x' });
    expect(res.status).toBe(403);
    // Other edits still work with pos.stock_manage alone.
    expect((await patch(item.id, { supplier: 'Acme' })).status).toBe(200);
    expect((await t.trx('stock_items').where({ id: item.id }).first()).purchase_cost).toBe('50.00');
    await t.trx('role_permissions').insert({ tenant_id: ctx.a.id, role_id: ctx.a.roles.manager, permission_id: perm.id });
  });

  it('an unchanged cost needs no reason and writes no cost correction', async () => {
    const item = await newItem('75.00');
    const res = await patch(item.id, { purchase_cost: '75', supplier: 'Same' });
    expect(res.status).toBe(200);
    expect(await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: String(item.id), action: 'cost_correction' }).first()).toBeUndefined();
  });

  it("another tenant cannot edit this tenant's item", async () => {
    const item = await newItem('75.00');
    expect((await patch(item.id, { purchase_cost: '1.00', reason: 'x' }, other())).status).toBe(404);
    expect((await t.trx('stock_items').where({ id: item.id }).first()).purchase_cost).toBe('75.00');
  });

  describe('cost check report', () => {
    async function menuItemWithRecipe(price, stockItemId, quantity) {
      const [id] = await t.trx('pos_menu_items').insert({
        tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, name: `Drink ${Date.now()}-${Math.random()}`, category: 'Drinks', price,
      });
      await t.trx('pos_menu_item_components').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, menu_item_id: id, stock_item_id: stockItemId, quantity });
      return id;
    }
    const check = (token = manager()) => t.request.get('/api/v1/pos/stock/reports/cost-check').set('Authorization', `Bearer ${token}`);

    it('flags items costed at or above their price, worst first, and not healthy ones', async () => {
      const bad = await newItem('2000.00');
      const equal = await newItem('200.00');
      const fine = await newItem('50.00');
      const badMenu = await menuItemWithRecipe('200.00', bad.id, '1.000');
      const equalMenu = await menuItemWithRecipe('200.00', equal.id, '1.000');
      const fineMenu = await menuItemWithRecipe('200.00', fine.id, '1.000');

      const res = await check();
      expect(res.status).toBe(200);
      const ids = res.body.data.rows.map((r) => String(r.menuItemId));
      expect(ids).toContain(String(badMenu));
      expect(ids).toContain(String(equalMenu));
      expect(ids).not.toContain(String(fineMenu));
      expect(ids.indexOf(String(badMenu))).toBeLessThan(ids.indexOf(String(equalMenu)));
      const row = res.body.data.rows.find((r) => String(r.menuItemId) === String(badMenu));
      expect(row.unitCost).toBe('2000.00');
      expect(row.components[0].name).toBe(bad.name);
    });

    it('stops flagging an item once its cost is corrected', async () => {
      const item = await newItem('2000.00');
      const menu = await menuItemWithRecipe('200.00', item.id, '1.000');
      expect((await check()).body.data.rows.map((r) => String(r.menuItemId))).toContain(String(menu));
      await patch(item.id, { purchase_cost: '100.00', reason: 'fix' });
      expect((await check()).body.data.rows.map((r) => String(r.menuItemId))).not.toContain(String(menu));
    });

    it('is manager-only and tenant-scoped', async () => {
      await setRole(ctx.a, 1, 'pos_operator');
      expect((await check(tokenFor(ctx.a, ctx.a.users[1].id))).status).toBe(403);
      const item = await newItem('2000.00');
      const menu = await menuItemWithRecipe('200.00', item.id, '1.000');
      expect((await check(other())).body.data.rows.map((r) => String(r.menuItemId))).not.toContain(String(menu));
    });
  });
});
