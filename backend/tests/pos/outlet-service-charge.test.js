'use strict';

/**
 * Per-outlet service charge: the Register rate (default 7.50), the QR mode ('none' by default, or
 * 'charge'), the permission/reason/audit around changing them, and both guest-QR payment paths.
 *
 * Ambient tax: the fixtures seed a 7.5% VAT, so a 20.00 item carries 1.50 tax.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    refundTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    createSubaccount: jest.fn(),
    resolveBankAccount: jest.fn(),
  };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

const { recordForStoredPayment } = require('../helpers/gateway-record');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystackAdapterModule = require('../../src/modules/cashiering/paystack-adapter');
const paystack = paystackAdapterModule.__mockAdapter;
const { rateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');
const { insertMenuItem } = require('../helpers/catalogue');
const { qrServiceChargePercent, registerServiceChargePercent } = require('../../src/shared/service-charge');

describe('Per-outlet service charge', () => {
  const t = useTestApp();
  let ctx;
  let propertyId;
  let managerId;
  let operatorId;
  let counter = 0;

  const tokenFor = (userId, tenant = ctx.a) => signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenant.id), property_id: String(tenant.properties[0].id) });
  const as = (userId, tenant) => ({
    get: (url) => t.request.get(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    post: (url) => t.request.post(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    put: (url) => t.request.put(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
    patch: (url) => t.request.patch(url).set('Authorization', `Bearer ${tokenFor(userId, tenant)}`),
  });
  const idemKey = () => `osc-${(counter += 1)}`;
  const guestPost = (path) => t.request.post(`/api/v1/qr-order${path}`).set('X-Tenant-Slug', ctx.a.slug);
  const guestGet = (path) => t.request.get(`/api/v1/qr-order${path}`).set('X-Tenant-Slug', ctx.a.slug);

  async function setRole(userId, role) {
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) await t.trx('user_property_access').where({ id: existing.id }).update({ role });
    else await t.trx('user_property_access').insert({ tenant_id: ctx.a.id, property_id: propertyId, user_id: userId, role });
  }

  /** A fresh outlet with a terminal and one 20.00 item. */
  async function makeOutlet({ type = 'bar', percent, qrMode, guestOrdering = false } = {}) {
    const suffix = `${Date.now().toString(36).slice(-5)}${(counter += 1)}`;
    const row = { tenant_id: ctx.a.id, property_id: propertyId, code: `SC-${suffix}`, name: `SC Bar ${suffix}`, type, guest_ordering_enabled: guestOrdering };
    if (percent !== undefined) row.service_charge_percent = percent;
    if (qrMode !== undefined) row.qr_service_charge_mode = qrMode;
    const [outletId] = await t.trx('pos_outlets').insert(row);
    const [terminalId] = await t.trx('pos_terminals').insert({ tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, device_ref: `SC-T-${suffix}` });
    const [menuItemId] = await insertMenuItem(t.trx, { tenant_id: ctx.a.id, property_id: propertyId, outlet_id: outletId, name: `SC Beer ${suffix}`, category: 'Drinks', price: '20.00' });
    return { outletId, terminalId, menuItemId };
  }

  async function openTab(outlet) {
    const opened = await as(operatorId).post('/api/v1/pos/orders').send({ outlet_id: outlet.outletId, terminal_id: outlet.terminalId, table_label: `T${(counter += 1)}` });
    expect(opened.status).toBe(201);
    await as(operatorId).post(`/api/v1/pos/orders/${opened.body.data.id}/items`).send({ menu_item_id: outlet.menuItemId, quantity: 1 }).expect(200);
    return opened.body.data.id;
  }

  const setServiceCharge = (outletId, body, userId = managerId) => as(userId).put(`/api/v1/pos/outlets/${outletId}/service-charge`).send(body);

  beforeAll(async () => {
    const redis = rateLimitRedisConnection();
    const keys = await redis.keys('qr-*-rl:*');
    if (keys.length) await redis.del(...keys);
    ctx = await seedTwoTenants(t.trx);
    propertyId = ctx.a.properties[0].id;
    await t.trx('properties').where({ id: propertyId }).update({ current_business_date: '2027-09-01' });
    managerId = ctx.a.users[0].id;
    operatorId = ctx.a.users[1].id;
    await setRole(managerId, 'manager');
    await setRole(operatorId, 'pos_operator');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paystackAdapterModule.resolveAdapterForCurrency.mockImplementation(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: paystack }));
    paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/x', accessCode: 'x', reference: 'r' });
  });

  describe('the setting', () => {
    it('defaults to 7.50 on the Register and "none" for QR', async () => {
      const { outletId } = await makeOutlet();
      const row = await t.trx('pos_outlets').where({ id: outletId }).first();
      expect(row.service_charge_percent).toBe('7.50');
      expect(row.qr_service_charge_mode).toBe('none');
    });

    it('changes with a reason and writes one audit row with before, after and the reason', async () => {
      const { outletId } = await makeOutlet();
      const res = await setServiceCharge(outletId, { service_charge_percent: '10', qr_service_charge_mode: 'charge', reason: 'New house policy' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ service_charge_percent: '10.00', qr_service_charge_mode: 'charge', changed: true });
      const audit = await t.trx('audit_log').where({ entity_type: 'pos_outlets', entity_id: outletId, action: 'service_charge_change' });
      expect(audit).toHaveLength(1);
      expect(audit[0].reason).toBe('New house policy');
      const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
      expect(parse(audit[0].before_state)).toEqual({ service_charge_percent: '7.50', qr_service_charge_mode: 'none' });
      expect(parse(audit[0].after_state)).toEqual({ service_charge_percent: '10.00', qr_service_charge_mode: 'charge' });
    });

    it('needs a reason for a real change, and changes nothing without one', async () => {
      const { outletId } = await makeOutlet();
      const res = await setServiceCharge(outletId, { service_charge_percent: '12' });
      expect(res.status).toBe(400);
      expect((await t.trx('pos_outlets').where({ id: outletId }).first()).service_charge_percent).toBe('7.50');
      expect(await t.trx('audit_log').where({ entity_type: 'pos_outlets', entity_id: outletId, action: 'service_charge_change' })).toHaveLength(0);
    });

    it('writes nothing, and needs no reason, when the values are unchanged', async () => {
      const { outletId } = await makeOutlet();
      const res = await setServiceCharge(outletId, { service_charge_percent: '7.5', qr_service_charge_mode: 'none' });
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toBe(false);
      expect(await t.trx('audit_log').where({ entity_type: 'pos_outlets', entity_id: outletId, action: 'service_charge_change' })).toHaveLength(0);
    });

    it.each(['31', '30.01', '5.555', '-1', 'abc', '', '100'])('refuses the rate %p', async (value) => {
      const { outletId } = await makeOutlet();
      const res = await setServiceCharge(outletId, { service_charge_percent: value, reason: 'x' });
      expect(res.status).toBe(400);
      expect((await t.trx('pos_outlets').where({ id: outletId }).first()).service_charge_percent).toBe('7.50');
    });

    it('accepts 0 and 30 and refuses an unknown QR mode', async () => {
      const { outletId } = await makeOutlet();
      expect((await setServiceCharge(outletId, { service_charge_percent: '30', reason: 'x' })).status).toBe(200);
      expect((await setServiceCharge(outletId, { service_charge_percent: '0', reason: 'x' })).status).toBe(200);
      expect((await setServiceCharge(outletId, { qr_service_charge_mode: 'maybe', reason: 'x' })).status).toBe(400);
    });

    it('is refused for a pos_operator, and the generic outlet edit cannot change either field', async () => {
      const { outletId } = await makeOutlet();
      expect((await setServiceCharge(outletId, { service_charge_percent: '5', reason: 'x' }, operatorId)).status).toBe(403);
      await as(managerId).patch(`/api/v1/pos/outlets/${outletId}`).send({ name: 'Renamed', service_charge_percent: '1', qr_service_charge_mode: 'charge' }).expect(200);
      const row = await t.trx('pos_outlets').where({ id: outletId }).first();
      expect(row).toMatchObject({ name: 'Renamed', service_charge_percent: '7.50', qr_service_charge_mode: 'none' });
    });

    it('is refused for a supermarket or a store, and never reaches another tenant', async () => {
      const mart = await makeOutlet({ type: 'supermarket' });
      const store = await makeOutlet({ type: 'store' });
      for (const o of [mart, store]) {
        const res = await setServiceCharge(o.outletId, { service_charge_percent: '5', reason: 'x' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('BUSINESS_RULE_SERVICE_CHARGE_NOT_APPLICABLE');
      }
      expect((await setServiceCharge(ctx.b.posOutlets[0].id, { service_charge_percent: '5', reason: 'x' })).status).toBe(404);
    });

    it('the effective rate is forced to nothing for a supermarket or store, whatever the columns say', () => {
      const forced = { service_charge_percent: '7.50', qr_service_charge_mode: 'charge' };
      expect(registerServiceChargePercent({ type: 'supermarket', ...forced })).toBe('0');
      expect(qrServiceChargePercent({ type: 'supermarket', ...forced })).toBeNull();
      expect(qrServiceChargePercent({ type: 'store', ...forced })).toBeNull();
      expect(qrServiceChargePercent({ type: 'bar', ...forced })).toBe('7.50');
    });

    it('a new super_admin/manager/admin holds the key; an operator does not', async () => {
      const holders = await t.trx('role_permissions').join('permissions', 'permissions.id', 'role_permissions.permission_id').where({ 'permissions.permission_key': 'pos.service_charge.manage', 'role_permissions.tenant_id': ctx.a.id }).join('roles', 'roles.id', 'role_permissions.role_id').select('roles.code');
      expect(holders.map((r) => r.code).sort()).toEqual(['admin', 'manager', 'super_admin']);
    });
  });

  describe('the staff Register', () => {
    it('the default is unchanged: preview 7.50% = 1.50 on a 20.00 check, card checkout 23.00', async () => {
      const outlet = await makeOutlet();
      const orderId = await openTab(outlet);
      const preview = await as(operatorId).get(`/api/v1/pos/orders/${orderId}/settlement-preview`);
      // The long-standing rate adds no new field to the response, so existing clients see exactly what they did.
      expect(preview.body.data.serviceChargePercent).toBeUndefined();
      expect(preview.body.data.groups[0]).toMatchObject({ subtotal: '20.00', taxAmount: '1.50', serviceCharge: '1.50', total: '23.00' });
      const started = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Idempotency-Key', idemKey()).send({ tender: 'card' });
      expect(started.body.data.amount).toBe('23.00');
    });

    it('each outlet charges its own rate (10% here, 0% there)', async () => {
      const ten = await makeOutlet({ percent: '10.00' });
      const zero = await makeOutlet({ percent: '0.00' });
      const tenOrder = await openTab(ten);
      const zeroOrder = await openTab(zero);
      const tenPreview = await as(operatorId).get(`/api/v1/pos/orders/${tenOrder}/settlement-preview`);
      expect(tenPreview.body.data.serviceChargePercent).toBe('10.00');
      expect(tenPreview.body.data.groups[0]).toMatchObject({ serviceCharge: '2.00', total: '23.50' });
      const zeroPreview = await as(operatorId).get(`/api/v1/pos/orders/${zeroOrder}/settlement-preview`);
      expect(zeroPreview.body.data.groups[0]).toMatchObject({ serviceCharge: '0.00', total: '21.50' });
      const started = await as(operatorId).post(`/api/v1/pos/orders/${tenOrder}/paystack-checkout`).set('Idempotency-Key', idemKey()).send({ tender: 'card' });
      expect(started.body.data.amount).toBe('23.50');
    });

    it('a rate change after a card payment was started refuses the settlement with a restart message', async () => {
      const outlet = await makeOutlet();
      const orderId = await openTab(outlet);
      const started = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/paystack-checkout`).set('Idempotency-Key', idemKey()).send({ tender: 'card' });
      await t.trx('payments').where({ id: started.body.data.id }).update({ status: 'CAPTURED', captured_at: new Date() });
      await setServiceCharge(outlet.outletId, { service_charge_percent: '10', reason: 'changed mid-payment' }).then((r) => expect(r.status).toBe(200));
      // The cashier's screen re-reads the preview (now 2.00) and settles with it.
      const res = await as(operatorId).post(`/api/v1/pos/orders/${orderId}/settle`).set('Idempotency-Key', idemKey()).send({ settlements: [{ method: 'card', service_charge: '2.00', payment_id: started.body.data.id }] });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe('amount_mismatch');
      expect(res.body.error.message).toMatch(/restart the payment/i);
    });
  });

  describe('guest QR card orders', () => {
    async function qrTable(outlet) {
      const res = await as(managerId).post('/api/v1/pos/qr-tokens').send({ outlet_id: outlet.outletId, type: 'table', table_label: `Q${(counter += 1)}`, base_url: 'https://alpha-hotels.test/qr-order' });
      expect(res.status).toBe(201);
      return res.body.meta.rawToken;
    }
    async function placeCardOrder(raw, outlet) {
      const res = await guestPost(`/${raw}/orders`).set('Idempotency-Key', idemKey()).send({ payment_method: 'card', guest_contact: 'g@example.com', items: [{ menu_item_id: outlet.menuItemId, quantity: 1 }] });
      expect(res.status).toBe(201);
      return res.body.data;
    }
    async function pay(raw, order) {
      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: `ps_${order.id}` }));
      const confirmed = await guestPost(`/${raw}/orders/${order.id}/confirm-payment`).send({});
      expect(confirmed.status).toBe(200);
      return t.trx('pos_order_settlements').where({ pos_order_id: order.pos_order_id }).first();
    }

    it('mode "none" (the default): no service charge anywhere, byte for byte as before', async () => {
      const outlet = await makeOutlet({ guestOrdering: true });
      const raw = await qrTable(outlet);
      const menu = await guestGet(`/${raw}/menu`);
      expect(menu.body.data.outlet.service_charge_percent).toBeNull();
      const order = await placeCardOrder(raw, outlet);
      expect(await t.trx('pos_guest_order_service_charges').where({ pos_order_id: order.pos_order_id })).toHaveLength(0);
      const payment = await t.trx('payments').where({ pos_order_id: order.pos_order_id }).first();
      expect(payment.amount).toBe('21.50');
      expect(paystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: '21.50' }));
      const settlement = await pay(raw, order);
      expect(settlement).toMatchObject({ subtotal: '20.00', tax_amount: '1.50', service_charge: '0.00' });
    });

    it('mode "charge": the amount sent to Paystack already includes the outlet rate, and the settlement records it', async () => {
      const outlet = await makeOutlet({ guestOrdering: true, qrMode: 'charge' });
      const raw = await qrTable(outlet);
      const menu = await guestGet(`/${raw}/menu`);
      expect(menu.body.data.outlet.service_charge_percent).toBe('7.50');
      const order = await placeCardOrder(raw, outlet);
      const payment = await t.trx('payments').where({ pos_order_id: order.pos_order_id }).first();
      expect(payment.amount).toBe('23.00');
      expect(paystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: '23.00' }));
      const settlement = await pay(raw, order);
      expect(settlement).toMatchObject({ subtotal: '20.00', tax_amount: '1.50', service_charge: '1.50' });
      const details = await guestGet(`/${raw}/orders/${order.id}`);
      expect(details.body.data).toMatchObject({ service_charge: '1.50', service_charge_percent: '7.50', total: '23.00' });
    });

    it('uses the outlet\'s own rate, not a global one', async () => {
      const outlet = await makeOutlet({ guestOrdering: true, qrMode: 'charge', percent: '10.00' });
      const raw = await qrTable(outlet);
      const order = await placeCardOrder(raw, outlet);
      expect((await t.trx('payments').where({ pos_order_id: order.pos_order_id }).first()).amount).toBe('23.50');
      expect((await pay(raw, order)).service_charge).toBe('2.00');
    });

    it('keeps the rate frozen at order time when staff change the setting before the guest pays', async () => {
      const outlet = await makeOutlet({ guestOrdering: true, qrMode: 'charge' });
      const raw = await qrTable(outlet);
      const order = await placeCardOrder(raw, outlet);
      await setServiceCharge(outlet.outletId, { service_charge_percent: '20', qr_service_charge_mode: 'none', reason: 'switch off' }).then((r) => expect(r.status).toBe(200));
      const settlement = await pay(raw, order);
      expect(settlement.service_charge).toBe('1.50');
      expect(Number((await t.trx('payments').where({ pos_order_id: order.pos_order_id }).first()).amount)).toBe(23);
    });

    it('a supermarket outlet set to "charge" in the database still charges nothing (guest ordering is refused there anyway)', async () => {
      const mart = await makeOutlet({ type: 'supermarket', guestOrdering: true, qrMode: 'charge' });
      const row = await t.trx('pos_outlets').where({ id: mart.outletId }).first();
      expect(qrServiceChargePercent(row)).toBeNull();
    });
  });

  describe('guest QR room charges', () => {
    let roomId;
    let folioId;

    beforeAll(async () => {
      roomId = ctx.a.rooms[0].id;
      const suffix = `${Date.now()}`;
      const [reservationId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id, property_id: propertyId, guest_id: ctx.a.guests[0].id, room_type_id: ctx.a.roomTypes[0].id, rate_code_id: ctx.a.rateCodes[0].id,
        arrival_date: '2027-09-01', departure_date: '2027-09-05', adults: 1, children: 0, status: 'checked_in', confirmation_number: `SCRC${suffix}`.toUpperCase().slice(0, 26), checked_in_at: new Date(),
      });
      await t.trx('reservation_rooms').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: reservationId, room_id: roomId, effective_from: new Date(), effective_to: null });
      [folioId] = await t.trx('folios').insert({ tenant_id: ctx.a.id, property_id: propertyId, reservation_id: reservationId, folio_number: `SCRCF${suffix}`.toUpperCase().slice(0, 26), status: 'open', balance: '0.00', currency: 'NGN' });
    });

    async function roomChargeSettlement(outlet) {
      const created = await as(managerId).post('/api/v1/pos/qr-tokens').send({ outlet_id: outlet.outletId, type: 'room', room_id: roomId, base_url: 'https://alpha-hotels.test/qr-order' });
      expect(created.status).toBe(201);
      const raw = created.body.meta.rawToken;
      const placed = await guestPost(`/${raw}/orders`).set('Idempotency-Key', idemKey()).send({ payment_method: 'room_charge', items: [{ menu_item_id: outlet.menuItemId, quantity: 1 }] });
      expect(placed.status).toBe(201);
      const order = placed.body.data;
      const otp = await guestPost(`/${raw}/orders/${order.id}/room-charge/request-otp`).send({});
      expect(otp.status).toBe(200);
      const before = (await t.trx('folios').where({ id: folioId }).first()).balance;
      const verify = await guestPost(`/${raw}/orders/${order.id}/room-charge/verify`).send({ code: otp.body.data.devOnlyCode });
      expect(verify.status).toBe(200);
      const after = (await t.trx('folios').where({ id: folioId }).first()).balance;
      const settlement = await t.trx('pos_order_settlements').where({ pos_order_id: order.pos_order_id, method: 'room_charge' }).first();
      return { settlement, delta: (Math.round(Number(after) * 100) - Math.round(Number(before) * 100)) / 100 };
    }

    it('mode "none" (the default): the folio gets the item and tax only', async () => {
      const outlet = await makeOutlet({ guestOrdering: true });
      const { settlement, delta } = await roomChargeSettlement(outlet);
      expect(settlement.service_charge).toBe('0.00');
      expect(delta).toBe(21.5);
    });

    it('mode "charge": the server adds the outlet rate to the folio and records it on the settlement', async () => {
      const outlet = await makeOutlet({ guestOrdering: true, qrMode: 'charge', percent: '10.00' });
      const { settlement, delta } = await roomChargeSettlement(outlet);
      expect(settlement).toMatchObject({ subtotal: '20.00', tax_amount: '1.50', service_charge: '2.00' });
      expect(delta).toBe(23.5);
    });
  });
});
