'use strict';

/**
 * HTTP-level tests for QR self-ordering — PLAN.md Phase 6
 * (PRODUCT_REQUIREMENTS.md §3.4's QR-ordering section). Covers the
 * guest-facing anonymous flow (menu, cart, card checkout, charge-to-room
 * via the emailed OTP), the staff-facing token/queue management
 * (`pos.operate`/`pos.manage` split), full RBAC, cross-tenant isolation,
 * and — the security-critical path this session asked to be mutation-
 * tested hardest — a forged/tampered token being rejected exactly like a
 * merely-nonexistent one.
 *
 * Paystack is mocked deterministically, exactly like
 * `tests/portal/booking.test.js`/`tests/cashiering/cashiering.test.js`
 * already mock it — a real, unmocked sandbox round trip is confirmed
 * separately, in this pass's own live-verification step.
 *
 * ── AMBIENT TAX ──────────────────────────────────────────────────────────
 *
 * `tests/helpers/fixtures.js` seeds a real 7.5% VAT tax (`applies_to:
 * 'all'`) on `ctx.a`'s property, applying to `pos_charge` the same as
 * `tests/pos/pos.test.js`'s own header already documents for room/POS
 * charges: a ₦20.00 item's tax is always ₦1.50.
 */

jest.mock('../../src/modules/cashiering/paystack-adapter', () => ({
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  refundTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const paystack = require('../../src/modules/cashiering/paystack-adapter');
const { rateLimitRedisConnection, destroyRateLimitRedisConnection } = require('../../src/shared/rate-limit-redis-connection');

/**
 * This file's own order-creation volume (dozens of real `POST .../orders`
 * calls, all from the same in-process "IP") would otherwise collide with
 * the real per-IP rate limiter's own 60-second window — genuine
 * production behaviour (ARCHITECTURE.md §15), but real Redis state that
 * persists across repeated runs of this same file within that window.
 * Flushed once up front so this suite's own volume is never mistaken for
 * the abuse that limiter exists to catch; the per-token/dedicated rate
 * limiter tests live in their own file (`rate-limit.test.js`) and are
 * unaffected either way. Also covers the two dedicated OTP request/verify
 * per-IP counters (code-review fix, IMPORTANT) this file's own
 * charge-to-room block now drives several real calls through.
 */
async function flushIpRateLimitKeys() {
  const redis = rateLimitRedisConnection();
  const keys = await redis.keys('qr-order-ip-rl:*');
  const otpKeys = [...(await redis.keys('qr-otp-request-ip-rl:*')), ...(await redis.keys('qr-otp-verify-ip-rl:*'))];
  const all = [...keys, ...otpKeys];
  if (all.length) await redis.del(...all);
}

describe('QR self-ordering (PLAN.md Phase 6)', () => {
  const t = useTestApp();
  let ctx;
  let outletId;
  let menuItemId;
  let unavailableMenuItemId;
  let roomId;
  let idemCounter = 0;

  function idemKey() {
    idemCounter += 1;
    return `qr-idem-${idemCounter}`;
  }

  function staffToken({ tenant = ctx.a, userId, propertyId } = {}) {
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

  function guestGet(path) {
    return t.request.get(`/api/v1/qr-order${path}`).set('X-Tenant-Slug', ctx.a.slug);
  }
  function guestPost(path) {
    return t.request.post(`/api/v1/qr-order${path}`).set('X-Tenant-Slug', ctx.a.slug);
  }

  beforeAll(async () => {
    await flushIpRateLimitKeys();
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-05-01' });

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
      name: 'QR Test Item',
      category: 'Drinks',
      price: '20.00',
    });
    menuItemId = menuId;

    const [unavailableId] = await t.trx('pos_menu_items').insert({
      tenant_id: ctx.a.id,
      property_id: ctx.a.properties[0].id,
      outlet_id: outletId,
      name: 'Sold Out Item',
      category: 'Drinks',
      price: '10.00',
      is_available: false,
    });
    unavailableMenuItemId = unavailableId;

    roomId = ctx.a.rooms[0].id;
    await grantRoleToUser({ tenant: ctx.a, userIndex: 0, role: 'manager' });
  });

  async function createStaffToken({ type, tableLabel, roomIdParam } = {}) {
    const res = await t.request
      .post('/api/v1/pos/qr-tokens')
      .set('Authorization', `Bearer ${staffToken()}`)
      .send({ outlet_id: outletId, type: type ?? 'table', table_label: tableLabel, room_id: roomIdParam, base_url: 'https://alpha-hotels.test/qr-order' });
    return res;
  }

  // -----------------------------------------------------------------
  // Staff — token management
  // -----------------------------------------------------------------

  describe('staff token management', () => {
    it('pos.manage creates a real token, decryptable back to the exact raw value', async () => {
      const res = await createStaffToken({ type: 'table', tableLabel: 'STAFF-T1' });
      expect(res.status).toBe(201);
      expect(res.body.data.token.token_hash).toBeDefined();
      expect(res.body.meta.rawToken).toBeDefined();
      expect(res.body.data.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);

      const list = await t.request.get('/api/v1/pos/qr-tokens').set('Authorization', `Bearer ${staffToken()}`);
      const found = list.body.data.find((row) => row.id === res.body.data.token.id);
      expect(found.raw_token).toBe(res.body.meta.rawToken);
    });

    it('pos.operate cannot manage tokens (403)', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'pos_operator' });
      const res = await createStaffToken({ type: 'table', tableLabel: 'DENY' });
      // Use the operator's own token instead
      const opRes = await t.request
        .post('/api/v1/pos/qr-tokens')
        .set('Authorization', `Bearer ${staffToken({ userId: ctx.a.users[1].id })}`)
        .send({ outlet_id: outletId, type: 'table', table_label: 'DENY2' });
      expect(opRes.status).toBe(403);
      expect(res.status).toBe(201); // manager's own call still succeeds
    });

    it('regenerating deactivates the old row (rotated_at set) and returns a genuinely different working code', async () => {
      const created = await createStaffToken({ type: 'table', tableLabel: 'ROTATE-ME' });
      const oldId = created.body.data.token.id;
      const oldRaw = created.body.meta.rawToken;

      const regen = await t.request
        .post(`/api/v1/pos/qr-tokens/${oldId}/regenerate`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({});
      expect(regen.status).toBe(201);
      expect(regen.body.meta.rawToken).not.toBe(oldRaw);

      const oldRow = await t.trx('pos_order_tokens').where({ id: oldId }).first();
      expect(oldRow.active).toBe(0);
      expect(oldRow.rotated_at).not.toBeNull();

      // The old raw token no longer resolves at all.
      const oldMenu = await guestGet(`/${oldRaw}/menu`);
      expect(oldMenu.status).toBe(404);

      // The new one does.
      const newMenu = await guestGet(`/${regen.body.meta.rawToken}/menu`);
      expect(newMenu.status).toBe(200);
    });

    it('deactivate then reactivate genuinely restores the SAME code — reversible, not a one-way revoke', async () => {
      const created = await createStaffToken({ type: 'table', tableLabel: 'TOGGLE-ME' });
      const raw = created.body.meta.rawToken;
      const id = created.body.data.token.id;

      const deactivated = await t.request.post(`/api/v1/pos/qr-tokens/${id}/deactivate`).set('Authorization', `Bearer ${staffToken()}`).send({});
      expect(deactivated.status).toBe(200);
      expect((await guestGet(`/${raw}/menu`)).status).toBe(404);

      const reactivated = await t.request.post(`/api/v1/pos/qr-tokens/${id}/reactivate`).set('Authorization', `Bearer ${staffToken()}`).send({});
      expect(reactivated.status).toBe(200);
      const menuAgain = await guestGet(`/${raw}/menu`);
      expect(menuAgain.status).toBe(200);
    });

    it('a nonexistent token id 404s on regenerate/deactivate/reactivate', async () => {
      const bearer = `Bearer ${staffToken()}`;
      expect((await t.request.post('/api/v1/pos/qr-tokens/999999999/regenerate').set('Authorization', bearer).send({})).status).toBe(404);
      expect((await t.request.post('/api/v1/pos/qr-tokens/999999999/deactivate').set('Authorization', bearer).send({})).status).toBe(404);
      expect((await t.request.post('/api/v1/pos/qr-tokens/999999999/reactivate').set('Authorization', bearer).send({})).status).toBe(404);
    });

    it('toggling guest ordering and updating the policy both work and are real', async () => {
      const off = await t.request
        .post(`/api/v1/pos/outlets/${outletId}/toggle-guest-ordering`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ enabled: false });
      expect(off.status).toBe(200);
      expect(off.body.data.guest_ordering_enabled).toBe(0);

      const back = await t.request
        .post(`/api/v1/pos/outlets/${outletId}/toggle-guest-ordering`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ enabled: true });
      expect(back.status).toBe(200);
      expect(back.body.data.guest_ordering_enabled).toBe(1);

      const policy = await t.request
        .patch(`/api/v1/pos/outlets/${outletId}/guest-order-policy`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ accept_timeout_minutes: 15, rate_limit_max: 8, max_unpaid_value: '500.00' });
      expect(policy.status).toBe(200);
      expect(policy.body.data.guest_order_accept_timeout_minutes).toBe(15);
      expect(policy.body.data.guest_order_rate_limit_max).toBe(8);
      expect(policy.body.data.guest_order_max_unpaid_value).toBe('500.00');

      // Restore for the rest of the suite.
      await t.trx('pos_outlets').where({ id: outletId }).update({
        guest_order_accept_timeout_minutes: 10,
        guest_order_rate_limit_max: 100,
        guest_order_max_unpaid_value: null,
      });
    });
  });

  // -----------------------------------------------------------------
  // Guest — anonymous access, forged/tampered token rejection
  // -----------------------------------------------------------------

  describe('guest menu access and token forgery', () => {
    let tableRaw;

    beforeAll(async () => {
      const created = await createStaffToken({ type: 'table', tableLabel: 'MENU-T1' });
      tableRaw = created.body.meta.rawToken;
    });

    it('a valid token shows the real, available menu', async () => {
      const res = await guestGet(`/${tableRaw}/menu`);
      expect(res.status).toBe(200);
      const names = res.body.data.items.map((i) => i.name);
      expect(names).toContain('QR Test Item');
      expect(names).not.toContain('Sold Out Item');
    });

    it('a completely nonexistent token 404s, same as a real-but-inactive one', async () => {
      expect((await guestGet('/totally-made-up-token-value/menu')).status).toBe(404);
    });

    it('a forged token — right shape, wrong value — is rejected exactly like a nonexistent one (SECURITY-CRITICAL)', async () => {
      // Same length/charset as a real token, but never actually issued.
      const forged = 'A'.repeat(43);
      const res = await guestGet(`/${forged}/menu`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBeNull();
    });

    it('a tampered real token (one character flipped) is rejected — the hash no longer matches anything', async () => {
      const tampered = tableRaw.slice(0, -1) + (tableRaw.slice(-1) === 'A' ? 'B' : 'A');
      const res = await guestGet(`/${tampered}/menu`);
      expect(res.status).toBe(404);
    });

    it("a real token from a DIFFERENT tenant never resolves under this tenant's Host (cross-tenant isolation)", async () => {
      await grantRoleToUser({ tenant: ctx.b, userIndex: 0, role: 'manager' });
      const created = await t.request
        .post('/api/v1/pos/qr-tokens')
        .set(
          'Authorization',
          `Bearer ${signAccessToken({ aud: 'staff', sub: String(ctx.b.users[0].id), tenant_id: String(ctx.b.id), property_id: String(ctx.b.properties[0].id) })}`
        )
        .send({ outlet_id: ctx.b.posOutlets[0].id, type: 'table', table_label: 'B-TABLE', base_url: 'https://beta.test/qr-order' });
      expect(created.status).toBe(201);
      const bRaw = created.body.meta.rawToken;

      // Requested under tenant A's own Host/slug — must not resolve.
      const res = await guestGet(`/${bRaw}/menu`);
      expect(res.status).toBe(404);

      // But it DOES resolve under its own tenant's Host (once that
      // tenant's own outlet has opted into guest ordering — a separate,
      // per-outlet setting from tenant A's).
      await t.trx('pos_outlets').where({ id: ctx.b.posOutlets[0].id }).update({ guest_ordering_enabled: true });
      const okRes = await t.request.get(`/api/v1/qr-order/${bRaw}/menu`).set('X-Tenant-Slug', ctx.b.slug);
      expect(okRes.status).toBe(200);
    });

    it('a disabled outlet rejects the menu request even with an otherwise-valid, active token', async () => {
      await t.trx('pos_outlets').where({ id: outletId }).update({ guest_ordering_enabled: false });
      const res = await guestGet(`/${tableRaw}/menu`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_GUEST_ORDERING_DISABLED');
      await t.trx('pos_outlets').where({ id: outletId }).update({ guest_ordering_enabled: true });
    });
  });

  // -----------------------------------------------------------------
  // Guest — branding (user-directed fix: reuse the guest booking portal's
  // OWN theming mechanism, not a second one — GET .../branding calls the
  // identical portalService.getPropertyBranding backend.test.js's own
  // "returns real property branding" case already proves for the
  // property-slug-keyed route).
  // -----------------------------------------------------------------

  describe('guest branding — reuses the portal\'s own mechanism', () => {
    let tableRaw;

    beforeAll(async () => {
      const created = await createStaffToken({ type: 'table', tableLabel: 'BRAND-T1' });
      tableRaw = created.body.meta.rawToken;
    });

    it('returns the real property branding, the same shape the portal\'s own endpoint returns', async () => {
      const res = await guestGet(`/${tableRaw}/branding`);
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBeTruthy();
      expect(res.body.data.baseCurrency).toBeTruthy();
      expect(res.body.data).toHaveProperty('logoUrl');
      expect(res.body.data).toHaveProperty('theme');
    });

    it('a nonexistent/forged token 404s, same as every other guest-facing route', async () => {
      const res = await guestGet('/totally-made-up-token-value/branding');
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------
  // Guest — card checkout, full happy path + failure paths
  // -----------------------------------------------------------------

  describe('guest card ordering', () => {
    let tableRaw;

    beforeAll(async () => {
      const created = await createStaffToken({ type: 'table', tableLabel: 'CARD-T1' });
      tableRaw = created.body.meta.rawToken;
    });

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('rejects an empty cart', async () => {
      const res = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'guest@example.com', items: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_EMPTY_CART');
    });

    it('rejects card payment with no valid email', async () => {
      const res = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(res.status).toBe(400);
    });

    it('rejects an unavailable menu item', async () => {
      const res = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'guest@example.com', items: [{ menu_item_id: unavailableMenuItemId, quantity: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_POS_ITEM_UNAVAILABLE');
    });

    it('rejects a menu item id from a different outlet/tenant', async () => {
      const res = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'guest@example.com', items: [{ menu_item_id: ctx.b.posMenuItems[0].id, quantity: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MENU_ITEM_NOT_FOUND');
    });

    it('requires the Idempotency-Key header', async () => {
      const res = await guestPost(`/${tableRaw}/orders`).send({ payment_method: 'card', guest_contact: 'g@e.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_MISSING_IDEMPOTENCY_KEY');
    });

    it('creates the order and immediately returns a real Paystack checkout link/access code', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/qr1', accessCode: 'qr1', reference: 'will-be-overridden' });

      const res = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'diner@example.com', guest_name: 'Diner', items: [{ menu_item_id: menuItemId, quantity: 2 }] });

      expect(res.status).toBe(201);
      expect(res.body.data.payment_method).toBe('card');
      expect(res.body.data.status).toBe('awaiting_payment');
      expect(res.body.data.payment_status).toBe('unpaid');
      expect(res.body.meta.authorizationUrl).toBe('https://paystack.test/pay/qr1');
      expect(res.body.meta.accessCode).toBe('qr1');

      const order = await t.trx('pos_orders').where({ id: res.body.data.pos_order_id }).first();
      expect(order.source).toBe('guest');
      expect(order.status).toBe('open');

      const payment = await t.trx('payments').where({ pos_order_id: order.id }).first();
      expect(payment.settlement_target).toBe('pos_order');
      expect(payment.amount).toBe('43.00'); // 2 x 20.00 + 7.5% VAT (3.00) = 43.00
      expect(payment.status).toBe('PENDING');
    });

    it('surfaces an honest 202 with the real created order when the gateway call itself fails', async () => {
      paystack.initializeTransaction.mockRejectedValue(new Error('Paystack unreachable'));

      const res = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'diner2@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });

      expect(res.status).toBe(202);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.meta.checkoutError).toContain('Paystack unreachable');
      expect(res.body.meta.retry).toContain('/confirm-payment');
    });

    it('retry-checkout genuinely retries the local, already-created intent', async () => {
      paystack.initializeTransaction.mockRejectedValueOnce(new Error('flaky'));
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'diner3@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(created.status).toBe(202);

      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/retry', accessCode: 'retry', reference: 'r' });
      const retried = await guestPost(`/${tableRaw}/orders/${created.body.data.id}/retry-checkout`).send({});
      expect(retried.status).toBe(200);
      expect(retried.body.meta.authorizationUrl).toBe('https://paystack.test/pay/retry');
    });

    it('replaying the same Idempotency-Key never double-creates the order', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/dup', accessCode: 'd', reference: 'r' });
      const key = idemKey();
      const payload = { payment_method: 'card', guest_contact: 'dup@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] };

      const first = await guestPost(`/${tableRaw}/orders`).set('Idempotency-Key', key).send(payload);
      const second = await guestPost(`/${tableRaw}/orders`).set('Idempotency-Key', key).send(payload);
      expect(first.body.data.id).toBe(second.body.data.id);

      const count = await t.trx('pos_guest_orders').where({ id: first.body.data.id }).count({ n: '*' }).first();
      expect(Number(count.n)).toBe(1);
    });

    it('confirm-payment (the return-from-gateway callback) genuinely captures and settles the order', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/confirm', accessCode: 'c', reference: 'r' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'confirmed@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(created.status).toBe(201);

      paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'r', providerPaymentId: 'ps_qr_1', amountSubunit: 2150, currency: 'NGN' });
      const confirmed = await guestPost(`/${tableRaw}/orders/${created.body.data.id}/confirm-payment`).send({});
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data.payment.status).toBe('CAPTURED');
      expect(confirmed.body.data.guestOrder.payment_status).toBe('paid');
      expect(confirmed.body.data.guestOrder.status).toBe('received');

      const order = await t.trx('pos_orders').where({ id: created.body.data.pos_order_id }).first();
      expect(order.status).toBe('settled');
      const settlement = await t.trx('pos_order_settlements').where({ pos_order_id: order.id }).first();
      expect(settlement.method).toBe('card');
      expect(settlement.subtotal).toBe('20.00');
      expect(settlement.tax_amount).toBe('1.50');
    });

    it('a failed gateway verification leaves the order unpaid, never settled', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/fail', accessCode: 'f', reference: 'r' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'failed@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });

      paystack.verifyTransaction.mockResolvedValue({ status: 'failed', reference: 'r', providerPaymentId: 'ps_qr_2', amountSubunit: 2150, currency: 'NGN' });
      const confirmed = await guestPost(`/${tableRaw}/orders/${created.body.data.id}/confirm-payment`).send({});
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data.payment.status).toBe('FAILED');
      expect(confirmed.body.data.guestOrder.payment_status).toBe('unpaid');
      expect(confirmed.body.data.guestOrder.status).toBe('awaiting_payment');
    });

    it("one guest cannot read or act on another table's order id (token-scoped ownership)", async () => {
      const created = await createStaffToken({ type: 'table', tableLabel: 'OTHER-TABLE' });
      const otherRaw = created.body.meta.rawToken;

      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/own', accessCode: 'o', reference: 'r' });
      const own = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'own@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });

      const crossRead = await t.request.get(`/api/v1/qr-order/${otherRaw}/orders/${own.body.data.id}`).set('X-Tenant-Slug', ctx.a.slug);
      expect(crossRead.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------
  // Guest — charge-to-room via the emailed OTP
  // -----------------------------------------------------------------

  describe('guest charge-to-room via emailed OTP', () => {
    let roomRaw;
    let reservationId;
    let folioId;

    beforeAll(async () => {
      const created = await createStaffToken({ type: 'room', roomIdParam: roomId });
      roomRaw = created.body.meta.rawToken;

      const suffix = `${Date.now()}`;
      const [resId] = await t.trx('reservations').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        guest_id: ctx.a.guests[0].id,
        room_type_id: ctx.a.roomTypes[0].id,
        rate_code_id: ctx.a.rateCodes[0].id,
        arrival_date: '2027-05-01',
        departure_date: '2027-05-05',
        adults: 1,
        children: 0,
        status: 'checked_in',
        confirmation_number: `QROTP${suffix}`.toUpperCase().slice(0, 26),
        checked_in_at: new Date(),
      });
      reservationId = resId;
      await t.trx('reservation_rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        reservation_id: reservationId,
        room_id: roomId,
        effective_from: new Date(),
        effective_to: null,
      });
      const [fId] = await t.trx('folios').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        reservation_id: reservationId,
        folio_number: `QROTPFOLIO${suffix}`.toUpperCase().slice(0, 26),
        status: 'open',
        balance: '0.00',
        currency: 'NGN',
      });
      folioId = fId;
    });

    async function createRoomChargeOrder() {
      const res = await guestPost(`/${roomRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(res.status).toBe(201);
      return res.body.data;
    }

    it('rejects room_charge against a TABLE token', async () => {
      const created = await createStaffToken({ type: 'table', tableLabel: 'NOT-A-ROOM' });
      const res = await guestPost(`/${created.body.meta.rawToken}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_WRONG_PAYMENT_METHOD');
    });

    it('confirm-name returns a genuinely masked guest name, never the full name', async () => {
      const order = await createRoomChargeOrder();
      const res = await guestGet(`/${roomRaw}/orders/${order.id}/room-charge/confirm-name`);
      expect(res.status).toBe(200);
      expect(res.body.data.maskedName).toMatch(/^J\*+ \w\.$/);
      expect(res.body.data.maskedName).not.toContain('Jordan');
    });

    it('a room with no in-house reservation is rejected outright', async () => {
      // A genuinely vacant room — no reservation_rooms assignment at all.
      const [vacantRoomId] = await t.trx('rooms').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        room_type_id: ctx.a.roomTypes[0].id,
        room_number: `VAC-${Date.now()}`,
      });
      const vacantToken = await createStaffToken({ type: 'room', roomIdParam: vacantRoomId });
      const order = await (async () => {
        const res = await guestPost(`/${vacantToken.body.meta.rawToken}/orders`)
          .set('Idempotency-Key', idemKey())
          .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
        return res.body.data;
      })();
      const res = await guestGet(`/${vacantToken.body.meta.rawToken}/orders/${order.id}/room-charge/confirm-name`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BUSINESS_RULE_NO_IN_HOUSE_RESERVATION');
    });

    it('request-otp emails the real in-house reservation contact and returns a dev-only code outside production', async () => {
      const order = await createRoomChargeOrder();
      const res = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.devOnlyCode).toMatch(/^\d{6}$/);

      const otpRow = await t.trx('pos_room_charge_otps').where({ pos_order_id: order.pos_order_id }).orderBy('id', 'desc').first();
      expect(String(otpRow.reservation_id)).toBe(String(reservationId));
      expect(otpRow.used_at).toBeNull();

      const outboxEvent = await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'pos.room_charge_otp_requested' }).orderBy('id', 'desc').first();
      expect(outboxEvent).toBeDefined();
      const payload = typeof outboxEvent.payload === 'string' ? JSON.parse(outboxEvent.payload) : outboxEvent.payload;
      // `t.guests[0]` in the fixture object only carries `id`, not the
      // email it was inserted with (`tests/helpers/fixtures.js`'s own
      // `guests.push` shape) — reconstruct the real value it seeded.
      expect(payload.recipientEmail).toBe(`guest-${ctx.a.slug}@example.com`);
      expect(payload.code).toBe(res.body.data.devOnlyCode);
    });

    it('a wrong code is rejected and increments attempts; the real code still works afterward', async () => {
      const order = await createRoomChargeOrder();
      const otpRes = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      const realCode = otpRes.body.data.devOnlyCode;

      const wrong = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code: '000001' === realCode ? '000002' : '000001' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('AUTH_OTP_INVALID');

      const otpRow = await t.trx('pos_room_charge_otps').where({ pos_order_id: order.pos_order_id }).whereNull('used_at').orderBy('id', 'desc').first();
      expect(otpRow.attempts).toBe(1);

      const right = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code: realCode });
      expect(right.status).toBe(200);
      expect(right.body.data.guestOrder.payment_status).toBe('charged_to_room');
      expect(right.body.data.guestOrder.status).toBe('received');
    });

    it('the correct code genuinely settles the order as a real room_charge, posting a real folio charge', async () => {
      const order = await createRoomChargeOrder();
      const otpRes = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      const code = otpRes.body.data.devOnlyCode;

      const verify = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code });
      expect(verify.status).toBe(200);

      const settlement = await t.trx('pos_order_settlements').where({ pos_order_id: order.pos_order_id, method: 'room_charge' }).first();
      expect(settlement.room_charge_auth_method).toBe('guest_otp');
      expect(String(settlement.folio_id)).toBe(String(folioId));

      const folio = await t.trx('folios').where({ id: folioId }).first();
      expect(folio.balance).not.toBe('0.00');
    });

    it('a code cannot be reused after it has already settled an order', async () => {
      const order = await createRoomChargeOrder();
      const otpRes = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      const code = otpRes.body.data.devOnlyCode;
      await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code });

      const replay = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code });
      expect(replay.status).toBe(409); // already paid
    });

    it('an expired code is rejected', async () => {
      const order = await createRoomChargeOrder();
      const otpRes = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      const code = otpRes.body.data.devOnlyCode;
      await t.trx('pos_room_charge_otps').where({ pos_order_id: order.pos_order_id }).whereNull('used_at').update({ expires_at: new Date(Date.now() - 60_000) });

      const res = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code });
      expect(res.status).toBe(401);
    });

    it('5 wrong attempts exhaust the code, and the correct code no longer works afterward', async () => {
      const order = await createRoomChargeOrder();
      const otpRes = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      const code = otpRes.body.data.devOnlyCode;
      const wrongCode = code === '999999' ? '888888' : '999999';

      for (let i = 0; i < 5; i += 1) {
        const res = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code: wrongCode });
        expect(res.status).toBe(401);
      }
      const finalTry = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code });
      expect(finalTry.status).toBe(401);
    });

    it('a repeat OTP request supersedes the earlier still-outstanding code', async () => {
      const order = await createRoomChargeOrder();
      const first = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      const second = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      expect(first.body.data.devOnlyCode).not.toBe(second.body.data.devOnlyCode);

      const stale = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code: first.body.data.devOnlyCode });
      expect(stale.status).toBe(401);

      const fresh = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code: second.body.data.devOnlyCode });
      expect(fresh.status).toBe(200);
    });

    it('rejecting a room-charge order still awaiting payment voids the tab and blocks a subsequent request-otp (CRITICAL code-review fix)', async () => {
      const order = await createRoomChargeOrder();

      const rejected = await t.request
        .post(`/api/v1/pos/guest-orders/${order.id}/reject`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ reason: 'Kitchen closed' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.status).toBe('rejected');
      expect(rejected.body.data.payment_status).toBe('unpaid'); // never actually charged

      const underlyingOrder = await t.trx('pos_orders').where({ id: order.pos_order_id }).first();
      expect(underlyingOrder.status).toBe('void');

      const otpAttempt = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      expect(otpAttempt.status).toBe(409);
      expect(otpAttempt.body.error.code).toBe('CONFLICT_GUEST_ORDER_ALREADY_REJECTED');
    });

    it('rejecting after an OTP was requested (but not yet verified) blocks a subsequent verify with the real, correct code (CRITICAL code-review fix)', async () => {
      const order = await createRoomChargeOrder();
      const otpRes = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      const code = otpRes.body.data.devOnlyCode;

      const rejected = await t.request
        .post(`/api/v1/pos/guest-orders/${order.id}/reject`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ reason: 'Guest cancelled the order' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.status).toBe('rejected');

      const verifyAttempt = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/verify`).send({ code });
      expect(verifyAttempt.status).toBe(409);
      expect(verifyAttempt.body.error.code).toBe('CONFLICT_GUEST_ORDER_ALREADY_REJECTED');

      // Never settled — no folio charge, no settlement row, ever posted.
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: order.pos_order_id, method: 'room_charge' }).first()).toBeUndefined();
      const guestOrderAfter = await t.trx('pos_guest_orders').where({ id: order.id }).first();
      expect(guestOrderAfter.payment_status).toBe('unpaid');
    });

    it('auto-reject exhibits the identical protection — a forced "received but still unpaid" order cannot be resurrected either (defense in depth)', async () => {
      const order = await createRoomChargeOrder();
      // `tryAutoReject`'s own WHERE clause only ever claims a REAL
      // `received` row in production, and a room-charge order only ever
      // reaches `received` once real OTP settlement already completed
      // (`payment_status` is never actually `unpaid` there) — this state
      // is forced directly here to prove the SHARED
      // `reverseGuestOrderPayment` mechanism protects this hypothetical
      // shape too, not just the real `awaiting_payment` one the two tests
      // above cover.
      await t.trx('pos_guest_orders').where({ id: order.id }).update({
        status: 'received',
        accepted_at: null,
        updated_at: new Date(Date.now() - 11 * 60 * 1000),
      });

      const polled = await guestGet(`/${roomRaw}/orders/${order.id}`);
      expect(polled.status).toBe(200);
      expect(polled.body.data.status).toBe('auto_rejected');
      expect(polled.body.data.payment_status).toBe('unpaid');

      const underlyingOrder = await t.trx('pos_orders').where({ id: order.pos_order_id }).first();
      expect(underlyingOrder.status).toBe('void');

      const otpAttempt = await guestPost(`/${roomRaw}/orders/${order.id}/room-charge/request-otp`).send({});
      expect(otpAttempt.status).toBe(409);
      expect(otpAttempt.body.error.code).toBe('CONFLICT_GUEST_ORDER_ALREADY_REJECTED');
    });
  });

  // -----------------------------------------------------------------
  // Staff — guest order queue: accept / mark-on-the-way / reject
  // -----------------------------------------------------------------

  describe('staff guest-order queue', () => {
    let tableRaw;

    beforeAll(async () => {
      // This file's own cumulative order-creation volume by this point
      // (several describe blocks earlier, now including this pass's own
      // new reject-while-unpaid regression tests) can otherwise approach
      // the real, shared per-IP order-creation limiter's own 30/minute
      // ceiling — a real production guard (ARCHITECTURE.md §15), but not
      // something this describe block's OWN tests exist to exercise.
      // Flushed for the same reason the file's own top-level `beforeAll`
      // already flushes once at the very start.
      await flushIpRateLimitKeys();
      const created = await createStaffToken({ type: 'table', tableLabel: 'QUEUE-T1' });
      tableRaw = created.body.meta.rawToken;
    });

    async function createPaidCardOrder() {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/q', accessCode: 'q', reference: 'r' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'queue@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'r', providerPaymentId: 'ps_q', amountSubunit: 2150, currency: 'NGN' });
      await guestPost(`/${tableRaw}/orders/${created.body.data.id}/confirm-payment`).send({});
      return created.body.data.id;
    }

    it('pos.operate can list, accept, mark-on-the-way a real guest order', async () => {
      const id = await createPaidCardOrder();
      const list = await t.request.get('/api/v1/pos/guest-orders').set('Authorization', `Bearer ${staffToken()}`);
      expect(list.status).toBe(200);
      expect(list.body.data.some((row) => row.id === id)).toBe(true);

      const accept = await t.request.post(`/api/v1/pos/guest-orders/${id}/accept`).set('Authorization', `Bearer ${staffToken()}`).send({});
      expect(accept.status).toBe(200);
      expect(accept.body.data.status).toBe('preparing');
      expect(accept.body.data.accepted_at).not.toBeNull();

      const onTheWay = await t.request.post(`/api/v1/pos/guest-orders/${id}/mark-on-the-way`).set('Authorization', `Bearer ${staffToken()}`).send({});
      expect(onTheWay.status).toBe(200);
      expect(onTheWay.body.data.status).toBe('on_the_way');
    });

    it('rejecting a paid card order refunds it in full and marks it rejected', async () => {
      const id = await createPaidCardOrder();
      const orderBefore = await t.trx('pos_guest_orders').where({ id }).first();
      paystack.refundTransaction.mockResolvedValue({ status: 'processed' });

      const rejected = await t.request
        .post(`/api/v1/pos/guest-orders/${id}/reject`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ reason: 'Kitchen closed' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.status).toBe('rejected');
      expect(rejected.body.data.payment_status).toBe('refunded');

      // Two real rows now exist: the original capture (now REFUNDED) and a
      // brand-new refund payment row (its own status CAPTURED once
      // processed, `parent_payment_id` linking it back) — the identical
      // shape `refundPayment`'s own cash branch already establishes.
      const original = await t.trx('payments').where({ pos_order_id: orderBefore.pos_order_id, settlement_target: 'pos_order' }).whereNull('parent_payment_id').first();
      expect(original.status).toBe('REFUNDED');
      const refundRow = await t.trx('payments').where({ parent_payment_id: original.id }).first();
      expect(refundRow.status).toBe('CAPTURED');
      expect(refundRow.settlement_target).toBe('pos_order');

      const settlement = await t.trx('pos_order_settlements').where({ pos_order_id: orderBefore.pos_order_id }).first();
      expect(settlement.voided_at).not.toBeNull();
    });

    it('rejecting a card order still awaiting payment voids the tab and cancels its in-flight payment — a later gateway success can no longer capture it (CRITICAL code-review fix)', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/unpaid-reject', accessCode: 'ur', reference: 'r' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'unpaid-reject@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(created.status).toBe(201);
      const id = created.body.data.id;
      const posOrderId = created.body.data.pos_order_id;

      const paymentBefore = await t.trx('payments').where({ pos_order_id: posOrderId, settlement_target: 'pos_order' }).first();
      expect(paymentBefore.status).toBe('PENDING'); // startGuestOrderCheckout already advanced it past INITIATED

      const rejected = await t.request
        .post(`/api/v1/pos/guest-orders/${id}/reject`)
        .set('Authorization', `Bearer ${staffToken()}`)
        .send({ reason: 'Never accepted' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.status).toBe('rejected');
      expect(rejected.body.data.payment_status).toBe('unpaid'); // never actually paid — nothing to "refund"

      const orderAfterReject = await t.trx('pos_orders').where({ id: posOrderId }).first();
      expect(orderAfterReject.status).toBe('void');
      const paymentAfterReject = await t.trx('payments').where({ id: paymentBefore.id }).first();
      expect(paymentAfterReject.status).toBe('CANCELLED');

      // A late gateway success — a delayed webhook, or the guest's own
      // confirm-payment callback landing after the fact — must never
      // resurrect this order or capture the cancelled payment.
      paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'r', providerPaymentId: 'ps_late', amountSubunit: 2150, currency: 'NGN' });
      const confirmAttempt = await guestPost(`/${tableRaw}/orders/${id}/confirm-payment`).send({});
      expect(confirmAttempt.status).toBe(409);
      expect(confirmAttempt.body.error.code).toBe('CONFLICT_GUEST_ORDER_ALREADY_REJECTED');

      const paymentAfterLateConfirm = await t.trx('payments').where({ id: paymentBefore.id }).first();
      expect(paymentAfterLateConfirm.status).toBe('CANCELLED'); // still cancelled — never captured
      const orderAfterLateConfirm = await t.trx('pos_orders').where({ id: posOrderId }).first();
      expect(orderAfterLateConfirm.status).toBe('void'); // still void — never settled
      expect(await t.trx('pos_order_settlements').where({ pos_order_id: posOrderId }).first()).toBeUndefined();
    });

    it('rejecting requires a reason', async () => {
      const id = await createPaidCardOrder();
      const res = await t.request.post(`/api/v1/pos/guest-orders/${id}/reject`).set('Authorization', `Bearer ${staffToken()}`).send({});
      expect(res.status).toBe(400);
    });

    it('housekeeping (no pos.operate) is refused on the queue', async () => {
      await grantRoleToUser({ tenant: ctx.a, userIndex: 1, role: 'housekeeping' });
      const res = await t.request.get('/api/v1/pos/guest-orders').set('Authorization', `Bearer ${staffToken({ userId: ctx.a.users[1].id })}`);
      expect(res.status).toBe(403);
    });

    it("accepting an order not currently 'received' is a real conflict, not a silent success", async () => {
      const id = await createPaidCardOrder();
      await t.request.post(`/api/v1/pos/guest-orders/${id}/accept`).set('Authorization', `Bearer ${staffToken()}`).send({});
      const again = await t.request.post(`/api/v1/pos/guest-orders/${id}/accept`).set('Authorization', `Bearer ${staffToken()}`).send({});
      expect(again.status).toBe(409);
    });
  });

  // -----------------------------------------------------------------
  // Auto-reject — the lazy, on-read check
  // -----------------------------------------------------------------

  describe('lazy auto-reject', () => {
    let tableRaw;

    beforeAll(async () => {
      // Same reasoning as "staff guest-order queue"'s own flush above —
      // this file's cumulative order-creation volume by this point can
      // otherwise approach the real, shared per-IP limiter's ceiling.
      await flushIpRateLimitKeys();
      await t.trx('pos_outlets').where({ id: outletId }).update({ guest_order_accept_timeout_minutes: 10 });
      const created = await createStaffToken({ type: 'table', tableLabel: 'AUTOREJECT-T1' });
      tableRaw = created.body.meta.rawToken;
    });

    it('an order received past the timeout reads as auto_rejected on the guest\'s own next poll, and reverses a captured card payment', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/ar', accessCode: 'ar', reference: 'r' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'autoreject@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'r', providerPaymentId: 'ps_ar', amountSubunit: 2150, currency: 'NGN' });
      const confirmed = await guestPost(`/${tableRaw}/orders/${created.body.data.id}/confirm-payment`).send({});
      expect(confirmed.body.data.guestOrder.status).toBe('received');
      paystack.refundTransaction.mockResolvedValue({ status: 'processed' });

      // Advance the "became received" clock past the outlet's own
      // configured timeout — the same lazy-recovery shape Night Audit's
      // own "recovery evaluated lazily" precedent uses, proven by
      // manipulating the real stored fact (updated_at), not wall-clock time.
      await t.trx('pos_guest_orders').where({ id: created.body.data.id }).update({ updated_at: new Date(Date.now() - 11 * 60 * 1000) });

      const polled = await guestGet(`/${tableRaw}/orders/${created.body.data.id}`);
      expect(polled.status).toBe(200);
      expect(polled.body.data.status).toBe('auto_rejected');
      expect(polled.body.data.payment_status).toBe('refunded');

      const payment = await t.trx('payments')
        .where({ pos_order_id: created.body.data.pos_order_id, settlement_target: 'pos_order' })
        .whereNull('parent_payment_id')
        .first();
      expect(payment.status).toBe('REFUNDED');
    });

    it('an order already accepted never auto-rejects, however old', async () => {
      paystack.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://paystack.test/pay/ok', accessCode: 'ok', reference: 'r' });
      const created = await guestPost(`/${tableRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'card', guest_contact: 'accepted@example.com', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'r', providerPaymentId: 'ps_ok', amountSubunit: 2150, currency: 'NGN' });
      await guestPost(`/${tableRaw}/orders/${created.body.data.id}/confirm-payment`).send({});

      await t.request.post(`/api/v1/pos/guest-orders/${created.body.data.id}/accept`).set('Authorization', `Bearer ${staffToken()}`).send({});
      await t.trx('pos_guest_orders').where({ id: created.body.data.id }).update({ updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000) });

      const polled = await guestGet(`/${tableRaw}/orders/${created.body.data.id}`);
      expect(polled.body.data.status).toBe('preparing');
    });
  });

  // -----------------------------------------------------------------
  // OTP request rate limiting — code-review fix (IMPORTANT)
  // -----------------------------------------------------------------

  describe('OTP request rate limiting (code-review fix, IMPORTANT)', () => {
    let rlRoomRaw;

    beforeAll(async () => {
      // A genuinely in-house reservation already exists on `roomId` (set
      // up by the "guest charge-to-room via emailed OTP" block above, and
      // never checked out by any test in this file) — a SECOND, distinct
      // token against the SAME room is all this block needs, since
      // `findInHouseReservationForRoom` keys off the room, not the token.
      const created = await createStaffToken({ type: 'room', roomIdParam: roomId });
      rlRoomRaw = created.body.meta.rawToken;

      // A clean per-IP OTP-request budget for this block specifically —
      // this file's earlier charge-to-room block already spent some of
      // its own shared-IP allowance, and this test's own volume (enough
      // real calls to genuinely trip the per-TOKEN limit) is deliberate
      // abuse simulation, not incidental suite traffic that should count
      // against it. Also flush the general order-creation IP counter this
      // block's own two `POST .../orders` calls contribute to, for the
      // same reason "staff guest-order queue"/"lazy auto-reject" above do.
      await flushIpRateLimitKeys();
      const redis = rateLimitRedisConnection();
      const ipKeys = await redis.keys('qr-otp-request-ip-rl:*');
      if (ipKeys.length) await redis.del(...ipKeys);
    });

    afterAll(async () => {
      const redis = rateLimitRedisConnection();
      const tokenKeys = await redis.keys('qr-otp-request-rate:*');
      const ipKeys = await redis.keys('qr-otp-request-ip-rl:*');
      const all = [...tokenKeys, ...ipKeys];
      if (all.length) await redis.del(...all);
    });

    it('genuinely 429s once a single token exceeds its real per-minute OTP-request budget — a real Redis round trip, not just a middleware existing', async () => {
      const created = await guestPost(`/${rlRoomRaw}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      expect(created.status).toBe(201);
      const orderId = created.body.data.id;

      // The configured per-token ceiling is 15/minute (`rate-limit.js`) —
      // exhaust it for real against a live Redis instance, then confirm
      // the very next call is genuinely rejected with a real Retry-After
      // header.
      let lastRes;
      for (let i = 0; i < 16; i += 1) {
        lastRes = await guestPost(`/${rlRoomRaw}/orders/${orderId}/room-charge/request-otp`).send({});
      }
      expect(lastRes.status).toBe(429);
      expect(lastRes.body.error.code).toBe('RATE_LIMITED');
      expect(lastRes.headers['retry-after']).toBeDefined();
      expect(Number(lastRes.headers['retry-after'])).toBeGreaterThan(0);

      // A DIFFERENT token is never affected by this one being exhausted.
      const otherToken = await createStaffToken({ type: 'room', roomIdParam: roomId });
      const otherOrder = await guestPost(`/${otherToken.body.meta.rawToken}/orders`)
        .set('Idempotency-Key', idemKey())
        .send({ payment_method: 'room_charge', items: [{ menu_item_id: menuItemId, quantity: 1 }] });
      const stillWorks = await guestPost(`/${otherToken.body.meta.rawToken}/orders/${otherOrder.body.data.id}/room-charge/request-otp`).send({});
      expect(stillWorks.status).toBe(200);
    });
  });

  afterAll(async () => {
    await flushIpRateLimitKeys();
    await destroyRateLimitRedisConnection();
  });
});
