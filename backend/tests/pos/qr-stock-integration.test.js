'use strict';

/**
 * Proves the exact gap the architecture blueprint for PLAN.md Phase 6's
 * POS inventory & stock control flagged as critical: TWO real settlement
 * writers exist in this codebase (`pos/service.js`'s `settleOrder` and
 * `cashiering/service.js`'s `finalizePosOrderCardCapture`), and BOTH need
 * the stock-deduction hook, or a card-paid QR guest order would silently
 * never deduct stock at all.
 *
 * `verifyRoomChargeOtpAndSettle` (`qr-ordering/service.js`) calls the
 * EXACT SAME `settleOrder` `pos/service.js`'s own settlement tests
 * exercise — this test proves that real call chain, guest-side, end to
 * end, not just that `settleOrder` itself has the hook. The card path
 * calls `finalizePosOrderCardCapture`, a SEPARATE writer with no
 * split-group concept, reached only via `applyGatewayResult`'s success
 * branch — this test proves THAT chain independently, since it is the
 * one hook `settleOrder`'s own test coverage cannot exercise at all.
 */

// Gap closure: `paystack-adapter.js` is now a factory resolved per-currency
// via `resolveAdapterForCurrency` (a real DB read of
// `platform_payment_integrations` in production, seeded for NGN by
// `tests/helpers/fixtures.js` regardless of real credentials). Mocking
// THAT function to always return one fixed, fully-mocked adapter object —
// rather than mocking the old flat exports directly — keeps every
// `paystack.xxx.mockImplementation(...)` call below working unchanged,
// while genuinely exercising `properties[0]`'s own real, fixture-seeded
// `property_payment_subaccounts` row (mirrors
// `tests/cashiering/cashiering.test.js`'s own identical fix).
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
const paystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;
const { rateLimitRedisConnection, destroyRateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');

async function flushIpRateLimitKeys() {
  const redis = rateLimitRedisConnection();
  const keys = await redis.keys('qr-order-ip-rl:*');
  const otpKeys = [...(await redis.keys('qr-otp-request-ip-rl:*')), ...(await redis.keys('qr-otp-verify-ip-rl:*'))];
  const all = [...keys, ...otpKeys];
  if (all.length) await redis.del(...all);
}

describe('QR self-ordering stock integration (PLAN.md Phase 6)', () => {
  const t = useTestApp();
  let ctx;
  let outletId;
  let menuItemId;
  let stockItemId;

  function staffToken({ tenant = ctx.a, userId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(tenant.properties[0].id),
    });
  }

  async function grantRoleToUser({ tenant, userIndex, role }) {
    const propertyId = tenant.properties[0].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  function guestPost(path) {
    return t.request.post(`/api/v1/qr-order${path}`).set('X-Tenant-Slug', ctx.a.slug);
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `qr-stock-idem-${idemCounter}`;
  }

  async function createStaffToken({ type, roomIdParam } = {}) {
    return t.request
      .post('/api/v1/pos/qr-tokens')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ outlet_id: outletId, type: type ?? 'table', room_id: roomIdParam, base_url: 'https://alpha-hotels.test/qr-order' });
  }

  beforeAll(async () => {
    await flushIpRateLimitKeys();
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-08-01' });
    await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });

    outletId = ctx.a.posOutlets[0].id;
    await t.trx('pos_outlets').where({ id: outletId }).update({
      guest_ordering_enabled: true,
      guest_order_accept_timeout_minutes: 10,
      guest_order_rate_limit_max: 100,
    });

    const [menuId] = await t.trx('pos_menu_items').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      outlet_id: outletId,
      name: 'Stock-Linked Cocktail',
      category: 'Drinks',
      price: '20.00',
    });
    menuItemId = menuId;

    const [stockId] = await t.trx('stock_items').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      outlet_id: outletId,
      name: 'QR Test Spirit',
      unit: 'ml',
      purchase_cost: '2.00',
      current_quantity: '0.000',
    });
    stockItemId = stockId;
    // Seed a real backing receipt so recomputation lands on a genuine
    // positive baseline, not a raw, un-derived value (`stock/service.js`'s
    // own "current_quantity is never independently maintained" rule).
    await t.trx('stock_movements').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      outlet_id: outletId,
      stock_item_id: stockItemId,
      type: 'received',
      quantity: '1000.000',
      unit_cost: '2.00',
      total_cost: '2000.00',
      business_date: '2027-08-01',
      reference: 'QR stock integration seed',
    });
    await t.trx('stock_items').where({ id: stockItemId }).update({ current_quantity: '1000.000' });

    await t.trx('pos_menu_item_components').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      menu_item_id: menuItemId,
      stock_item_id: stockItemId,
      quantity: '50.000',
    });
  });

  afterAll(async () => {
    await flushIpRateLimitKeys();
    await destroyRateLimitRedisConnection();
  });

  // -----------------------------------------------------------------
  // Path 1 — room_charge, via verifyRoomChargeOtpAndSettle -> settleOrder
  // -----------------------------------------------------------------

  describe('room-charge path (verifyRoomChargeOtpAndSettle -> the real settleOrder)', () => {
    let roomRaw;

    beforeAll(async () => {
      const [roomId] = await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: ctx.a.roomTypes[0].id,
        room_number: `QRSTK-${Date.now()}`,
      });
      const created = await createStaffToken({ type: 'room', roomIdParam: roomId });
      roomRaw = created.body.meta.rawToken;

      const suffix = `${Date.now()}`;
      const [reservationId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: ctx.a.guests[0].id,
        room_type_id: ctx.a.roomTypes[0].id,
        rate_code_id: ctx.a.rateCodes[0].id,
        arrival_date: '2027-08-01',
        departure_date: '2027-08-05',
        adults: 1,
        children: 0,
        status: 'checked_in',
        confirmation_number: `QRSTK${suffix}`.toUpperCase().slice(0, 26),
        checked_in_at: new Date(),
      });
      await t.trx('reservation_rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        reservation_id: reservationId,
        room_id: roomId,
        effective_from: new Date(),
        effective_to: null,
      });
      await t.trx('folios').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        reservation_id: reservationId,
        folio_number: `QRSTKFOLIO${suffix}`.toUpperCase().slice(0, 26),
        status: 'open',
        balance: '0.00',
        currency: 'NGN',
      });
    });

    it('a guest charging to their room, via the real OTP flow, genuinely deducts stock', async () => {
      const created = await guestPost(`/${roomRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 2 }] });
      expect(created.status).toBe(201);
      const posOrderId = created.body.data.pos_order_id;

      const otpRes = await guestPost(`/${roomRaw}/orders/${created.body.data.id}/room-charge/request-otp`).send({});
      expect(otpRes.status).toBe(200);
      const code = otpRes.body.data.devOnlyCode;
      expect(code).toMatch(/^\d{6}$/);

      const verify = await guestPost(`/${roomRaw}/orders/${created.body.data.id}/room-charge/verify`).send({ code });
      expect(verify.status).toBe(200);
      expect(verify.body.data.guestOrder.payment_status).toBe('charged_to_room');

      const settlement = await t.trx('pos_order_settlements').where({ pos_order_id: posOrderId, method: 'room_charge' }).first();
      expect(settlement).toBeDefined();

      const movement = await t.trx('stock_movements').where({ pos_order_settlement_id: settlement.id, type: 'sold' }).first();
      expect(movement).toBeDefined();
      expect(movement.quantity).toBe('-100.000'); // 50.000/unit x 2 units.
      expect(movement.total_cost).toBe('-200.00');

      const item = await t.trx('stock_items').where({ id: stockItemId }).first();
      expect(item.current_quantity).toBe('900.000'); // 1000 - 100.
    });

    // Gap closure — the stock-out override guard. No human is present at
    // this call site (the OTP is already single-use-claimed by the time
    // `settleOrder` runs) — this proves it is ALWAYS auto-overridden, never
    // rejected, with the fixed AUTOMATIC_OVERRIDE_REASON_ROOM_CHARGE_OTP
    // reason genuinely recorded.
    it('a room-charge settlement that would deplete stock is auto-overridden, never rejected — the guest\'s already-claimed OTP cannot be stranded', async () => {
      const [scarceId] = await t.trx('stock_items').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        outlet_id: outletId,
        name: 'QR Scarce Room-Charge Spirit',
        unit: 'ml',
        purchase_cost: '2.00',
        current_quantity: '0.000',
      });
      // A real backing "received" movement, not just the raw column — see
      // this file's own outer beforeAll comment ("current_quantity is
      // never independently maintained").
      await t.trx('stock_movements').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        outlet_id: outletId,
        stock_item_id: scarceId,
        type: 'received',
        quantity: '10.000',
        unit_cost: '2.00',
        total_cost: '20.00',
        business_date: '2027-08-01',
        reference: 'QR scarce room-charge seed',
      });
      await t.trx('stock_items').where({ id: scarceId }).update({ current_quantity: '10.000' });
      const [scarceMenuId] = await t.trx('pos_menu_items').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        outlet_id: outletId,
        name: 'Scarce Room-Charge Cocktail',
        category: 'Drinks',
        price: '20.00',
      });
      await t.trx('pos_menu_item_components').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        menu_item_id: scarceMenuId,
        stock_item_id: scarceId,
        quantity: '10.000', // Exactly enough for one sale to hit zero.
      });

      // acknowledge_low_stock is required here too — add-time enforcement
      // applies to guest ordering identically (same rule, every channel);
      // it is the SETTLE-time (OTP verify) side this test actually proves
      // is unconditionally auto-overridden.
      const created = await guestPost(`/${roomRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'room_charge', items: [{ menu_item_id: scarceMenuId, quantity: 1 }], acknowledge_low_stock: true });
      expect(created.status).toBe(201);

      const otpRes = await guestPost(`/${roomRaw}/orders/${created.body.data.id}/room-charge/request-otp`).send({});
      const code = otpRes.body.data.devOnlyCode;

      const verify = await guestPost(`/${roomRaw}/orders/${created.body.data.id}/room-charge/verify`).send({ code });
      expect(verify.status).toBe(200); // Never rejected for insufficient stock.
      expect(verify.body.data.guestOrder.payment_status).toBe('charged_to_room');

      const item = await t.trx('stock_items').where({ id: scarceId }).first();
      expect(item.current_quantity).toBe('0.000');

      // TWO overrides were genuinely applied here — add-time (the guest's
      // own acknowledgment, at order creation) and settle-time (the OTP
      // verify's own unconditional auto-override) — each its own audit
      // row, oldest first.
      const auditRows = await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: scarceId, action: 'stock_override_applied' }).orderBy('id', 'asc');
      expect(auditRows).toHaveLength(2);
      expect(auditRows[0].reason).toBe('Guest acknowledged a low-stock warning before placing the order.');
      expect(auditRows[1].reason).toBe('Automatically approved — a verified room-charge confirmation cannot be blocked; flagged for review.');
      expect(auditRows[1].source).toBe('api');
    });
  });

  // -----------------------------------------------------------------
  // Path 2 — card, via applyGatewayResult -> finalizePosOrderCardCapture
  // -----------------------------------------------------------------

  describe('card path (applyGatewayResult -> the real finalizePosOrderCardCapture)', () => {
    let tableRaw;

    beforeAll(async () => {
      const created = await createStaffToken({ type: 'table' });
      tableRaw = created.body.meta.rawToken;
    });

    it('a guest paying by card, once the gateway confirms success, genuinely deducts stock — the writer settleOrder\'s own tests cannot exercise', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/qr-stock', accessCode: 'qrstk', reference: 'qrstk-ref' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'qrstock@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(created.status).toBe(201);
      const posOrderId = created.body.data.pos_order_id;

      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: 'ps_qrstk_1' }));
      const confirmed = await guestPost(`/${tableRaw}/orders/${created.body.data.id}/confirm-payment`).send({});
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data.payment.status).toBe('CAPTURED');

      const order = await t.trx('pos_orders').where({ id: posOrderId }).first();
      expect(order.status).toBe('settled');
      const settlement = await t.trx('pos_order_settlements').where({ pos_order_id: posOrderId, method: 'card' }).first();
      expect(settlement).toBeDefined();

      const movement = await t.trx('stock_movements').where({ pos_order_settlement_id: settlement.id, type: 'sold' }).first();
      expect(movement).toBeDefined();
      expect(movement.quantity).toBe('-50.000'); // 50.000/unit x 1 unit.
      expect(movement.total_cost).toBe('-100.00');

      const item = await t.trx('stock_items').where({ id: stockItemId }).first();
      // 1000 (seed) - 100 (room-charge test above) - 50 (this card sale) = 850.
      expect(item.current_quantity).toBe('850.000');
    });

    // Gap closure — the stock-out override guard. No human is present at
    // this call site either (a Paystack webhook, or the guest's own
    // confirm-payment callback) and money has already been captured by the
    // time this runs — proves it is ALWAYS auto-overridden, `source:
    // 'integration'`, with the fixed AUTOMATIC_OVERRIDE_REASON_CARD_CAPTURE
    // reason genuinely recorded.
    it('a card settlement that would deplete stock is auto-overridden, never rejected — payment was already captured', async () => {
      const [scarceId] = await t.trx('stock_items').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        outlet_id: outletId,
        name: 'QR Scarce Card Spirit',
        unit: 'ml',
        purchase_cost: '2.00',
        current_quantity: '0.000',
      });
      await t.trx('stock_movements').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        outlet_id: outletId,
        stock_item_id: scarceId,
        type: 'received',
        quantity: '10.000',
        unit_cost: '2.00',
        total_cost: '20.00',
        business_date: '2027-08-01',
        reference: 'QR scarce card seed',
      });
      await t.trx('stock_items').where({ id: scarceId }).update({ current_quantity: '10.000' });
      const [scarceMenuId] = await t.trx('pos_menu_items').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        outlet_id: outletId,
        name: 'Scarce Card Cocktail',
        category: 'Drinks',
        price: '20.00',
      });
      await t.trx('pos_menu_item_components').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        menu_item_id: scarceMenuId,
        stock_item_id: scarceId,
        quantity: '10.000',
      });

      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/qr-stock-2', accessCode: 'qrstk2', reference: 'qrstk-ref-2' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'qrstock2@example.com', items: [{ menu_item_id: scarceMenuId, quantity: 1 }], acknowledge_low_stock: true });
      expect(created.status).toBe(201);
      const posOrderId = created.body.data.pos_order_id;

      paystack.verifyTransaction.mockImplementation(recordForStoredPayment(() => t.trx, { status: 'success', providerPaymentId: 'ps_qrstk_2' }));
      const confirmed = await guestPost(`/${tableRaw}/orders/${created.body.data.id}/confirm-payment`).send({});
      expect(confirmed.status).toBe(200); // Never rejected for insufficient stock.
      expect(confirmed.body.data.payment.status).toBe('CAPTURED');

      const order = await t.trx('pos_orders').where({ id: posOrderId }).first();
      expect(order.status).toBe('settled');

      const item = await t.trx('stock_items').where({ id: scarceId }).first();
      expect(item.current_quantity).toBe('0.000');

      // TWO overrides were genuinely applied — add-time (the guest's own
      // acknowledgment) and settle-time (the card-capture webhook's own
      // unconditional auto-override, `source: 'integration'`).
      const auditRows = await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: scarceId, action: 'stock_override_applied' }).orderBy('id', 'asc');
      expect(auditRows).toHaveLength(2);
      expect(auditRows[0].reason).toBe('Guest acknowledged a low-stock warning before placing the order.');
      expect(auditRows[1].reason).toBe('Automatically approved — payment was already captured by the gateway before settlement could be blocked; flagged for review.');
      expect(auditRows[1].source).toBe('integration');
    });
  });

  // -----------------------------------------------------------------
  // Path 3 — add-time (createGuestOrder), the whole-cart check
  // -----------------------------------------------------------------

  describe('add-time guard (createGuestOrder) — a guest gets the SAME rule, no free-text reason', () => {
    let cartTableRaw;
    let garnishId;
    let menuA;
    let menuB;

    beforeAll(async () => {
      // Deterministic regardless of any other describe block's own mock
      // state or test execution order — every test in this block pays by
      // card and needs a real successful checkout initiation to reach 201.
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/cart-guard', accessCode: 'cartguard', reference: 'cartguard-ref' });

      const created = await createStaffToken({ type: 'table' });
      cartTableRaw = created.body.meta.rawToken;

      const [id] = await t.trx('stock_items').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        outlet_id: outletId,
        name: 'Shared Garnish',
        unit: 'ml',
        purchase_cost: '1.00',
        current_quantity: '8.000',
      });
      garnishId = id;

      const [menuAId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, outlet_id: outletId, name: 'Cocktail A', category: 'Drinks', price: '15.00' });
      const [menuBId] = await t.trx('pos_menu_items').insert({ tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, outlet_id: outletId, name: 'Cocktail B', category: 'Drinks', price: '15.00' });
      menuA = menuAId;
      menuB = menuBId;
      await t.trx('pos_menu_item_components').insert([
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, menu_item_id: menuAId, stock_item_id: garnishId, quantity: '5.000' },
        { tenant_id: ctx.a.id, property_id: ctx.a.properties[0].id, menu_item_id: menuBId, stock_item_id: garnishId, quantity: '5.000' },
      ]);
    });

    it('rejects a COMBINED cart that would deplete a shared garnish, even though each item alone would not', async () => {
      // 1x A (5.000) + 1x B (5.000) = 10.000 against an 8.000 balance —
      // a per-line check would miss this entirely (5 < 8, 5 < 8), but the
      // whole-cart aggregation correctly catches it.
      const res = await guestPost(`/${cartTableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({
          payment_method: 'card',
          guest_contact: 'cart-guard@example.com',
          items: [
            { menu_item_id: menuA, quantity: 1 },
            { menu_item_id: menuB, quantity: 1 },
          ],
        });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_INSUFFICIENT_STOCK');
      expect(res.body.error.details.items).toHaveLength(1);
      expect(res.body.error.details.items[0].name).toBe('Shared Garnish');
    });

    it('succeeds once acknowledge_low_stock is true — a yes/no prompt, never a free-text reason — and records the fixed guest reason', async () => {
      const res = await guestPost(`/${cartTableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({
          payment_method: 'card',
          guest_contact: 'cart-guard-2@example.com',
          items: [
            { menu_item_id: menuA, quantity: 1 },
            { menu_item_id: menuB, quantity: 1 },
          ],
          acknowledge_low_stock: true,
        });
      expect(res.status).toBe(201);

      const auditRow = await t.trx('audit_log').where({ entity_type: 'stock_items', entity_id: garnishId, action: 'stock_override_applied' }).first();
      expect(auditRow).toBeDefined();
      expect(auditRow.reason).toBe('Guest acknowledged a low-stock warning before placing the order.');
      expect(auditRow.user_id).toBeNull(); // No staff user present at this call site.
    });
  });
});
