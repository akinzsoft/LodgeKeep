'use strict';

/**
 * Mark subscribed / Record payment / expiring list (manual cash or bank-transfer subscriptions), the per-tenant app
 * domain, and the lifecycle e-mails. Tenant `a` has a Paystack subscription fixture; tenant `b` has none.
 */

const { useTestApp } = require('../helpers/app');
const { seedTwoTenants, seedPlatformUser } = require('../helpers/fixtures');
const { signAccessToken } = require('../../src/auth/tokens');
const { validateManualPayment } = require('../../src/modules/platform/subscribe');
const { flushRateLimitPrefixes } = require('../helpers/rate-limit');
const { tenantDomainFor, tenantBaseUrlFor, lifecycleDomains } = require('../../src/shared/app-domains');

const PLAN = { id: 1, code: 'standard', name: 'Standard', currency: 'NGN' };
const TODAY = '2026-10-21';

function days(n) {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

describe('app domains per tenant', () => {
  it('uses the stored domain while it is accepted, else the primary', () => {
    const env = { PRIMARY_APP_DOMAIN: 'lodgekeep.ng', ADDITIONAL_APP_DOMAINS: 'lodgekeep.planmsys.com' };
    expect(tenantDomainFor({ app_domain: 'lodgekeep.planmsys.com' }, env)).toBe('lodgekeep.planmsys.com');
    expect(tenantDomainFor({ app_domain: 'gone.example.com' }, env)).toBe('lodgekeep.ng');
    expect(tenantDomainFor({ app_domain: null }, env)).toBe('lodgekeep.ng');
    expect(tenantBaseUrlFor({ slug: 'acme', app_domain: 'lodgekeep.planmsys.com' }, env)).toBe('https://acme.lodgekeep.planmsys.com');
  });

  it('the lifecycle domains default to the primary and must be accepted domains', () => {
    const base = { PRIMARY_APP_DOMAIN: 'lodgekeep.ng', ADDITIONAL_APP_DOMAINS: 'lodgekeep.planmsys.com' };
    expect(lifecycleDomains(base)).toEqual({ trial: 'lodgekeep.ng', subscribed: 'lodgekeep.ng' });
    expect(lifecycleDomains({ ...base, TRIAL_APP_DOMAIN: 'lodgekeep.planmsys.com' }).trial).toBe('lodgekeep.planmsys.com');
    expect(() => lifecycleDomains({ ...base, SUBSCRIBED_APP_DOMAIN: 'evil.example.com' })).toThrow(/not one of the accepted/);
  });
});

describe('validateManualPayment', () => {
  const good = { plan_code: 'standard', method: 'cash', reference: 'RCPT-001', amount: '50000', currency: 'ngn', paid_until: days(30), reason: 'Paid in cash at the office' };
  const run = (overrides, plan = PLAN) => validateManualPayment({ ...good, ...overrides }, { plan, today: TODAY === '' ? '' : new Date().toISOString().slice(0, 10) });

  it('normalises a valid request', () => {
    expect(run({})).toMatchObject({ amount: '50000.00', currency: 'NGN', method: 'cash', reference: 'RCPT-001' });
  });

  it.each([
    ['unknown plan', {}, null],
    ['bad method', { method: 'crypto' }],
    ['short reference', { reference: 'ab' }],
    ['negative amount', { amount: '-5' }],
    ['zero amount', { amount: '0' }],
    ['three decimals', { amount: '10.123' }],
    ['numeric amount', { amount: 5000 }],
    ['wrong currency', { currency: 'USD' }],
    ['bad date', { paid_until: '2026-02-30' }],
    ['past date', { paid_until: days(-1) }],
    ['today', { paid_until: days(0) }],
    ['too far', { paid_until: days(500) }],
    ['no reason', { reason: '  ' }],
  ])('rejects %s', (_label, overrides, plan = PLAN) => {
    expect(() => run(overrides, plan)).toThrow(/./);
  });
});

describe('Mark subscribed / record payment / expiring (platform console)', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    ctx.admin = await seedPlatformUser(t.trx, 'sub-admin@planmsys.test', 'admin');
    ctx.support = await seedPlatformUser(t.trx, 'sub-support@planmsys.test', 'support');
  });

  const token = (user = ctx.admin) => signAccessToken({ aud: 'platform', sub: String(user.id) });
  const payload = (overrides = {}) => ({ plan_code: 'standard', method: 'bank_transfer', reference: `TRF-${Math.random().toString(36).slice(2, 10)}`, amount: '50000.00', currency: 'NGN', paid_until: days(30), reason: 'Bank transfer confirmed', ...overrides });
  const post = (path, body, user) => t.request.post(`/api/v1/platform/tenants/${ctx.b.id}/${path}`).set('Authorization', `Bearer ${token(user)}`).send(body);

  async function reset() {
    await t.trx('tenant_lifecycle_emails').where({ tenant_id: ctx.b.id }).delete();
    await t.trx('manual_payment_records').where({ tenant_id: ctx.b.id }).delete();
    await t.trx('subscription_payments').where({ tenant_id: ctx.b.id }).delete();
    await t.trx('subscription_invoices').where({ tenant_id: ctx.b.id }).delete();
    await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).delete();
    await t.trx('outbox_events').where({ tenant_id: ctx.b.id }).delete();
    await t.trx('tenants').where({ id: ctx.b.id }).update({ status: 'trial', plan_id: null, subscribed_at: null, app_domain: 'lodgekeep.planmsys.com' });
  }
  beforeEach(async () => {
    await flushRateLimitPrefixes(['platform-manual-payment:']);
    await reset();
  });

  it('records the payment, flips the tenant, moves its domain and queues one e-mail per active user', async () => {
    const body = payload();
    const res = await post('mark-subscribed', body);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.paidUntil).toBe(body.paid_until);
    expect(res.body.data.emails.queued).toBeGreaterThan(0);

    const tenant = await t.trx('tenants').where({ id: ctx.b.id }).first();
    expect(tenant.status).toBe('active');
    expect(tenant.app_domain).toBe(lifecycleDomains().subscribed);
    expect(tenant.subscribed_at).not.toBeNull();

    const sub = await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).first();
    expect(sub).toMatchObject({ payment_method_provider: 'manual', status: 'active', payment_method_authorization_code: null });
    expect(String(sub.current_period_end).slice(0, 10) === body.paid_until || new Date(sub.current_period_end).toISOString().slice(0, 10) === body.paid_until).toBe(true);
    const payment = await t.trx('subscription_payments').where({ tenant_id: ctx.b.id }).first();
    expect(payment).toMatchObject({ provider: 'manual', status: 'CAPTURED', amount: '50000.00', currency: 'NGN' });
    expect((await t.trx('subscription_invoices').where({ tenant_id: ctx.b.id }).first()).status).toBe('paid');
    expect(await t.trx('manual_payment_records').where({ tenant_id: ctx.b.id }).first()).toMatchObject({ method: 'bank_transfer', reference_note: body.reference, kind: 'subscribe' });

    const audit = await t.trx('audit_log').where({ tenant_id: ctx.b.id, action: 'mark_subscribed' }).first();
    expect(audit).toBeTruthy();

    const events = await t.trx('outbox_events').where({ tenant_id: ctx.b.id, event_type: 'tenant.subscribed' });
    expect(events.length).toBe(res.body.data.emails.queued);
    const text = JSON.stringify(events.map((e) => e.payload));
    expect(text).toContain(body.paid_until);
    expect(text).not.toMatch(/password|token|code/i);
    const parsed = JSON.parse(typeof events[0].payload === 'string' ? events[0].payload : JSON.stringify(events[0].payload));
    expect(parsed.loginUrl).toBe(`https://${ctx.b.slug}.${lifecycleDomains().subscribed}`);
    expect(parsed.loginEmail).toBe(parsed.recipientEmail);
  });

  it('a second click is refused and sends nothing more', async () => {
    expect((await post('mark-subscribed', payload())).status).toBe(200);
    const before = (await t.trx('outbox_events').where({ tenant_id: ctx.b.id }).select('id')).length;
    const again = await post('mark-subscribed', payload());
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect((await t.trx('outbox_events').where({ tenant_id: ctx.b.id }).select('id')).length).toBe(before);
    expect((await t.trx('subscription_payments').where({ tenant_id: ctx.b.id })).length).toBe(1);
  });

  it('a duplicate email is impossible even if the status guard is bypassed', async () => {
    expect((await post('mark-subscribed', payload())).status).toBe(200);
    await t.trx('subscription_invoices').where({ tenant_id: ctx.b.id }).update({ period_start: days(-60), due_at: days(-60) });
    await t.trx('tenants').where({ id: ctx.b.id }).update({ status: 'suspended' });
    const res = await post('mark-subscribed', payload({ paid_until: days(60) }));
    expect(res.status).toBe(200);
    expect(res.body.data.emails.queued).toBe(0);
    expect(res.body.data.emails.alreadySent).toBeGreaterThan(0);
  });

  it('refuses a tenant with a Paystack subscription', async () => {
    const res = await t.request.post(`/api/v1/platform/tenants/${ctx.a.id}/mark-subscribed`).set('Authorization', `Bearer ${token()}`).send(payload());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BUSINESS_RULE_TENANT_HAS_CARD_SUBSCRIPTION');
  });

  it('refuses the same payment reference twice', async () => {
    const body = payload({ reference: 'RCPT-DUP-1' });
    expect((await post('mark-subscribed', body)).status).toBe(200);
    await t.trx('subscription_invoices').where({ tenant_id: ctx.b.id }).update({ period_start: days(-60), due_at: days(-60) });
    await t.trx('tenants').where({ id: ctx.b.id }).update({ status: 'suspended' });
    const res = await post('mark-subscribed', { ...body, paid_until: days(60) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BUSINESS_RULE_REFERENCE_ALREADY_USED');
  });

  it.each([
    ['wrong currency', { currency: 'USD' }],
    ['past date', { paid_until: days(-3) }],
    ['bad method', { method: 'bitcoin' }],
    ['unknown plan', { plan_code: 'platinum' }],
    ['numeric amount', { amount: 50000 }],
  ])('validates server-side: %s writes nothing', async (_label, overrides) => {
    const res = await post('mark-subscribed', payload(overrides));
    expect(res.status).toBe(400);
    expect((await t.trx('tenants').where({ id: ctx.b.id }).first()).status).toBe('trial');
    expect((await t.trx('subscriptions').where({ tenant_id: ctx.b.id })).length).toBe(0);
    expect((await t.trx('outbox_events').where({ tenant_id: ctx.b.id })).length).toBe(0);
  });

  it('ignores client-sent status, domain and ids', async () => {
    const res = await post('mark-subscribed', { ...payload(), status: 'trial', app_domain: 'evil.example.com', plan_id: 999, tenant_id: ctx.a.id });
    expect(res.status).toBe(200);
    const tenant = await t.trx('tenants').where({ id: ctx.b.id }).first();
    expect(tenant.status).toBe('active');
    expect(tenant.app_domain).toBe(lifecycleDomains().subscribed);
  });

  it('is rate-limited per platform user', async () => {
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await post('mark-subscribed', payload({ currency: 'USD' })); // invalid on purpose: writes nothing
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('is admin-tier only', async () => {
    const res = await post('mark-subscribed', payload(), ctx.support);
    expect(res.status).toBe(403);
    expect((await post('record-payment', payload(), ctx.support)).status).toBe(403);
  });

  it('skips deactivated users and users without an active property', async () => {
    await t.trx('users').where({ id: ctx.b.users[0].id }).update({ status: 'inactive' });
    const res = await post('mark-subscribed', payload());
    expect(res.status).toBe(200);
    const recipients = (await t.trx('outbox_events').where({ tenant_id: ctx.b.id, event_type: 'tenant.subscribed' })).map((e) => JSON.parse(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)).recipientEmail);
    expect(recipients).not.toContain(ctx.b.users[0].email);
    await t.trx('users').where({ id: ctx.b.users[0].id }).update({ status: 'active' });
  });

  it('a purging tenant is refused', async () => {
    await t.trx('tenants').where({ id: ctx.b.id }).update({ status: 'purging' });
    const res = await post('mark-subscribed', payload());
    expect(res.status).toBeGreaterThanOrEqual(400);
    await t.trx('tenants').where({ id: ctx.b.id }).update({ status: 'trial' });
  });

  describe('record-payment (renewal)', () => {
    it('extends the paid-until date and tells only the super_admins; never changes status or domain', async () => {
      expect((await post('mark-subscribed', payload({ paid_until: days(30) }))).status).toBe(200);
      const before = await t.trx('tenants').where({ id: ctx.b.id }).first();
      const events0 = (await t.trx('outbox_events').where({ tenant_id: ctx.b.id })).length;
      const res = await post('record-payment', payload({ paid_until: days(60) }));
      expect(res.status).toBe(200);
      const after = await t.trx('tenants').where({ id: ctx.b.id }).first();
      expect(after.status).toBe('active');
      expect(after.app_domain).toBe(before.app_domain);
      expect(new Date((await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).first()).current_period_end).toISOString().slice(0, 10)).toBe(days(60));
      expect((await t.trx('subscription_payments').where({ tenant_id: ctx.b.id })).length).toBe(2);
      expect((await t.trx('outbox_events').where({ tenant_id: ctx.b.id, event_type: 'tenant.subscribed' })).length).toBe(events0); // a renewal never resends the new-address e-mail
      const receipts = await t.trx('outbox_events').where({ tenant_id: ctx.b.id, event_type: 'tenant.payment_recorded' });
      expect(receipts.length).toBe(res.body.data.emails.queued);
    });

    it('refuses a date that does not extend, and a tenant that is not manually paid', async () => {
      expect((await post('mark-subscribed', payload({ paid_until: days(30) }))).status).toBe(200);
      expect((await post('record-payment', payload({ paid_until: days(20) }))).status).toBe(400);
      const card = await t.request.post(`/api/v1/platform/tenants/${ctx.a.id}/record-payment`).set('Authorization', `Bearer ${token()}`).send(payload());
      expect(card.status).toBe(409);
    });
  });

  describe('period end', () => {
    it('lists manual subscriptions that are near or past due, and suspends nobody', async () => {
      expect((await post('mark-subscribed', payload({ paid_until: days(5) }))).status).toBe(200);
      const list = await t.request.get('/api/v1/platform/subscriptions/expiring').set('Authorization', `Bearer ${token(ctx.support)}`);
      expect(list.status).toBe(200);
      const item = list.body.data.items.find((i) => i.tenantId === String(ctx.b.id));
      expect(item).toMatchObject({ daysLeft: 5, overdue: false });

      await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).update({ current_period_end: days(-3) });
      const overdue = await t.request.get('/api/v1/platform/subscriptions/expiring').set('Authorization', `Bearer ${token()}`);
      expect(overdue.body.data.items.find((i) => i.tenantId === String(ctx.b.id))).toMatchObject({ overdue: true, daysLeft: -3 });

      const { runSubscriptionBillingSweep } = require('../../src/jobs/subscription-billing');
      const { runTrialExpirySweep } = require('../../src/jobs/trial-expiry');
      await t.trx('subscriptions').where({ tenant_id: ctx.b.id }).update({ current_period_start: days(-40) });
      await runSubscriptionBillingSweep();
      await runTrialExpirySweep();
      expect((await t.trx('tenants').where({ id: ctx.b.id }).first()).status).toBe('active');
      expect((await t.trx('subscription_payments').where({ tenant_id: ctx.b.id, provider: 'paystack' })).length).toBe(0);
    });
  });
});

describe('Move to new domain (platform console)', () => {
  const t = useTestApp();
  let ctx;
  const saved = {};
  const NEW = 'moved.example.com';

  beforeAll(async () => {
    for (const key of ['ADDITIONAL_APP_DOMAINS', 'SUBSCRIBED_APP_DOMAIN']) saved[key] = process.env[key];
    process.env.ADDITIONAL_APP_DOMAINS = NEW;
    process.env.SUBSCRIBED_APP_DOMAIN = NEW;
    ctx = await seedTwoTenants(t.trx);
    ctx.admin = await seedPlatformUser(t.trx, 'move-admin@planmsys.test', 'admin');
    ctx.support = await seedPlatformUser(t.trx, 'move-support@planmsys.test', 'support');
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const token = (user = ctx.admin) => signAccessToken({ aud: 'platform', sub: String(user.id) });
  const move = (tenant, body = { reason: 'STICAL asked for the new address' }, user) => t.request.post(`/api/v1/platform/tenants/${tenant.id}/move-domain`).set('Authorization', `Bearer ${token(user)}`).send(body);
  const billingSnapshot = async (tenantId) => JSON.stringify({
    subs: await t.trx('subscriptions').where({ tenant_id: tenantId }).orderBy('id'),
    invoices: await t.trx('subscription_invoices').where({ tenant_id: tenantId }).orderBy('id'),
    payments: await t.trx('subscription_payments').where({ tenant_id: tenantId }).orderBy('id'),
  });

  beforeEach(async () => {
    await flushRateLimitPrefixes(['platform-manual-payment:']);
    await t.trx('tenant_lifecycle_emails').where({ kind: `moved:${NEW}` }).delete();
    await t.trx('outbox_events').where({ event_type: 'tenant.domain_moved' }).delete();
    await t.trx('tenants').whereIn('id', [ctx.a.id, ctx.b.id]).update({ status: 'active', app_domain: 'localhost' });
  });

  it('moves an active tenant, e-mails each active user once with no paid-until line, and touches no status or billing row', async () => {
    const before = await billingSnapshot(ctx.a.id);
    const res = await move(ctx.a);
    expect(res.status).toBe(200);
    expect(res.body.data.appDomain).toBe(NEW);
    expect(res.body.data.emails.queued).toBeGreaterThan(0);

    const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
    expect(tenant).toMatchObject({ app_domain: NEW, status: 'active' });
    expect(await billingSnapshot(ctx.a.id)).toBe(before);
    expect(await t.trx('audit_log').where({ tenant_id: ctx.a.id, action: 'move_domain' }).first()).toBeTruthy();

    const events = await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'tenant.domain_moved' });
    expect(events).toHaveLength(res.body.data.emails.queued);
    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(payload.loginUrl).toBe(`https://${ctx.a.slug}.${NEW}`);
    expect(JSON.stringify(payload)).not.toMatch(/paidUntil|password|token|code/i);
  });

  it('is idempotent: a second click changes and sends nothing', async () => {
    expect((await move(ctx.a)).status).toBe(200);
    const sent = (await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'tenant.domain_moved' })).length;
    const again = await move(ctx.a);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('BUSINESS_RULE_ALREADY_ON_DOMAIN');
    expect((await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'tenant.domain_moved' })).length).toBe(sent);
  });

  it('the unique rows stop a second e-mail even if the tenant is put back on the old domain', async () => {
    expect((await move(ctx.a)).status).toBe(200);
    await t.trx('tenants').where({ id: ctx.a.id }).update({ app_domain: 'localhost' });
    const res = await move(ctx.a);
    expect(res.status).toBe(200);
    expect(res.body.data.emails.queued).toBe(0);
    expect(res.body.data.emails.alreadySent).toBeGreaterThan(0);
  });

  it.each(['trial', 'suspended', 'offboarding', 'purging', 'purged'])('refuses a %s tenant and changes nothing', async (status) => {
    await t.trx('tenants').where({ id: ctx.b.id }).update({ status });
    const res = await move(ctx.b);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const tenant = await t.trx('tenants').where({ id: ctx.b.id }).first();
    expect(tenant).toMatchObject({ status, app_domain: 'localhost' });
    expect(await t.trx('outbox_events').where({ tenant_id: ctx.b.id, event_type: 'tenant.domain_moved' })).toHaveLength(0);
    await t.trx('tenants').where({ id: ctx.b.id }).update({ status: 'active' });
  });

  it('needs a reason, an explicit SUBSCRIBED_APP_DOMAIN, and the admin tier; and is rate-limited', async () => {
    expect((await move(ctx.a, { reason: '  ' })).status).toBe(400);
    expect((await move(ctx.a, undefined, ctx.support)).status).toBe(403);
    delete process.env.SUBSCRIBED_APP_DOMAIN;
    const unset = await move(ctx.a);
    expect(unset.status).toBe(422);
    expect(unset.body.error.code).toBe('BUSINESS_RULE_SUBSCRIBED_DOMAIN_NOT_SET');
    process.env.SUBSCRIBED_APP_DOMAIN = NEW;
    expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).app_domain).toBe('localhost');
    let limited = 0;
    for (let i = 0; i < 12; i += 1) if ((await move(ctx.a, { reason: '' })).status === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
  });
});

