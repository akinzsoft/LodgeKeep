'use strict';

/**
 * Shift handover: `POST /pos/orders/transfer` hands open tabs to another
 * operator, and `GET /pos/orders/transfer-candidates` lists who can take
 * them. See `transferTabs` in src/modules/pos/service.js.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuCategories, insertMenuItem } = require('../helpers/catalogue');

describe('handing tabs over', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let manager;
  let opener;
  let colleague;
  let housekeeper;
  let departed;
  let elsewhere; // pos_operator assigned to outlet B only
  let A;
  let B;
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

  async function user(first, role, status = 'active') {
    const [id] = await t.trx('users').insert({ tenant_id: ctx.a.id, email: `${first.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, first_name: first, last_name: 'Test', password_hash: 'x', status });
    await setRole(id, role);
    return id;
  }

  async function outlet(code) {
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code, name: code, type: 'bar' });
    // `code` doubles as the outlet's name in these tests.
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `${code}-T` });
    await insertMenuCategories(t.trx, [{ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Handover Drinks' }]);
    return { outletId, terminalId, code };
  }

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-03-01' });
    manager = ctx.a.users[0].id;
    opener = ctx.a.users[1].id;
    await setRole(manager, 'manager');
    await setRole(opener, 'pos_operator');
    colleague = await user('Colleague', 'pos_operator');
    housekeeper = await user('Housekeeper', 'housekeeping');
    departed = await user('Departed', 'pos_operator', 'inactive');
    elsewhere = await user('Elsewhere', 'pos_operator');

    const suffix = Date.now().toString(36);
    A = await outlet(`HOA-${suffix}`);
    B = await outlet(`HOB-${suffix}`);
    [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, name: `Handover Beer ${suffix}`, category: 'Handover Drinks', price: '10.00' });
    await t.trx('user_outlet_assignments').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: elsewhere, outlet_id: B.outletId });
  });

  async function tabOf(userId, where = A) {
    const res = await as(userId).post('/api/v1/pos/orders').send({ outlet_id: where.outletId, terminal_id: where.terminalId, table_label: 'Handover' });
    expect(res.status).toBe(201);
    await as(userId).post(`/api/v1/pos/orders/${res.body.data.id}/items`).send({ menu_item_id: menuItemId, quantity: 1 });
    return res.body.data.id;
  }

  const transfer = (userId, body) => as(userId).post('/api/v1/pos/orders/transfer').send(body);
  const row = (id) => t.trx('pos_orders').where({ id }).first();

  it('hands tabs to a colleague, keeps who opened them, audits each, and moves void/rename with them', async () => {
    const first = await tabOf(opener);
    const second = await tabOf(opener);
    const res = await transfer(opener, { order_ids: [second, first], to_user_id: colleague, reason: 'End of shift' });
    expect(res.status).toBe(200);
    expect(res.body.data.map((order) => String(order.owner_user_id))).toEqual([String(colleague), String(colleague)]);

    const moved = await row(first);
    expect(String(moved.opened_by_user_id)).toBe(String(opener));
    expect(String(moved.owner_user_id)).toBe(String(colleague));
    const audit = await t.trx('audit_log').where({ entity_type: 'pos_orders', entity_id: first, action: 'transfer' }).first();
    expect(String(audit.user_id)).toBe(String(opener));
    expect(audit.reason).toBe('End of shift');

    expect((await as(opener).post(`/api/v1/pos/orders/${first}/rename`).send({ table_label: 'Mine again' })).status).toBe(403);
    expect((await as(colleague).post(`/api/v1/pos/orders/${first}/rename`).send({ table_label: 'Now mine' })).status).toBe(200);
    expect((await as(colleague).post(`/api/v1/pos/orders/${second}/void`).send({ reason: 'guest left' })).status).toBe(200);
  });

  it("refuses to hand over someone else's tab — all or nothing — unless the caller is a manager", async () => {
    const own = await tabOf(opener);
    const others = await tabOf(colleague);
    const res = await transfer(opener, { order_ids: [own, others], to_user_id: manager });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_TAB_NOT_YOURS');
    expect((await row(own)).owner_user_id).toBeNull();
    expect((await row(others)).owner_user_id).toBeNull();

    const byManager = await transfer(manager, { order_ids: [others], to_user_id: opener });
    expect(byManager.status).toBe(200);
    expect(String((await row(others)).owner_user_id)).toBe(String(opener));
  });

  it.each([
    ['a role without Register access', () => housekeeper, 'VALIDATION_TRANSFER_RECIPIENT_INVALID'],
    ['an inactive account', () => departed, 'VALIDATION_TRANSFER_RECIPIENT_INVALID'],
    ['nobody at all', () => 999999999, 'VALIDATION_TRANSFER_RECIPIENT_INVALID'],
    ['someone assigned to another outlet', () => elsewhere, 'VALIDATION_TRANSFER_RECIPIENT_NOT_AT_OUTLET'],
    ['another tenant’s user', () => ctx.b.users[0].id, 'VALIDATION_TRANSFER_RECIPIENT_INVALID'],
  ])('refuses %s as the receiver, changing nothing', async (_label, recipient, code) => {
    const tab = await tabOf(opener);
    const res = await transfer(opener, { order_ids: [tab], to_user_id: recipient() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect((await row(tab)).owner_user_id).toBeNull();
  });

  it('refuses a guest QR tab and a closed tab', async () => {
    const [guestTab] = await t.trx('pos_orders').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: A.outletId, terminal_id: null, opened_by_user_id: null, table_label: 'QR', source: 'guest' });
    const guest = await transfer(manager, { order_ids: [guestTab], to_user_id: opener });
    expect(guest.status).toBe(422);
    expect(guest.body.error.code).toBe('BUSINESS_RULE_POS_TAB_NOT_TRANSFERABLE');

    const closed = await tabOf(opener);
    await as(opener).post(`/api/v1/pos/orders/${closed}/void`).send({ reason: 'test' });
    expect((await transfer(opener, { order_ids: [closed], to_user_id: colleague })).status).toBe(409);
  });

  it.each([
    [{ order_ids: [], to_user_id: 1 }, 'VALIDATION_TRANSFER_NO_TABS'],
    [{ order_ids: ['1', '1'], to_user_id: 1 }, 'VALIDATION_TRANSFER_INVALID_TABS'],
    [{ order_ids: Array.from({ length: 51 }, (_, i) => String(i + 1)), to_user_id: 1 }, 'VALIDATION_TRANSFER_TOO_MANY_TABS'],
    [{ order_ids: ['1'] }, 'VALIDATION_TRANSFER_RECIPIENT_REQUIRED'],
  ])('rejects a malformed request %#', async (body, code) => {
    const res = await transfer(opener, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it("answers another outlet's tab exactly as it answers a tab that does not exist, changing nothing", async () => {
    const tabAtA = await tabOf(manager);
    const hidden = await transfer(elsewhere, { order_ids: [tabAtA], to_user_id: opener });
    const missing = await transfer(elsewhere, { order_ids: ['999999999'], to_user_id: opener });
    expect(hidden.body.error.code).toBe('VALIDATION_ORDER_NOT_FOUND');
    expect([hidden.status, hidden.body.error.code]).toEqual([missing.status, missing.body.error.code]);
    expect((await row(tabAtA)).owner_user_id).toBeNull();

    // One unknown id sinks the whole request.
    const mine = await tabOf(opener);
    expect((await transfer(opener, { order_ids: [mine, '999999999'], to_user_id: colleague })).body.error.code).toBe('VALIDATION_ORDER_NOT_FOUND');
    expect((await row(mine)).owner_user_id).toBeNull();
  });

  describe("the receiver's bell", () => {
    const bell = (userId) => t.trx('in_app_notifications').where({ user_id: userId, type: 'pos.tabs_handed_over' }).orderBy('id');
    const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

    it('tells only the receiver, once per handover, naming the tabs, outlet, giver and reason', async () => {
      const before = { receiver: (await bell(colleague)).length, giver: (await bell(opener)).length, manager: (await bell(manager)).length };
      const one = await tabOf(opener);
      const two = await tabOf(opener);
      expect((await transfer(opener, { order_ids: [one, two], to_user_id: colleague, reason: 'End of shift' })).status).toBe(200);

      const rows = await bell(colleague);
      expect(rows).toHaveLength(before.receiver + 1);
      const payload = parse(rows[rows.length - 1].payload);
      expect(payload.count).toBe(2);
      expect(payload.tabs.map((tab) => String(tab.id))).toEqual([String(one), String(two)]);
      expect(payload.outletNames).toEqual([A.code]);
      expect(payload.fromName).toBe('Ada Bello');
      expect(payload.reason).toBe('End of shift');
      expect(Boolean(rows[rows.length - 1].popup)).toBe(false);
      expect(await bell(opener)).toHaveLength(before.giver);
      expect(await bell(manager)).toHaveLength(before.manager);
    });

    it('writes nothing when the handover is refused', async () => {
      const before = (await bell(housekeeper)).length;
      const tab = await tabOf(opener);
      expect((await transfer(opener, { order_ids: [tab], to_user_id: housekeeper })).status).toBe(400);
      expect(await bell(housekeeper)).toHaveLength(before);
    });

    it('also tells a role ticked in Setup → Notifications', async () => {
      await t.trx('notification_role_rules').insert({ tenant_id: ctx.a.id, property_id: propertyId, event_type: 'pos.tabs_handed_over', role: 'manager', enabled: true });
      try {
        const before = (await bell(manager)).length;
        expect((await transfer(opener, { order_ids: [await tabOf(opener)], to_user_id: colleague })).status).toBe(200);
        expect(await bell(manager)).toHaveLength(before + 1);
      } finally {
        await t.trx('notification_role_rules').where({ tenant_id: ctx.a.id, event_type: 'pos.tabs_handed_over' }).delete();
      }
    });
  });

  it('lists who can take a tab at an outlet', async () => {
    const res = await as(opener).get(`/api/v1/pos/orders/transfer-candidates?outlet_id=${A.outletId}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((person) => String(person.id));
    expect(ids).toEqual(expect.arrayContaining([String(manager), String(opener), String(colleague)]));
    for (const excluded of [housekeeper, departed, elsewhere]) expect(ids).not.toContain(String(excluded));

    const atB = (await as(opener).get(`/api/v1/pos/orders/transfer-candidates?outlet_id=${B.outletId}`)).body.data.map((person) => String(person.id));
    expect(atB).toContain(String(elsewhere));

    const blocked = await as(elsewhere).get(`/api/v1/pos/orders/transfer-candidates?outlet_id=${A.outletId}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('VALIDATION_OUTLET_NOT_ASSIGNED');
  });
});
