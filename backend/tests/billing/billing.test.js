'use strict';

/**
 * HTTP-level tests for the billing module — PLAN.md Phase 5,
 * PRODUCT_REQUIREMENTS.md §3.22. Covers the overview/plan-catalogue reads,
 * the add/replace-payment-method flow (mocked at the gateway boundary,
 * deterministic — no live network, matching `cashiering`'s own
 * `paystack-adapter` mocking precedent), RBAC (admin/super_admin only,
 * both keys), and the webhook receiver's verify/persist/deduplicate shape.
 *
 * The recurring billing-cycle mutation logic itself
 * (`processTenantBillingCycle`/`applyChargeOutcome`) is tested separately
 * against REAL pooled connections in
 * `tests/jobs/subscription-billing-sweep.test.js` — this file's own
 * shared-transaction harness cannot prove the genuine concurrent-charge
 * mutation guarantee that logic depends on.
 */

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  refundTransaction: jest.fn(),
  chargeAuthorization: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const gateway = require('../../src/modules/billing/paystack-gateway');

describe('Billing (PLAN.md Phase 5)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function tokenFor({ tenant = ctx.a, userId, propertyId } = {}) {
    return signAccessToken({
      aud: 'staff',
      sub: String(userId ?? tenant.users[0].id),
      tenant_id: String(tenant.id),
      property_id: String(propertyId ?? tenant.properties[0].id),
    });
  }

  /** Update-or-insert, matching `tests/setup/setup.test.js`'s own established helper exactly — `users[1]` already holds `housekeeping` at `properties[0]` from the fixture's own default grant plan. */
  async function grantRoleToUser({ tenant, userIndex, propertyIndex, role }) {
    const propertyId = tenant.properties[propertyIndex].id;
    const userId = tenant.users[userIndex].id;
    const existing = await t.trx('user_property_access').where({ user_id: userId, property_id: propertyId }).first('id');
    if (existing) {
      await t.trx('user_property_access').where({ id: existing.id }).update({ role });
      return;
    }
    await t.trx('user_property_access').insert({ tenant_id: tenant.id, property_id: propertyId, user_id: userId, role });
  }

  function adminToken(tenant = ctx.a) {
    return tokenFor({ tenant, userId: tenant.users[1].id });
  }

  beforeAll(async () => {
    await grantRoleToUser({ tenant: ctx.a, userIndex: 1, propertyIndex: 0, role: 'admin' });
    await grantRoleToUser({ tenant: ctx.b, userIndex: 1, propertyIndex: 0, role: 'admin' });
  });

  // ------------------------------------------------------------------
  // RBAC
  // ------------------------------------------------------------------

  describe('RBAC', () => {
    it('manager (no billing.view) is refused GET /billing/overview', async () => {
      const res = await t.request.get('/api/v1/billing/overview').set('Authorization', `Bearer ${tokenFor()}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION');
    });

    it('admin (billing.view) can read the overview', async () => {
      const res = await t.request.get('/api/v1/billing/overview').set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
    });

    it('manager (no billing.manage) is refused starting a payment-method checkout', async () => {
      const res = await t.request
        .post('/api/v1/billing/payment-method/start')
        .set('Authorization', `Bearer ${tokenFor()}`)
        .send({ email: 'admin@alpha-hotels.example.com' });
      expect(res.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------
  // Read side
  // ------------------------------------------------------------------

  describe('GET /billing/overview', () => {
    it('a tenant with no subscription yet shows the default plan and no subscription (ctx.b — seedTwoTenants deliberately gives only ctx.a a fixture subscription, see fixtures.js\'s own comment)', async () => {
      const res = await t.request.get('/api/v1/billing/overview').set('Authorization', `Bearer ${adminToken(ctx.b)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tenant.status).toBe('active'); // seedTwoTenants' own fixture tenants are created status: 'active', not 'trial'
      expect(res.body.data.plan.code).toBe('standard');
      expect(res.body.data.subscription).toBeNull();
    });

    it('a tenant with a real subscription (ctx.a\'s own fixture row) sees its own plan and payment method', async () => {
      const res = await t.request.get('/api/v1/billing/overview').set('Authorization', `Bearer ${adminToken(ctx.a)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.subscription.status).toBe('active');
      expect(res.body.data.subscription.payment_method.last4).toBe('4242');
    });
  });

  describe('GET /billing/plans', () => {
    it('lists the active plan catalogue', async () => {
      const res = await t.request.get('/api/v1/billing/plans').set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((p) => p.code === 'standard')).toBe(true);
    });
  });

  describe('GET /billing/invoices', () => {
    it('is empty for a tenant with no subscription yet', async () => {
      const res = await t.request.get('/api/v1/billing/invoices').set('Authorization', `Bearer ${adminToken(ctx.b)}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns 404, not empty, for a nonexistent invoice id\'s payments', async () => {
      const res = await t.request.get('/api/v1/billing/invoices/999999999/payments').set('Authorization', `Bearer ${adminToken(ctx.b)}`);
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  // Add / replace payment method
  // ------------------------------------------------------------------

  describe('POST /billing/payment-method/start + /complete', () => {
    it('starts a small verification checkout, never the real plan price', async () => {
      gateway.initializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.com/abc', accessCode: 'access_abc', reference: 'billing-card-abc' });

      const res = await t.request
        .post('/api/v1/billing/payment-method/start')
        .set('Authorization', `Bearer ${adminToken(ctx.b)}`)
        .send({ email: 'admin@beta-resorts.example.com' });

      expect(res.status).toBe(201);
      expect(res.body.data.authorizationUrl).toBe('https://checkout.paystack.com/abc');
      expect(gateway.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '50.00' }) // BILLING_CARD_VERIFICATION_AMOUNT default — never the plan's real price
      );
    });

    it('a failed card verification is rejected, and no subscription is created (still ctx.b — no fixture subscription exists for it yet)', async () => {
      gateway.verifyTransaction.mockResolvedValue({ status: 'failed', authorization: {} });

      const res = await t.request
        .post('/api/v1/billing/payment-method/complete')
        .set('Authorization', `Bearer ${adminToken(ctx.b)}`)
        .send({ reference: 'billing-card-bad' });

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('BILLING_CARD_VERIFICATION_FAILED');
      expect(await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).first()).toBeUndefined();
      expect(gateway.refundTransaction).not.toHaveBeenCalled();
    });

    it('completing a successful verification creates the subscription, refunds the verification charge, and records an audit entry', async () => {
      gateway.verifyTransaction.mockResolvedValue({
        status: 'success',
        authorization: { authorizationCode: 'AUTH_new_card', reusable: true, last4: '4242', brand: 'visa', expMonth: 12, expYear: 2031 },
      });
      gateway.refundTransaction.mockResolvedValue({ status: 'success' });

      const res = await t.request
        .post('/api/v1/billing/payment-method/complete')
        .set('Authorization', `Bearer ${adminToken(ctx.b)}`)
        .send({ reference: 'billing-card-abc' });

      expect(res.status).toBe(200);
      expect(gateway.refundTransaction).toHaveBeenCalledWith({ reference: 'billing-card-abc' });

      const subscription = await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).first();
      expect(subscription).toBeTruthy();
      expect(subscription.payment_method_last4).toBe('4242');
      expect(subscription.payment_method_authorization_code).toBe('AUTH_new_card');
      expect(subscription.status).toBe('active');

      const auditEntry = await t.trx('audit_log').where({ tenant_id: ctx.b.id, entity_type: 'subscriptions', action: 'payment_method_added' }).first();
      expect(auditEntry).toBeTruthy();

      const overview = await t.request.get('/api/v1/billing/overview').set('Authorization', `Bearer ${adminToken(ctx.b)}`);
      expect(overview.body.data.subscription.payment_method.last4).toBe('4242');
    });

    it('replacing an already-existing payment method updates it in place (still one row, UNIQUE(tenant_id)) and resets the failure counter', async () => {
      await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).update({ consecutive_failed_attempts: 3, status: 'past_due' });

      gateway.verifyTransaction.mockResolvedValue({
        status: 'success',
        authorization: { authorizationCode: 'AUTH_replacement_card', reusable: true, last4: '1111', brand: 'mastercard', expMonth: 6, expYear: 2032 },
      });
      gateway.refundTransaction.mockResolvedValue({ status: 'success' });

      const res = await t.request
        .post('/api/v1/billing/payment-method/complete')
        .set('Authorization', `Bearer ${adminToken(ctx.b)}`)
        .send({ reference: 'billing-card-replace' });

      expect(res.status).toBe(200);
      const rows = await t.trx('subscriptions').where({ tenant_id: ctx.b.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].payment_method_last4).toBe('1111');
      expect(rows[0].consecutive_failed_attempts).toBe(0);

      const auditEntry = await t.trx('audit_log').where({ tenant_id: ctx.b.id, entity_type: 'subscriptions', action: 'payment_method_replaced' }).first();
      expect(auditEntry).toBeTruthy();
    });
  });

  // ------------------------------------------------------------------
  // Webhook — verify / persist / deduplicate / process idempotently / audit
  // ------------------------------------------------------------------

  describe('POST /webhooks/billing-paystack', () => {
    it('always responds 200 once persisted, regardless of signature validity (API.md §7)', async () => {
      gateway.verifyWebhookSignature.mockReturnValue(false);
      const res = await t.request
        .post('/api/v1/webhooks/billing-paystack')
        .set('x-paystack-signature', 'bad-signature')
        .send({ event: 'charge.success', data: { id: 999001, reference: 'no-such-reference' } });
      expect(res.status).toBe(200);

      const row = await t.trx('subscription_webhook_events').where({ provider: 'paystack', provider_event_id: '999001' }).first();
      expect(row).toBeTruthy();
      expect(row.verified).toBe(0);
      expect(row.processed_at).toBeNull(); // an unverified event is persisted but never processed
    });

    it('deduplicates a redelivered event on (provider, provider_event_id) — still a real 200, not reprocessed', async () => {
      gateway.verifyWebhookSignature.mockReturnValue(true);
      const payload = { event: 'charge.success', data: { id: 999002, reference: 'dedup-test-ref' } };

      const first = await t.request.post('/api/v1/webhooks/billing-paystack').set('x-paystack-signature', 'valid').send(payload);
      const second = await t.request.post('/api/v1/webhooks/billing-paystack').set('x-paystack-signature', 'valid').send(payload);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await t.trx('subscription_webhook_events').where({ provider: 'paystack', provider_event_id: '999002' })).toHaveLength(1);
    });

    it('a genuine charge.success event correlates to its subscription_payments row by reference and applies the outcome', async () => {
      const subscription = await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).first();
      const [invoiceId] = await t.trx('subscription_invoices').insert({
        tenant_id: ctx.b.id,
        subscription_id: subscription.id,
        amount: '50000.00',
        currency: 'NGN',
        status: 'open',
        period_start: '2027-06-01',
        period_end: '2027-07-01',
        due_at: '2027-06-01',
      });
      const [paymentId] = await t.trx('subscription_payments').insert({
        tenant_id: ctx.b.id,
        subscription_invoice_id: invoiceId,
        idempotency_key: 'webhook-correlation-test',
        provider: 'paystack',
        provider_reference: 'webhook-correlation-ref',
        amount: '50000.00',
        currency: 'NGN',
        status: 'INITIATED',
      });

      gateway.verifyWebhookSignature.mockReturnValue(true);
      const res = await t.request
        .post('/api/v1/webhooks/billing-paystack')
        .set('x-paystack-signature', 'valid')
        .send({ event: 'charge.success', data: { id: 999003, reference: 'webhook-correlation-ref', gateway_response: 'Successful' } });

      expect(res.status).toBe(200);
      const payment = await t.trx('subscription_payments').where({ id: paymentId }).first();
      expect(payment.status).toBe('CAPTURED');
      const invoice = await t.trx('subscription_invoices').where({ id: invoiceId }).first();
      expect(invoice.status).toBe('paid');

      const eventRow = await t.trx('subscription_webhook_events').where({ provider: 'paystack', provider_event_id: '999003' }).first();
      expect(String(eventRow.tenant_id)).toBe(String(ctx.b.id));
      expect(String(eventRow.related_subscription_payment_id)).toBe(String(paymentId));
    });
  });
});
