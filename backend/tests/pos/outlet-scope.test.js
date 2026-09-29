'use strict';

/**
 * Staff outlet assignments reach the Register and Shifts (user-requested).
 * An operator assigned to one outlet cannot start a tab or shift at another,
 * cannot see or touch another outlet's tabs or shifts (404, never 403), and
 * lists show only their outlets. Managers, and operators with no assignment,
 * are unaffected. See src/modules/pos/outlet-scope.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuCategories, insertMenuItem } = require('../helpers/catalogue');

describe('outlet assignments on the Register and Shifts', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let manager;
  let assigned; // pos_operator assigned to outlet A only
  let unassigned; // pos_operator with no assignment (covers every outlet)
  let A;
  let B;

  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function outlet(code) {
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code, name: code, type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `${code}-T1` });
    await insertMenuCategories(t.trx, [{ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Scope Drinks' }]);
    return { outletId, terminalId };
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-03-01' });
    manager = ctx.a.users[0].id;
    assigned = ctx.a.users[1].id;
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `scope-${Date.now()}@example.com`, first_name: 'Una', last_name: 'Signed', password_hash: 'x', status: 'active' });
    unassigned = id;
    await setRole(manager, 'manager');
    await setRole(assigned, 'pos_operator');
    await setRole(unassigned, 'pos_operator');

    const suffix = Date.now().toString(36);
    A = await outlet(`SCA-${suffix}`);
    B = await outlet(`SCB-${suffix}`);
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Scope Beer ${suffix}`, category: 'Scope Drinks', price: '10.00' });
    A.menuItemId = menuItemId;
    B.menuItemId = menuItemId;
    await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: assigned, outlet_id: A.outletId });
  });

  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
  });

  async function openTab(userId, where, label = 'T') {
    const res = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: where.outletId, terminal_id: where.terminalId, table_label: label });
    return res;
  }

  async function tabWithItem(where) {
    const tab = await openTab(manager, where);
    expect(tab.status).toBe(201);
    const add = await as(manager).post(`/api/v1/pos/orders/${tab.body.data.id}/items`).send({ menu_item_id: where.menuItemId, quantity: 1 });
    expect(add.status).toBe(200);
    return { orderId: tab.body.data.id, itemId: add.body.data.items[0].id };
  }

  it('tells each user which outlets they cover', async () => {
    expect((await as(assigned).get('/api/v1/pos/my-outlets')).body.data).toEqual({ restricted: true, outletIds: [String(A.outletId)] });
    expect((await as(unassigned).get('/api/v1/pos/my-outlets')).body.data).toEqual({ restricted: false, outletIds: null });
    expect((await as(manager).get('/api/v1/pos/my-outlets')).body.data).toEqual({ restricted: false, outletIds: null });
  });

  describe('the Register', () => {
    it('refuses to open a tab at an outlet the operator is not assigned to', async () => {
      const refused = await openTab(assigned, B);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_OUTLET_NOT_ASSIGNED');
      expect(await t.trx('pos_orders').where({ outlet_id: B.outletId, opened_by_user_id: assigned }).first()).toBeUndefined();
      expect((await openTab(assigned, A)).status).toBe(201);
    });

    it("hides another outlet's tab as not found for every action, changing nothing", async () => {
      const { orderId, itemId } = await tabWithItem(B);
      const op = as(assigned);
      const responses = [
        await op.get(`/api/v1/pos/orders/${orderId}`),
        await op.get(`/api/v1/pos/orders/${orderId}/settlement-preview`),
        await op.post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: B.menuItemId, quantity: 1 }),
        await op.post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send({ reason: 'x' }),
        // A line of B's tab reached through a tab id the operator DOES cover.
        await op.post(`/api/v1/pos/orders/${(await openTab(assigned, A)).body.data.id}/items/${itemId}/void`).send({ reason: 'x' }),
        await op.post(`/api/v1/pos/orders/${orderId}/items/${itemId}/split-group`).send({ split_group: 1 }),
        await op.post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Mine now' }),
        await op.post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).send({}),
        await op.post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', `scope-${orderId}`).send({ settlements: [{ method: 'cash' }] }),
        await op.post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'x' }),
      ];
      expect(responses.map((res) => res.status)).toEqual(Array(responses.length).fill(404));

      const order = await t.trx('pos_orders').where({ id: orderId }).first();
      expect(order.status).toBe('open');
      expect(order.table_label).toBe('T');
      const items = await t.trx('pos_order_items').where({ pos_order_id: orderId });
      expect(items).toHaveLength(1);
      expect(items[0].voided_at).toBeNull();
      expect(items[0].split_group).toBeNull();
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId }).first()).toBeUndefined();
    });

    it("lists only the operator's own outlets' tabs and terminals", async () => {
      await tabWithItem(A);
      await tabWithItem(B);
      const tabs = (await as(assigned).get('/api/v1/pos/orders?status=open')).body.data;
      expect(tabs.length).toBeGreaterThan(0);
      expect(tabs.every((tab) => String(tab.outlet_id) === String(A.outletId))).toBe(true);
      expect((await as(assigned).get(`/api/v1/pos/orders?outlet_id=${B.outletId}`)).body.data).toEqual([]);

      const terminals = (await as(assigned).get('/api/v1/pos/terminals')).body.data.map((row) => String(row.id));
      expect(terminals).toContain(String(A.terminalId));
      expect(terminals).not.toContain(String(B.terminalId));
    });

    it('refuses the stock-out toggle at another outlet', async () => {
      const res = await as(assigned).post(`/api/v1/pos/menu-items/${B.menuItemId}/set-availability`).send({ outlet_id: B.outletId, is_available: false });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_OUTLET_NOT_ASSIGNED');
      expect((await as(assigned).post(`/api/v1/pos/menu-items/${A.menuItemId}/set-availability`).send({ outlet_id: A.outletId, is_available: true })).status).toBe(200);
    });

    it('leaves managers and unassigned operators free to work anywhere', async () => {
      const { orderId } = await tabWithItem(B);
      expect((await as(manager).get(`/api/v1/pos/orders/${orderId}`)).status).toBe(200);
      expect((await as(unassigned).get(`/api/v1/pos/orders/${orderId}`)).status).toBe(200);
      expect((await openTab(unassigned, B)).status).toBe(201);
    });
  });

  describe('Shifts', () => {
    it("refuses to open a shift on another outlet's terminal, and hides that outlet's shifts", async () => {
      const refused = await as(assigned).post('/api/v1/pos/shifts').send({ terminal_id: B.terminalId, opening_float: '10.00' });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_OUTLET_NOT_ASSIGNED');

      const other = await as(manager).post('/api/v1/pos/shifts').send({ terminal_id: B.terminalId, opening_float: '10.00' });
      expect(other.status).toBe(201);
      expect((await as(assigned).get(`/api/v1/pos/shifts/${other.body.data.id}`)).status).toBe(404);
      expect((await as(unassigned).get(`/api/v1/pos/shifts/${other.body.data.id}`)).status).toBe(200);

      const own = await as(assigned).post('/api/v1/pos/shifts').send({ terminal_id: A.terminalId, opening_float: '10.00' });
      expect(own.status).toBe(201);
      const listed = (await as(assigned).get('/api/v1/pos/shifts')).body.data.map((row) => String(row.id));
      expect(listed).toContain(String(own.body.data.id));
      expect(listed).not.toContain(String(other.body.data.id));

      // Tidy up: close both so later tests can open shifts on these terminals.
      await as(manager).post(`/api/v1/pos/shifts/${other.body.data.id}/close`).set('Idempotency-Key', `scope-close-${other.body.data.id}`).send({ counted_cash: '10.00' });
      await as(assigned).post(`/api/v1/pos/shifts/${own.body.data.id}/close`).set('Idempotency-Key', `scope-close-${own.body.data.id}`).send({ counted_cash: '10.00' });
    });

    it('lets the opener close their own shift even after being reassigned elsewhere', async () => {
      const own = await as(assigned).post('/api/v1/pos/shifts').send({ terminal_id: A.terminalId, opening_float: '10.00' });
      expect(own.status).toBe(201);
      await t.trx('user_outlet_assignments').where({ user_id: assigned }).update({ outlet_id: B.outletId });
      try {
        const close = await as(assigned).post(`/api/v1/pos/shifts/${own.body.data.id}/close`).set('Idempotency-Key', `scope-reassigned-${own.body.data.id}`).send({ counted_cash: '10.00' });
        expect(close.status).toBe(200);
      } finally {
        await t.trx('user_outlet_assignments').where({ user_id: assigned }).update({ outlet_id: A.outletId });
      }
    });
  });
});
