'use strict';

/**
 * Everything that changes an open tab belongs to its owner (the opener, or
 * whoever it was handed to). Security fix: adding items, split groups,
 * settlement and Register card checkout used to be open to any operator at
 * the outlet, so a cashier could put items on — or settle to a room — a
 * colleague's tab. Another operator is refused (403 FORBIDDEN_TAB_NOT_YOURS)
 * with nothing changed; a `pos.manage` user may act on anyone's tab but must
 * give a reason (400 VALIDATION_OVERRIDE_REASON_REQUIRED otherwise), which
 * lands on the audit row; a void's own reason counts. A tab with no owner (a
 * guest QR order) is left to any operator. Every split change is audited
 * with the line's split group before and after. See assertCanChangeTab in
 * src/modules/pos/service.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuCategories, insertMenuItem } = require('../helpers/catalogue');

describe('open tabs belong to their owner', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let manager;
  let opener;
  let other;
  let outletId;
  let terminalId;
  let menuItemId;

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

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-03-01' });
    manager = ctx.a.users[0].id;
    opener = ctx.a.users[1].id;
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `other-op-${Date.now()}@example.com`, first_name: 'Oto', last_name: 'Operator', password_hash: 'x', status: 'active' });
    other = id;
    await setRole(manager, 'manager');
    await setRole(opener, 'pos_operator');
    await setRole(other, 'pos_operator');

    const suffix = Date.now().toString(36);
    [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `OWN-${suffix}`, name: 'Owner Bar', type: 'bar' });
    [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `OWN-T-${suffix}` });
    await insertMenuCategories(t.trx, [{ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Owner Drinks' }]);
    [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Owner Beer ${suffix}`, category: 'Owner Drinks', price: '10.00' });
  });

  async function tabOf(userId) {
    const tab = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'Mine' });
    expect(tab.status).toBe(201);
    const add = await as(userId).post(`/api/v1/pos/orders/${tab.body.data.id}/items`).send({ menu_item_id: menuItemId, quantity: 1 });
    expect(add.status).toBe(200);
    return { orderId: tab.body.data.id, itemId: add.body.data.items[0].id };
  }

  it("refuses another operator's void, line void and rename, changing nothing", async () => {
    const { orderId, itemId } = await tabOf(opener);
    const rename = await as(other).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Hijacked' });
    const voidLine = await as(other).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send({ reason: 'not mine' });
    const voidTab = await as(other).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'not mine' });
    for (const res of [rename, voidLine, voidTab]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_TAB_NOT_YOURS');
    }
    const order = await t.trx('pos_orders').where({ id: orderId }).first();
    expect(order.status).toBe('open');
    expect(order.table_label).toBe('Mine');
    expect((await t.trx('pos_order_items').where({ id: itemId }).first()).voided_at).toBeNull();
  });

  const idem = () => `tab-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const settle = (userId, orderId, extra = {}) =>
    as(userId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idem()).send({ settlements: [{ method: 'cash' }], ...extra });
  const checkout = (userId, orderId, extra = {}) =>
    as(userId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Idempotency-Key', idem()).send({ tender: 'card', ...extra });
  const addTo = (userId, orderId, extra = {}) => as(userId).post(`/api/v1/pos/orders/${orderId}/items`).send({ menu_item_id: menuItemId, quantity: 1, ...extra });
  const splitTo = (userId, orderId, itemId, group, extra = {}) =>
    as(userId).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/split-group`).send({ split_group: group, ...extra });

  async function expectUntouched(orderId, itemId) {
    const order = await t.trx('pos_orders').where({ id: orderId }).first();
    expect(order.status).toBe('open');
    expect(order.table_label).toBe('Mine');
    const items = await t.trx('pos_order_items').where({ pos_order_id: orderId });
    expect(items).toHaveLength(1);
    expect(items[0].split_group).toBeNull();
    expect(String(items[0].id)).toBe(String(itemId));
    expect(await t.trx('pos_order_settlements').where({ pos_order_id: orderId })).toHaveLength(0);
    expect(await t.trx('payments').where({ pos_order_id: orderId })).toHaveLength(0);
  }

  it("refuses another operator adding to, splitting, settling or taking card payment on someone else's tab, changing nothing", async () => {
    const { orderId, itemId } = await tabOf(opener);
    const responses = [
      await addTo(other, orderId),
      await splitTo(other, orderId, itemId, 2),
      await settle(other, orderId),
      await checkout(other, orderId),
      // A reason does not help someone without pos.manage.
      await addTo(other, orderId, { override_reason: 'covering' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_TAB_NOT_YOURS');
    }
    await expectUntouched(orderId, itemId);
  });

  it('lets the owner add, split and settle; a split is audited with its before and after group and no override', async () => {
    const { orderId, itemId } = await tabOf(opener);
    expect((await addTo(opener, orderId)).status).toBe(200);
    const split = await splitTo(opener, orderId, itemId, 2);
    expect(split.status).toBe(200);
    expect(split.body.data.split_group).toBe(2);

    const audit = await t.trx('audit_log').where({ entity_type: 'pos_order_items', entity_id: itemId, action: 'assign_split_group' }).first();
    expect(String(audit.user_id)).toBe(String(opener));
    expect(audit.reason).toBeNull();
    const before = typeof audit.before_state === 'string' ? JSON.parse(audit.before_state) : audit.before_state;
    const after = typeof audit.after_state === 'string' ? JSON.parse(audit.after_state) : audit.after_state;
    expect(before.split_group).toBeNull();
    expect(after.split_group).toBe(2);
    expect(String(after.pos_order_id)).toBe(String(orderId));
    expect(after.owner_user_id).toBeUndefined();

    // Both groups present, so settle each once.
    const settled = await as(opener)
      .post(`/api/v1/pos/orders/${orderId}/settle`)
      .set('Idempotency-Key', idem())
      .send({ settlements: [{ method: 'cash' }, { method: 'cash', split_group: 2 }] });
    expect(settled.status).toBe(200);
    expect(settled.body.data.ownerOverride).toBeUndefined();
  });

  it('refuses a manager acting on someone else\'s tab without a reason, changing nothing', async () => {
    const { orderId, itemId } = await tabOf(opener);
    const responses = [
      await addTo(manager, orderId),
      await splitTo(manager, orderId, itemId, 2),
      await as(manager).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Manager named' }),
      await settle(manager, orderId),
      await checkout(manager, orderId),
      await addTo(manager, orderId, { override_reason: '   ' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_OVERRIDE_REASON_REQUIRED');
    }
    await expectUntouched(orderId, itemId);
    // A refused override leaves no audit trace of an action that never happened.
    expect(await t.trx('audit_log').where({ user_id: manager, entity_type: 'pos_orders', entity_id: orderId })).toHaveLength(0);
    expect(await t.trx('audit_log').where({ user_id: manager, entity_type: 'pos_order_items', entity_id: itemId })).toHaveLength(0);
  });

  it("lets a manager add, split, rename and settle someone else's tab with a reason, each audited with the reason and the owner", async () => {
    const { orderId, itemId } = await tabOf(opener);
    const reason = 'Cashier on break, guest waiting';
    expect((await addTo(manager, orderId, { override_reason: reason })).status).toBe(200);
    expect((await splitTo(manager, orderId, itemId, 2, { override_reason: reason })).status).toBe(200);
    expect((await as(manager).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Manager named', override_reason: reason })).status).toBe(200);
    const settled = await as(manager)
      .post(`/api/v1/pos/orders/${orderId}/settle`)
      .set('Idempotency-Key', idem())
      .send({ settlements: [{ method: 'cash' }, { method: 'cash', split_group: 2 }], override_reason: reason });
    expect(settled.status).toBe(200);

    const rows = [
      ...(await t.trx('audit_log').where({ user_id: manager, reason, entity_type: 'pos_orders', entity_id: orderId })),
      ...(await t.trx('audit_log').where({ user_id: manager, reason, entity_type: 'pos_order_items', entity_id: itemId })),
    ];
    expect(rows).toHaveLength(4);
    const byAction = Object.fromEntries(rows.map((row) => [row.action, row]));
    expect(Object.keys(byAction).sort()).toEqual(['add_item', 'assign_split_group', 'rename', 'settle']);
    for (const row of Object.values(byAction)) {
      const after = typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state;
      expect(String(after.owner_user_id)).toBe(String(opener));
    }
  });

  it('moves the rights with the tab on handover: the receiver may change it, the previous owner may not', async () => {
    const { orderId, itemId } = await tabOf(opener);
    expect((await as(opener).post('/api/v1/pos/orders/transfer').send({ order_ids: [orderId], to_user_id: other })).status).toBe(200);
    expect((await addTo(opener, orderId)).status).toBe(403);
    expect((await splitTo(opener, orderId, itemId, 2)).status).toBe(403);
    expect((await addTo(other, orderId)).status).toBe(200);
    expect((await splitTo(other, orderId, itemId, 2)).status).toBe(200);
  });

  it('lets the opener rename, void a line and void the tab', async () => {
    const { orderId, itemId } = await tabOf(opener);
    expect((await as(opener).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'Renamed' })).status).toBe(200);
    expect((await as(opener).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send({ reason: 'wrong item' })).status).toBe(200);
    expect((await as(opener).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'guest left' })).status).toBe(200);
  });

  it("lets a manager void someone else's line and tab on the void's own reason, recorded as the manager", async () => {
    const { orderId, itemId } = await tabOf(opener);
    expect((await as(manager).post(`/api/v1/pos/orders/${orderId}/items/${itemId}/void`).send({ reason: 'comped' })).status).toBe(200);
    const res = await as(manager).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'walkout' });
    expect(res.status).toBe(200);
    expect(String(res.body.data.voided_by_user_id)).toBe(String(manager));
  });

  it('leaves a tab with no opener (a guest QR order) to any operator', async () => {
    const [orderId] = await t.trx('pos_orders').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, terminal_id: null, opened_by_user_id: null, table_label: 'QR Table', source: 'guest' });
    expect((await as(other).post(`/api/v1/pos/orders/${orderId}/rename`).send({ table_label: 'QR Table 2' })).status).toBe(200);
    const add = await addTo(other, orderId);
    expect(add.status).toBe(200);
    expect((await splitTo(other, orderId, add.body.data.items[0].id, 2)).status).toBe(200);
    expect((await as(other).post(`/api/v1/pos/orders/${orderId}/void`).send({ reason: 'test' })).status).toBe(200);
  });
});
