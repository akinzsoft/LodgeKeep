'use strict';

/**
 * Regression tests for the POS security review's findings:
 *
 * 1. A Register line's modifier price comes from the menu item's own
 *    catalogue, never the request; unknown/duplicate choices are refused,
 *    and so is a malformed catalogue on the menu item itself.
 * 2. A line's quantity must be a whole number from 1 to 999.
 * 3. Only the operator who opened a shift can close it; a `pos.manage`
 *    user may close someone else's with a reason (audited).
 * 4. The address printed into a QR code is derived from the tenant's own
 *    host — a `base_url` in the request is ignored.
 *
 * The QR-ordering half of 1 and 2 lives in tests/qr-ordering.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { insertMenuCategories, insertMenuItem } = require('../helpers/catalogue');
const { baseUrlFrom } = require('../../src/modules/qr-ordering/staff-controller');

describe('POS security review fixes', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-03-01' });
    await grantRoleToUser({ userIndex: 0, role: 'manager' });
    await grantRoleToUser({ userIndex: 1, role: 'pos_operator' });
  });

  function tokenFor(userIndex) {
    return signAccessToken({
      aud: 'staff',
      sub: String(ctx.a.users[userIndex].id),
      tenant_id: String(ctx.a.id),
      property_id: String(ctx.a.properties[0].id),
    });
  }

  async function grantRoleToUser({ userIndex, role }) {
    const propertyId = ctx.a.properties[0].id;
    const userId = ctx.a.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  let counter = 0;
  const next = () => {
    counter += 1;
    return `${Date.now().toString(36)}-${counter}`;
  };

  const SIZE_CATALOGUE = [{ name: 'Size', options: [{ label: 'Regular', priceDelta: '0.00' }, { label: 'Large', priceDelta: '5.00' }] }];

  async function setup() {
    const suffix = next();
    const propertyId = ctx.a.properties[0].id;
    const [outletId] = await t.trx('pos_outlets').insert({ tenant_id: ctx.a.id, property_id: propertyId, code: `HARD-${suffix}`, name: 'Hardening Bar', type: 'bar' });
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `HT-${suffix}` });
    await insertMenuCategories(t.trx, [{ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: 'Mains' }]);
    const [plainItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `Plain ${suffix}`, category: 'Mains', price: '20.00' });
    const [sizedItemId] = await insertMenuItem(t.trx, {
      tenant_id: ctx.a.id,
      property_id: propertyId,
      outlet_id: outletId,
      name: `Sized ${suffix}`,
      category: 'Mains',
      price: '20.00',
      modifiers: JSON.stringify(SIZE_CATALOGUE),
    });
    const order = await t.request.post('/api/v1/pos/orders').set('Authorization', `Bearer ${tokenFor(1)}`).send({ outlet_id: outletId, terminal_id: terminalId, table_label: 'T1' });
    expect(order.status).toBe(201);
    return { outletId, terminalId, plainItemId, sizedItemId, orderId: order.body.data.id };
  }

  function addItem(orderId, body) {
    return t.request.post(`/api/v1/pos/orders/${orderId}/items`).set('Authorization', `Bearer ${tokenFor(1)}`).send(body);
  }

  const lineCount = async (orderId) => Number((await t.trx('pos_order_items').where({ pos_order_id: orderId }).count({ n: '*' }).first()).n);
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

  // -----------------------------------------------------------------------
  // 1. Modifiers
  // -----------------------------------------------------------------------

  describe('Register modifiers', () => {
    it('stores the catalogue price for a chosen modifier, ignoring a forged priceDelta', async () => {
      const s = await setup();
      const res = await addItem(s.orderId, { menu_item_id: s.sizedItemId, quantity: 2, modifiers: [{ name: 'SIZE', option: 'large', priceDelta: '-100.00' }] });
      expect(res.status).toBe(200);
      const line = await t.trx('pos_order_items').where({ pos_order_id: s.orderId }).first();
      expect(parse(line.modifiers)).toEqual([{ name: 'Size', option: 'Large', priceDelta: '5.00' }]);

      const preview = await t.request.get(`/api/v1/pos/orders/${s.orderId}/settlement-preview`).set('Authorization', `Bearer ${tokenFor(1)}`);
      expect(preview.status).toBe(200);
      expect(JSON.stringify(preview.body.data)).toContain('50.00'); // 2 x (20.00 + 5.00)
    });

    it.each([
      ['an unknown option', [{ name: 'Size', option: 'Tiny', priceDelta: '-20.00' }]],
      ['an unknown group', [{ name: 'Discount', option: 'Staff', priceDelta: '-20.00' }]],
      ['two choices in one group', [{ name: 'Size', option: 'Large' }, { name: 'Size', option: 'Regular' }]],
      ['a malformed choice', ['Large']],
    ])('refuses %s with nothing written', async (_label, modifiers) => {
      const s = await setup();
      const res = await addItem(s.orderId, { menu_item_id: s.sizedItemId, quantity: 1, modifiers });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_MODIFIERS');
      expect(await lineCount(s.orderId)).toBe(0);
    });

    it('refuses any modifier on an item that offers none', async () => {
      const s = await setup();
      const res = await addItem(s.orderId, { menu_item_id: s.plainItemId, quantity: 1, modifiers: [{ name: 'Discount', option: 'x', priceDelta: '-19.00' }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_MODIFIERS');
    });

    it('refuses a choice that would price the line below zero', async () => {
      const s = await setup();
      await t.trx('pos_menu_items').where({ id: s.sizedItemId }).update({ modifiers: JSON.stringify([{ name: 'Promo', options: [{ label: 'Huge discount', priceDelta: '-25.00' }] }]) });
      const res = await addItem(s.orderId, { menu_item_id: s.sizedItemId, modifiers: [{ name: 'Promo', option: 'Huge discount' }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_MODIFIERS');
    });

    it('validates the catalogue when a manager saves a menu item', async () => {
      const s = await setup();
      const manager = tokenFor(0);
      const bad = await t.request
        .post('/api/v1/pos/menu-items')
        .set('Authorization', `Bearer ${manager}`)
        .send({ outlet_id: s.outletId, name: `Bad ${next()}`, category: 'Mains', price: '10.00', modifiers: [{ name: 'Size', options: [{ label: 'Large', priceDelta: 'free' }] }] });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_INVALID_MODIFIERS');

      const good = await t.request
        .post('/api/v1/pos/menu-items')
        .set('Authorization', `Bearer ${manager}`)
        .send({ outlet_id: s.outletId, name: `Good ${next()}`, category: 'Mains', price: '10.00', modifiers: SIZE_CATALOGUE });
      expect(good.status).toBe(201);
      expect(parse(good.body.data.modifiers)).toEqual(SIZE_CATALOGUE);

      const badPatch = await t.request
        .patch(`/api/v1/pos/menu-items/${good.body.data.id}`)
        .set('Authorization', `Bearer ${manager}`)
        .send({ modifiers: [{ name: 'Size', options: [] }] });
      expect(badPatch.status).toBe(400);
      expect(badPatch.body.error.code).toBe('VALIDATION_INVALID_MODIFIERS');
    });
  });

  // -----------------------------------------------------------------------
  // 2. Quantity
  // -----------------------------------------------------------------------

  describe('Register quantity', () => {
    it.each([0, -1, 1.5, 'abc', 1000, '', true, { n: 1 }])('refuses quantity %p with nothing written', async (quantity) => {
      const s = await setup();
      const res = await addItem(s.orderId, { menu_item_id: s.plainItemId, quantity });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_INVALID_QUANTITY');
      expect(await lineCount(s.orderId)).toBe(0);
    });

    it('accepts a whole number (or its digit string) and defaults to 1', async () => {
      const s = await setup();
      expect((await addItem(s.orderId, { menu_item_id: s.plainItemId, quantity: '3' })).status).toBe(200);
      expect((await addItem(s.orderId, { menu_item_id: s.plainItemId, quantity: 999 })).status).toBe(200);
      expect((await addItem(s.orderId, { menu_item_id: s.plainItemId })).status).toBe(200);
      const quantities = await t.trx('pos_order_items').where({ pos_order_id: s.orderId }).orderBy('id').pluck('quantity');
      expect(quantities).toEqual([3, 999, 1]);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Closing a shift
  // -----------------------------------------------------------------------

  describe('closing a shift', () => {
    async function openShiftAs(userIndex, terminalId) {
      const res = await t.request.post('/api/v1/pos/shifts').set('Authorization', `Bearer ${tokenFor(userIndex)}`).send({ terminal_id: terminalId, opening_float: '50.00' });
      expect(res.status).toBe(201);
      return res.body.data;
    }

    function closeAs(userIndex, shiftId, body) {
      return t.request
        .post(`/api/v1/pos/shifts/${shiftId}/close`)
        .set('Authorization', `Bearer ${tokenFor(userIndex)}`)
        .set('Idempotency-Key', `close-${next()}`)
        .send(body);
    }

    it("refuses another operator closing someone else's shift, leaving it open", async () => {
      const s = await setup();
      const shift = await openShiftAs(0, s.terminalId); // opened by the manager
      const res = await closeAs(1, shift.id, { counted_cash: '50.00' }); // closed by a pos_operator
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_SHIFT_NOT_YOURS');
      const row = await t.trx('pos_shifts').where({ id: shift.id }).first();
      expect(row.closed_at).toBeNull();
      expect(row.counted_cash).toBeNull();
    });

    it('lets the opener close their own shift with no reason', async () => {
      const s = await setup();
      const shift = await openShiftAs(1, s.terminalId);
      const res = await closeAs(1, shift.id, { counted_cash: '50.00' });
      expect(res.status).toBe(200);
      expect(res.body.data.variance).toBe('0.00');
    });

    it("lets a manager close someone else's shift only with a reason, and audits it", async () => {
      const s = await setup();
      const shift = await openShiftAs(1, s.terminalId);

      const noReason = await closeAs(0, shift.id, { counted_cash: '50.00' });
      expect(noReason.status).toBe(400);
      expect(noReason.body.error.code).toBe('VALIDATION_REASON_REQUIRED');
      expect((await t.trx('pos_shifts').where({ id: shift.id }).first()).closed_at).toBeNull();

      const res = await closeAs(0, shift.id, { counted_cash: '48.00', reason: 'Operator went home sick' });
      expect(res.status).toBe(200);
      expect(res.body.data.variance).toBe('-2.00');

      const audit = await t.trx('audit_log').where({ entity_type: 'pos_shifts', entity_id: shift.id, action: 'close' }).first();
      expect(audit).toBeDefined();
      expect(String(audit.user_id)).toBe(String(ctx.a.users[0].id));
      expect(audit.reason).toBe('Operator went home sick');
    });
  });

  // -----------------------------------------------------------------------
  // 4. QR base URL
  // -----------------------------------------------------------------------

  describe('QR code address', () => {
    function fakeReq({ hostname, host, protocol = 'https', body = {}, query = {} }) {
      return { hostname, protocol, body, query, get: (name) => (name.toLowerCase() === 'host' ? host : undefined) };
    }

    it('ignores a base_url from the request and uses the resolved tenant host', () => {
      const req = fakeReq({ hostname: 'alpha-hotels.lodgekeep.test', host: 'alpha-hotels.lodgekeep.test', body: { base_url: 'https://evil.example.com/qr-order' }, query: { base_url: 'https://evil.example.com' } });
      expect(baseUrlFrom(req)).toBe('https://alpha-hotels.lodgekeep.test/qr-order');
    });

    it("keeps the Host header's port only when it names the same host", () => {
      expect(baseUrlFrom(fakeReq({ protocol: 'http', hostname: 'alpha-hotels.localhost', host: 'alpha-hotels.localhost:5173' }))).toBe('http://alpha-hotels.localhost:5173/qr-order');
      expect(baseUrlFrom(fakeReq({ hostname: 'alpha-hotels.lodgekeep.test', host: 'evil.example.com:8443' }))).toBe('https://alpha-hotels.lodgekeep.test/qr-order');
    });

    it('creates a token even when a forged base_url is sent', async () => {
      const s = await setup();
      const res = await t.request
        .post('/api/v1/pos/qr-tokens')
        .set('Authorization', `Bearer ${tokenFor(0)}`)
        .send({ outlet_id: s.outletId, type: 'table', table_label: `QR-${next()}`, base_url: 'https://evil.example.com/qr-order' });
      expect(res.status).toBe(201);
      expect(res.body.data.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);
    });
  });
});
