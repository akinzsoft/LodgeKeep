'use strict';

/**
 * Real-connection concurrency test — the duplicate-refund race a
 * re-review of PR #105 found in `completeAddPaymentMethod`
 * (`src/modules/billing/service.js`). Mirrors
 * `tests/setup/plan-entitlements-concurrency.test.js`'s own harness
 * exactly, for the identical reason: the shared-transaction `useTestApp()`
 * harness cannot prove a real race — two "concurrent" requests against one
 * transaction are really two savepoints on the same MySQL session, which
 * never blocks itself. This file binds the app to the real pooled test
 * connection and fires two genuinely concurrent HTTP completions for the
 * SAME checkout reference.
 *
 * The bug this proves fixed: the checkout row used to be claimed AFTER
 * `refundTransaction` was called, not before. Both concurrent completions
 * could pass the (unlocked) read/verify/mismatch checks — verification is
 * naturally idempotent, so both see identical results — and both reach
 * `refundTransaction` before either had claimed the row; only one
 * subscription update would ultimately win, but Paystack would already
 * have received two real refund calls for the one charge. The fix moves
 * the atomic claim (a single, immediately-committed `UPDATE ... WHERE
 * status = 'pending'`) to before the refund call, so a losing request is
 * rejected before it can trigger the external call at all.
 */

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  // `toSubunit` (and the two error classes) stay real via `requireActual`
  // — this test needs the real conversion to build a mocked verification
  // response that matches the real checkout amount, exactly like
  // `tests/billing/billing.test.js`'s own identical mock shape.
  ...jest.requireActual('../../src/modules/billing/paystack-gateway'),
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  refundTransaction: jest.fn(),
  chargeAuthorization: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const request = require('supertest');
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { createApp } = require('../../src/app');
const { signAccessToken } = require('../../src/auth/tokens');
const { SYSTEM_ROLES, DEFAULT_ROLE_PERMISSIONS } = require('../../src/modules/tenancy');
const gateway = require('../../src/modules/billing/paystack-gateway');

describe('Billing: the concurrent-refund race under real concurrent connections', () => {
  let req;
  let tenantId;
  let userId;
  let propertyId;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    req = request(createApp());

    const plan = await db()('plans').where({ code: 'standard' }).first('id');

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    [tenantId] = await db()('tenants').insert({ name: `Refund Race Tenant ${suffix}`, slug: `refund-race-${suffix}`, plan_id: plan.id });
    [userId] = await db()('users').insert({
      tenant_id: tenantId,
      email: `refund-race-${suffix}@example.test`,
      password_hash: `$2b$12$${'x'.repeat(53)}`,
      first_name: 'Refund',
      last_name: 'Race',
    });
    [propertyId] = await db()('properties').insert({
      tenant_id: tenantId,
      slug: `${suffix}-property`,
      name: 'Refund Race Property',
      timezone: 'Africa/Lagos',
      base_currency: 'NGN',
    });

    // A raw tenant insert carries neither `roles` nor `role_permissions`
    // (both TENANT_SCOPED) — granting `billing.manage` needs the real
    // catalogue, the same fix `tests/setup/plan-entitlements-concurrency
    // .test.js` already established for the identical gap.
    const roleIdByCode = {};
    for (const code of SYSTEM_ROLES) {
      const [id] = await db()('roles').insert({ tenant_id: tenantId, code, name: code, is_system: true });
      roleIdByCode[code] = id;
    }
    const permissionRows = await db()('permissions').select('id', 'permission_key');
    const permissionIdByKey = new Map(permissionRows.map((row) => [row.permission_key, row.id]));
    const grants = [];
    for (const [code, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const key of keys) {
        const permissionId = permissionIdByKey.get(key);
        if (permissionId) grants.push({ tenant_id: tenantId, role_id: roleIdByCode[code], permission_id: permissionId });
      }
    }
    await db()('role_permissions').insert(grants);
    await db()('user_property_access').insert({ tenant_id: tenantId, property_id: propertyId, user_id: userId, role: 'admin' });
  });

  afterAll(async () => {
    await db()('audit_log').where({ tenant_id: tenantId }).delete();
    await db()('subscriptions').where({ tenant_id: tenantId }).delete();
    await db()('billing_payment_method_checkouts').where({ tenant_id: tenantId }).delete();
    await db()('user_property_access').where({ tenant_id: tenantId }).delete();
    await db()('role_permissions').where({ tenant_id: tenantId }).delete();
    await db()('roles').where({ tenant_id: tenantId }).delete();
    await db()('properties').where({ tenant_id: tenantId }).delete();
    await db()('users').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
    dbModule.__resetForTesting();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function token() {
    return signAccessToken({ aud: 'staff', sub: String(userId), tenant_id: String(tenantId), property_id: String(propertyId) });
  }

  it('two genuinely concurrent completions for the SAME reference issue exactly ONE refund call, never two', async () => {
    gateway.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/x', accessCode: 'access_x', reference: 'ignored' });

    const startRes = await req.post('/api/v1/billing/payment-method/start').set('Authorization', `Bearer ${token()}`).send({ email: 'race@example.test' });
    expect(startRes.status).toBe(201);
    const reference = startRes.body.data.reference;

    // A short, deliberate delay before each mocked gateway call resolves —
    // widens the race window so both concurrent completions are
    // guaranteed to still be mid-flight (past their own unlocked read,
    // not yet at the atomic claim) at the same real wall-clock moment,
    // rather than leaving the actual interleaving to chance.
    gateway.verifyTransaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return {
        status: 'success',
        amountSubunit: gateway.toSubunit('50.00'),
        currency: 'NGN',
        authorization: { authorizationCode: 'AUTH_race', reusable: true, last4: '4242', brand: 'visa', expMonth: 12, expYear: 2031 },
      };
    });
    gateway.refundTransaction.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { status: 'success' };
    });

    const complete = () =>
      req.post('/api/v1/billing/payment-method/complete').set('Authorization', `Bearer ${token()}`).send({ reference });
    const [first, second] = await Promise.all([complete(), complete()]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 404]);

    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    expect(loser.body.error.code).toBe('BILLING_CHECKOUT_NOT_FOUND');
    expect(winner.body.data.id).toBeTruthy();

    // The actual fix, proven directly against a real race: exactly one
    // refund call ever reached the gateway, not two.
    expect(gateway.refundTransaction).toHaveBeenCalledTimes(1);

    const subscriptions = await db()('subscriptions').where({ tenant_id: tenantId });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].payment_method_authorization_code).toBe('AUTH_race');

    const checkout = await db()('billing_payment_method_checkouts').where({ tenant_id: tenantId, reference }).first();
    expect(checkout.status).toBe('consumed');
  });
});
