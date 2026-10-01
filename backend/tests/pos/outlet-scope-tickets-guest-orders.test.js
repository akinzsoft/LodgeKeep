'use strict';

/**
 * Outlet assignments reach the Tickets (kitchen/bar) queue and the Guest
 * orders queue — a security review found a bar-only operator could list and
 * action the restaurant's tickets and QR orders. The same rule as the
 * Register and Shifts (`outlet-scope.test.js`): lists show only the caller's
 * outlets, an existing record at another outlet is 404 (never 403) and is
 * left unchanged, and managers / unassigned operators see everything.
 * See src/modules/pos/outlet-scope.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { scopedDb } = require('../../src/db');
const { workerContext } = require('../../src/modules/tenancy');
const { notifyGuestOrderReceived } = require('../../src/modules/qr-ordering/staff-alert');
const { insertMenuCategories, insertMenuItem } = require('../helpers/catalogue');

describe('outlet assignments on Tickets and Guest orders', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let manager;
  let barOperator; // pos_operator assigned to the bar only
  let unassigned; // pos_operator with no assignment (covers every outlet)
  let bar;
  let restaurant;

  const tokenFor = (userId) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(ctx.a.id), property_id: String(propertyId) });
  const as = (userId) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId)}`),
  });

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  async function outlet(code, type) {
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code, name: code, type });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `${code}-T1` });
    await insertMenuCategories(t.trx, [{ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'TK Items' }]);
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `TK ${code}`, category: 'TK Items', price: '10.00' });
    return { outletId, terminalId, menuItemId };
  }

  async function addItem(where, orderId) {
    await t.trx('pos_order_items').insert({ tenant_id: ctx.a.id, property_id: propertyId, pos_order_id: orderId, menu_item_id: where.menuItemId, quantity: 1, unit_price: '10.00' });
  }

  /** A staff tab with one item = one kitchen ticket. */
  async function ticket(where, label) {
    const [orderId] = await t.trx('pos_orders').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: where.outletId, terminal_id: where.terminalId, opened_by_user_id: manager, table_label: label, source: 'staff' });
    await addItem(where, orderId);
    return orderId;
  }

  /** A paid guest QR order (status `received`) with one item. */
  async function guestOrder(where, label, status = 'received') {
    const [orderId] = await t.trx('pos_orders').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: where.outletId, terminal_id: null, opened_by_user_id: null, table_label: label, source: 'guest' });
    const [id] = await t.trx('pos_guest_orders').insert({
      tenant_id: ctx.a.id,
      property_id: propertyId,
      pos_order_id: orderId,
      token_id: ctx.a.posOrderTokens[0].id,
      payment_method: 'card',
      payment_status: 'paid',
      status,
      guest_name: 'Ada',
      accepted_at: ['preparing', 'on_the_way'].includes(status) ? new Date() : null,
    });
    await addItem(where, orderId);
    return { id, orderId };
  }

  const ids = (rows) => rows.map((row) => String(row.id));

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    manager = ctx.a.users[0].id;
    barOperator = ctx.a.users[1].id;
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `tk-scope-${Date.now()}@example.com`, first_name: 'Una', last_name: 'Signed', password_hash: 'x', status: 'active' });
    unassigned = id;
    await setRole(manager, 'manager');
    await setRole(barOperator, 'pos_operator');
    await setRole(unassigned, 'pos_operator');

    const suffix = Date.now().toString(36).slice(-6);
    bar = await outlet(`TKB-${suffix}`, 'bar');
    restaurant = await outlet(`TKR-${suffix}`, 'restaurant');
    await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: barOperator, outlet_id: bar.outletId });
  });

  describe('Tickets', () => {
    it("lists only the operator's own outlet's tickets; a manager and an unassigned operator see both", async () => {
      const barTicket = await ticket(bar, 'Bar 1');
      const restaurantTicket = await ticket(restaurant, 'Rest 1');

      const own = ids((await as(barOperator).get('/api/v1/pos/tickets')).body.data);
      expect(own).toContain(String(barTicket));
      expect(own).not.toContain(String(restaurantTicket));
      // Asking for the other outlet by name yields nothing, not that outlet's work.
      expect((await as(barOperator).get(`/api/v1/pos/tickets?outlet_id=${restaurant.outletId}`)).body.data).toEqual([]);

      for (const user of [manager, unassigned]) {
        const all = ids((await as(user).get('/api/v1/pos/tickets')).body.data);
        expect(all).toEqual(expect.arrayContaining([String(barTicket), String(restaurantTicket)]));
      }
    });

    it("refuses to mark another outlet's ticket done (404) and changes nothing; the manager can", async () => {
      const restaurantTicket = await ticket(restaurant, 'Rest 2');
      const refused = await as(barOperator).post(`/api/v1/pos/tickets/${restaurantTicket}/done`);
      expect(refused.status).toBe(404);
      expect((await t.trx('pos_orders').where({ id: restaurantTicket }).first()).ticket_done_at).toBeNull();

      const ownTicket = await ticket(bar, 'Bar 2');
      expect((await as(barOperator).post(`/api/v1/pos/tickets/${ownTicket}/done`)).status).toBe(200);

      expect((await as(manager).post(`/api/v1/pos/tickets/${restaurantTicket}/done`)).status).toBe(200);
      expect((await t.trx('pos_orders').where({ id: restaurantTicket }).first()).ticket_done_at).not.toBeNull();
    });
  });

  describe('Guest orders', () => {
    it("lists only the operator's own outlet's guest orders; a manager and an unassigned operator see both", async () => {
      const barOrder = await guestOrder(bar, 'QR Bar');
      const restaurantOrder = await guestOrder(restaurant, 'QR Rest');

      const own = ids((await as(barOperator).get('/api/v1/pos/guest-orders')).body.data);
      expect(own).toContain(String(barOrder.id));
      expect(own).not.toContain(String(restaurantOrder.id));
      expect((await as(barOperator).get(`/api/v1/pos/guest-orders?outlet_id=${restaurant.outletId}`)).body.data).toEqual([]);

      for (const user of [manager, unassigned]) {
        const all = ids((await as(user).get('/api/v1/pos/guest-orders')).body.data);
        expect(all).toEqual(expect.arrayContaining([String(barOrder.id), String(restaurantOrder.id)]));
      }
    });

    it("hides another outlet's guest order for every action, changing nothing", async () => {
      const order = await guestOrder(restaurant, 'QR Rest 2');
      const op = as(barOperator);
      const responses = [
        await op.get(`/api/v1/pos/guest-orders/${order.id}`),
        await op.post(`/api/v1/pos/guest-orders/${order.id}/accept`),
        await op.post(`/api/v1/pos/guest-orders/${order.id}/mark-on-the-way`),
        await op.post(`/api/v1/pos/guest-orders/${order.id}/reject`).send({ reason: 'nope' }),
      ];
      expect(responses.map((res) => res.status)).toEqual([404, 404, 404, 404]);
      const row = await t.trx('pos_guest_orders').where({ id: order.id }).first();
      expect(row.status).toBe('received');
      expect(row.accepted_at).toBeNull();
      expect(row.rejected_reason).toBeNull();
    });

    it('lets the operator work their own outlet, and managers and unassigned operators work anywhere', async () => {
      const own = await guestOrder(bar, 'QR Bar 2');
      expect((await as(barOperator).get(`/api/v1/pos/guest-orders/${own.id}`)).status).toBe(200);
      expect((await as(barOperator).post(`/api/v1/pos/guest-orders/${own.id}/accept`)).status).toBe(200);
      expect((await as(barOperator).post(`/api/v1/pos/guest-orders/${own.id}/mark-on-the-way`)).status).toBe(200);

      const other = await guestOrder(restaurant, 'QR Rest 3');
      expect((await as(manager).get(`/api/v1/pos/guest-orders/${other.id}`)).status).toBe(200);
      expect((await as(manager).post(`/api/v1/pos/guest-orders/${other.id}/accept`)).status).toBe(200);
      expect((await t.trx('pos_guest_orders').where({ id: other.id }).first()).status).toBe('preparing');

      const another = await guestOrder(restaurant, 'QR Rest 4');
      expect((await as(unassigned).get(`/api/v1/pos/guest-orders/${another.id}`)).status).toBe(200);
      expect((await as(unassigned).post(`/api/v1/pos/guest-orders/${another.id}/reject`).send({ reason: 'sold out' })).status).toBe(200);
    });

    it("tells only the people at the outlet (and unrestricted roles) about a new guest order", async () => {
      const order = await guestOrder(restaurant, 'QR Rest 5');
      const db = scopedDb().for(workerContext({ tenantId: ctx.a.id, propertyId }));
      await notifyGuestOrderReceived({ db, guestOrderId: order.id, total: '10.00', currency: 'NGN' });

      const rows = (await t.trx('in_app_notifications').where({ type: 'qr_ordering.guest_order_placed' })).filter((row) => {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        return String(payload.guestOrderId) === String(order.id);
      });
      const told = rows.map((row) => String(row.user_id));
      expect(told).toContain(String(manager));
      expect(told).toContain(String(unassigned));
      expect(told).not.toContain(String(barOperator));
    });

    it("tells only the people at the outlet (and unrestricted roles) when a guest order is rejected", async () => {
      const order = await guestOrder(restaurant, 'QR Rest 6');
      expect((await as(manager).post(`/api/v1/pos/guest-orders/${order.id}/reject`).send({ reason: 'sold out' })).status).toBe(200);

      const rows = (await t.trx('in_app_notifications').where({ type: 'qr_ordering.guest_order_rejected' })).filter((row) => {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        return String(payload.guestOrderId) === String(order.id);
      });
      const told = rows.map((row) => String(row.user_id));
      expect(told).toContain(String(unassigned));
      expect(told).not.toContain(String(barOperator));
    });
  });
});
