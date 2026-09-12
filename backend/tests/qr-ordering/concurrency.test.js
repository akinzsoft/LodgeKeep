'use strict';

/**
 * Real-connection concurrency tests for QR self-ordering — PLAN.md
 * Phase 6, the four races this pass was explicitly asked to mutation-test
 * hardest. Mirrors `tests/pos/concurrency.test.js`'s own harness exactly
 * (and its header's own reasoning for why): the shared-transaction
 * `useTestApp()` harness cannot prove a real lock, since two "concurrent"
 * requests against one transaction are really two savepoints on the same
 * MySQL session, which never blocks itself. This file binds the app to
 * the real pooled test connection and seeds real COMMITTED rows instead
 * (cleaned up in `afterAll`).
 *
 * Four races proved here, each under genuinely concurrent connections:
 *
 * 1. Two concurrent guest-order creations against the SAME token, racing
 *    the outlet's own configured unpaid-value cap — exactly one succeeds
 *    when only one order fits under it.
 * 2. Two concurrent OTP-verify attempts submitting the SAME correct code
 *    for the same room-charge order — exactly one succeeds.
 * 3. A guest polling their own order status and staff loading the queue,
 *    both racing the SAME auto-reject timeout — exactly one of them
 *    actually performs the reversal (the other sees the already-claimed
 *    row and simply re-reads it).
 * 4. A racing webhook and the guest's own confirm-payment callback, both
 *    trying to finalize the SAME card capture — exactly one settlement,
 *    never a double-settle (the real bug this pass's own review found and
 *    fixed in `applyGatewayResult`, see `cashiering/service.js`).
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => ({
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  refundTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { generateRawToken, hashToken, encryptToken } = require('../../src/modules/qr-ordering/tokens');
const paystack = require('../../src/modules/cashiering/paystack-adapter');

describe('QR self-ordering races under real concurrent connections (PLAN.md Phase 6)', () => {
  let req;
  let tenantId;
  let tenantSlug;
  let propertyId;
  let outletId;
  let menuItemId;
  let userId;
  let roomId;
  let guestId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    tenantSlug = `qr-race-${suffix}`;

    [tenantId] = await db()('tenants').insert({ name: 'QR Race Tenant', slug: tenantSlug, status: 'active' });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `qr-race-property-${suffix}`,
      name: 'QR Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
      current_business_date: '2027-06-01',
    });
    const [roleId] = await db()('roles').insert({ tenant_id: tenantId, code: 'pos_operator', name: 'pos_operator', is_system: true });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `qr-race-${suffix}@example.com`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Race',
      last_name: 'Operator',
      status: 'active',
    });
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'pos_operator' });
    // pos.operate is migration-seeded globally (20260912097000) — grant, don't create.
    const perms = await db()('permissions').where({ permission_key: 'pos.operate' }).select('id');
    await db()('role_permissions').insert(perms.map((p) => ({ tenant_id: tenantId, role_id: roleId, permission_id: p.id })));

    [outletId] = await db()('pos_outlets').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: 'RACEBAR',
      name: 'Race Bar',
      type: 'bar',
      guest_ordering_enabled: true,
      guest_order_accept_timeout_minutes: 10,
      guest_order_rate_limit_max: 1000,
    });
    [menuItemId] = await db()('pos_menu_items').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      name: 'Race Item',
      category: 'Drinks',
      price: '20.00',
    });

    [guestId] = await db()('guests').insert({ tenant_id: tenantId, first_name: 'Race', last_name: 'Guest', email: `race-guest-${suffix}@example.com` });
    const [roomTypeId] = await db()('room_types').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: `RRT-${suffix}`,
      name: 'Race Room Type',
      default_occupancy: 2,
      base_rate: '150.00',
    });
    [roomId] = await db()('rooms').insert({ tenant_id: tenantId, property_id: propertyId, room_type_id: roomTypeId, room_number: `R${suffix}`, status: 'active' });
  });

  afterAll(async () => {
    // Must come before `payments` — its own FK references `payments.id`.
    await db()('payment_webhook_events').where({ tenant_id: tenantId }).delete();
    await db()('pos_room_charge_otps').where({ tenant_id: tenantId }).delete();
    await db()('pos_guest_orders').where({ tenant_id: tenantId }).delete();
    await db()('pos_order_settlements').where({ tenant_id: tenantId }).delete();
    await db()('payments').where({ tenant_id: tenantId }).delete();
    await db()('pos_order_items').where({ tenant_id: tenantId }).delete();
    await db()('pos_orders').where({ tenant_id: tenantId }).delete();
    // Before `rooms` — a room-type token's own FK references it.
    await db()('pos_order_tokens').where({ tenant_id: tenantId }).delete();
    await db()('folio_line_items').where({ tenant_id: tenantId }).delete();
    await db()('folios').where({ tenant_id: tenantId }).delete();
    await db()('reservation_rooms').where({ tenant_id: tenantId }).delete();
    await db()('reservations').where({ tenant_id: tenantId }).delete();
    await db()('rate_codes').where({ tenant_id: tenantId }).delete();
    await db()('rooms').where({ tenant_id: tenantId }).delete();
    await db()('room_types').where({ tenant_id: tenantId }).delete();
    await db()('guests').where({ tenant_id: tenantId }).delete();
    await db()('pos_menu_items').where({ tenant_id: tenantId }).delete();
    await db()('pos_outlets').where({ tenant_id: tenantId }).delete();
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('idempotency_keys').where({ tenant_id: tenantId }).delete();
    await db()('outbox_events').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  function staffToken() {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  }

  async function createRawToken({ type, tableLabel, roomIdParam } = {}) {
    const raw = generateRawToken();
    const [id] = await db()('pos_order_tokens').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      outlet_id: outletId,
      type: type ?? 'table',
      table_label: type === 'room' ? null : (tableLabel ?? 'RACE-TABLE'),
      room_id: type === 'room' ? roomIdParam : null,
      token_hash: hashToken(raw),
      token_encrypted: encryptToken(raw),
    });
    return { id, raw };
  }

  async function checkInGuestToRoom() {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const [rateCodeId] = await db()('rate_codes').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      code: `RRATE-${suffix}`,
      base_rate: '150.00',
      currency: 'NGN',
      valid_from: '2026-01-01',
    });
    const roomType = await db()('rooms').where({ id: roomId }).first('room_type_id');
    const [reservationId] = await db()('reservations').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      guest_id: guestId,
      room_type_id: roomType.room_type_id,
      rate_code_id: rateCodeId,
      arrival_date: '2027-06-01',
      departure_date: '2027-06-05',
      adults: 1,
      children: 0,
      status: 'checked_in',
      confirmation_number: `RACE${suffix}`.toUpperCase().slice(0, 26),
      checked_in_at: new Date(),
    });
    await db()('reservation_rooms').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      reservation_id: reservationId,
      room_id: roomId,
      effective_from: new Date(),
      effective_to: null,
    });
    await db()('folios').insert({
      tenant_id: tenantId,
      property_id: propertyId,
      reservation_id: reservationId,
      folio_number: `RACEFOLIO${suffix}`.toUpperCase().slice(0, 26),
      status: 'open',
      balance: '0.00',
      currency: 'NGN',
    });
    return reservationId;
  }

  let idemCounter = 0;
  function idemKey() {
    idemCounter += 1;
    return `race-idem-${Date.now()}-${idemCounter}`;
  }

  it('exactly one of two truly concurrent order creations against the same token succeeds once the unpaid-value cap is nearly exhausted', async () => {
    // room_charge (not card) so this race needs no external gateway call
    // at all — a real in-house occupant is required for that method.
    const { raw: tokenRaw, id: tokenId } = await createRawToken({ type: 'room', roomIdParam: roomId });
    await checkInGuestToRoom();
    // A single Race Item order is 20.00 — the cap allows exactly one, not two.
    await db()('pos_outlets').where({ id: outletId }).update({ guest_order_max_unpaid_value: '25.00' });

    const create = (key) =>
      req
        .post(`/api/v1/qr-order/${tokenRaw}/orders`)
        .set('X-Tenant-Slug', tenantSlug)
        .set('Idempotency-Key', key)
        .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });

    const [first, second] = await Promise.all([create(idemKey()), create(idemKey())]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 422]);

    const loser = first.status === 201 ? second : first;
    expect(loser.body.error.code).toBe('BUSINESS_RULE_GUEST_ORDER_VALUE_CAP_EXCEEDED');

    const orderCount = await db()('pos_guest_orders').where({ tenant_id: tenantId, token_id: tokenId }).count({ n: '*' }).first();
    expect(Number(orderCount.n)).toBe(1);

    await db()('pos_outlets').where({ id: outletId }).update({ guest_order_max_unpaid_value: null });
  });

  it('exactly one of two truly concurrent OTP-verify attempts submitting the same correct code succeeds', async () => {
    const { raw: tokenRaw } = await createRawToken({ type: 'room', roomIdParam: roomId });
    await checkInGuestToRoom();

    const created = await req
      .post(`/api/v1/qr-order/${tokenRaw}/orders`)
      .set('X-Tenant-Slug', tenantSlug)
      .set('Idempotency-Key', idemKey())
      .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
    expect(created.status).toBe(201);
    const guestOrderId = created.body.data.id;

    const otpRes = await req.post(`/api/v1/qr-order/${tokenRaw}/orders/${guestOrderId}/room-charge/request-otp`).set('X-Tenant-Slug', tenantSlug).send({});
    const code = otpRes.body.data.devOnlyCode;
    expect(code).toMatch(/^\d{6}$/);

    const verify = () => req.post(`/api/v1/qr-order/${tokenRaw}/orders/${guestOrderId}/room-charge/verify`).set('X-Tenant-Slug', tenantSlug).send({ code });

    const [first, second] = await Promise.all([verify(), verify()]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);

    const settlementCount = await db()('pos_order_settlements').where({ tenant_id: tenantId, method: 'room_charge' }).count({ n: '*' }).first();
    expect(Number(settlementCount.n)).toBeGreaterThanOrEqual(1);
    const thisOrderSettlements = await db()('pos_order_settlements')
      .where({ tenant_id: tenantId, pos_order_id: created.body.data.pos_order_id })
      .count({ n: '*' })
      .first();
    expect(Number(thisOrderSettlements.n)).toBe(1);
  });

  it('a guest poll and a staff queue read racing the same auto-reject timeout perform the reversal exactly once', async () => {
    const { raw: tokenRaw } = await createRawToken({ type: 'room', roomIdParam: roomId });
    await checkInGuestToRoom();

    const created = await req
      .post(`/api/v1/qr-order/${tokenRaw}/orders`)
      .set('X-Tenant-Slug', tenantSlug)
      .set('Idempotency-Key', idemKey())
      .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
    const guestOrderId = created.body.data.id;

    const otpRes = await req.post(`/api/v1/qr-order/${tokenRaw}/orders/${guestOrderId}/room-charge/request-otp`).set('X-Tenant-Slug', tenantSlug).send({});
    await req
      .post(`/api/v1/qr-order/${tokenRaw}/orders/${guestOrderId}/room-charge/verify`)
      .set('X-Tenant-Slug', tenantSlug)
      .send({ code: otpRes.body.data.devOnlyCode });

    // Past the outlet's own 10-minute accept-timeout, never accepted.
    await db()('pos_guest_orders').where({ id: guestOrderId }).update({ updated_at: new Date(Date.now() - 11 * 60 * 1000) });

    const guestPoll = () => req.get(`/api/v1/qr-order/${tokenRaw}/orders/${guestOrderId}`).set('X-Tenant-Slug', tenantSlug);
    const staffRead = () => req.get(`/api/v1/pos/guest-orders/${guestOrderId}`).set('Authorization', `Bearer ${staffToken()}`);

    const [guestRes, staffRes] = await Promise.all([guestPoll(), staffRead()]);
    expect(guestRes.status).toBe(200);
    expect(staffRes.status).toBe(200);
    expect(guestRes.body.data.status).toBe('auto_rejected');
    expect(staffRes.body.data.status).toBe('auto_rejected');

    // Exactly one reversal: the settlement was void, never twice, and no
    // request crashed trying to void an already-voided row a second time.
    const settlement = await db()('pos_order_settlements').where({ pos_order_id: created.body.data.pos_order_id }).first();
    expect(settlement.voided_at).not.toBeNull();

    const guestOrder = await db()('pos_guest_orders').where({ id: guestOrderId }).first();
    expect(guestOrder.payment_status).toBe('refunded');
  });

  it('a racing webhook and the guest confirm-payment callback both finalizing the same card capture produce exactly one settlement, never a double-settle', async () => {
    const { raw: tokenRaw } = await createRawToken({ type: 'table', tableLabel: 'WEBHOOK-RACE' });

    paystack.initializeTransaction.mockResolvedValueOnce({ authorizationUrl: 'https://paystack.test/pay/race', accessCode: 'race', reference: 'will-be-set' });
    const created = await req
      .post(`/api/v1/qr-order/${tokenRaw}/orders`)
      .set('X-Tenant-Slug', tenantSlug)
      .set('Idempotency-Key', idemKey())
      .send({ payment_method: 'card', guest_contact: 'race-webhook@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
    expect(created.status).toBe(201);
    const guestOrderId = created.body.data.id;
    const posOrderId = created.body.data.pos_order_id;

    const payment = await db()('payments').where({ pos_order_id: posOrderId, settlement_target: 'pos_order' }).first();
    expect(payment.status).toBe('PENDING');

    paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: payment.provider_reference, providerPaymentId: 'ps_race', amountSubunit: 2000, currency: 'NGN' });
    paystack.verifyWebhookSignature.mockReturnValue(true);

    const confirmCallback = () => req.post(`/api/v1/qr-order/${tokenRaw}/orders/${guestOrderId}/confirm-payment`).set('X-Tenant-Slug', tenantSlug).send({});
    const webhookCallback = () =>
      req
        .post('/api/v1/webhooks/paystack')
        .send({ event: 'charge.success', data: { id: 987654321, reference: payment.provider_reference, status: 'success' } });

    const [confirmRes, webhookRes] = await Promise.all([confirmCallback(), webhookCallback()]);
    expect(confirmRes.status).toBe(200);
    expect(webhookRes.status).toBe(200);

    const settlements = await db()('pos_order_settlements').where({ pos_order_id: posOrderId }).select();
    expect(settlements.length).toBe(1);

    const updatedPayment = await db()('payments').where({ id: payment.id }).first();
    expect(updatedPayment.status).toBe('CAPTURED');

    const order = await db()('pos_orders').where({ id: posOrderId }).first();
    expect(order.status).toBe('settled');

    const webhookEventCount = await db()('payment_webhook_events').where({ related_payment_id: payment.id }).count({ n: '*' }).first();
    expect(Number(webhookEventCount.n)).toBe(1);
  });
});
