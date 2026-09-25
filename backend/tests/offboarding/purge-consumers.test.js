'use strict';

/**
 * Everything that reacts to `offboarding` / `purging` / `purged` other than the
 * purge itself: the periodic sweeps stop touching a leaving tenant, billing stops
 * charging it (and a late payment can no longer revive a cancelled subscription),
 * webhooks and the export job refuse to work on data about to be deleted, the
 * platform console refuses one-way-door actions with a clear 409, and the T-7d /
 * T-1d warning emails go out once each.
 */

jest.mock('../../src/modules/billing/paystack-gateway', () => ({
  ...jest.requireActual('../../src/modules/billing/paystack-gateway'),
  chargeAuthorization: jest.fn(),
  verifyTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

jest.mock('../../src/modules/cashiering/paystack-adapter', () => {
  const actual = jest.requireActual('../../src/modules/cashiering/paystack-adapter');
  const mockAdapter = { verifyTransaction: jest.fn(), verifyWebhookSignature: jest.fn() };
  return {
    ...actual,
    __mockAdapter: mockAdapter,
    resolveAdapterForCurrency: jest.fn(async () => ({ integration: { id: 1, currency: 'NGN' }, adapter: mockAdapter })),
  };
});

jest.mock('../../src/jobs/tenant-data-export', () => ({
  ...jest.requireActual('../../src/jobs/tenant-data-export'),
  enqueueTenantDataExportJob: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/jobs/outbox-dispatcher', () => ({
  ...jest.requireActual('../../src/jobs/outbox-dispatcher'),
  enqueueOutboxDispatch: jest.fn().mockResolvedValue(undefined),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTestApp } = require('../helpers/app');
const { seedTwoTenants } = require('../helpers/fixtures');
const { gatewayRecordFor } = require('../helpers/gateway-record');
const { platformContext } = require('../../src/modules/tenancy');
const gateway = require('../../src/modules/billing/paystack-gateway');
const billingService = require('../../src/modules/billing/service');
const cashieringService = require('../../src/modules/cashiering/service');
const platformService = require('../../src/modules/platform/service');
const purge = require('../../src/modules/offboarding/purge');
const { runSubscriptionBillingSweep } = require('../../src/jobs/subscription-billing');
const { runExpenseSchedulesSweep } = require('../../src/jobs/expense-schedules');
const { runOutboxDispatchSweep } = require('../../src/jobs/outbox-dispatcher');
const { runExportJob } = require('../../src/jobs/tenant-data-export');
const { enqueueTenantDataExportJob } = require('../../src/jobs/tenant-data-export');
const { enqueueOutboxDispatch } = require('../../src/jobs/outbox-dispatcher');
const { INACTIVE_SWEEP_STATUSES, isTenantResolvable } = require('../../src/shared/tenant-lifecycle');
const guestPaystack = require('../../src/modules/cashiering/paystack-adapter').__mockAdapter;

const DAY = 24 * 60 * 60 * 1000;

describe('everything that reacts to a leaving tenant', () => {
  const t = useTestApp();
  let ctx;

  beforeAll(async () => {
    ctx = await seedTwoTenants(t.trx);
    await t.trx('properties').where({ id: ctx.a.properties[0].id }).update({ current_business_date: '2027-06-01' });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    gateway.chargeAuthorization.mockReset();
    gateway.verifyTransaction.mockReset();
    guestPaystack.verifyTransaction.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    console.error.mockRestore();
    await setStatus('active');
  });

  async function setStatus(status, extra = {}) {
    await t.trx('tenants').where({ id: ctx.a.id }).update({ status, ...extra });
  }

  describe('the status vocabulary', () => {
    it('purging and purged do not resolve; every other status does', () => {
      for (const status of ['trial', 'active', 'suspended', 'offboarding']) expect(isTenantResolvable({ status })).toBe(true);
      for (const status of ['purging', 'purged']) expect(isTenantResolvable({ status })).toBe(false);
      expect(isTenantResolvable(null)).toBe(false);
    });

    it('a sweep skips offboarding, purging and purged tenants', () => {
      expect([...INACTIVE_SWEEP_STATUSES].sort()).toEqual(['offboarding', 'purged', 'purging']);
    });
  });

  describe('the periodic sweeps', () => {
    it.each(['offboarding', 'purging', 'purged'])('the recurring-expense sweep posts nothing for a %s tenant, and posts again once it is active', async (status) => {
      await t.trx('recurring_expense_schedules').where({ tenant_id: ctx.a.id }).update({ next_due_date: '2027-05-01', status: 'active' });

      await setStatus(status);
      const skipped = await runExpenseSchedulesSweep();
      expect(await t.trx('expenses').where({ tenant_id: ctx.a.id, description: 'Fixture rent' })).toHaveLength(0);
      expect(skipped).toBeGreaterThanOrEqual(0); // tenant b may post; a must not

      await setStatus('active');
      await runExpenseSchedulesSweep();
      expect((await t.trx('expenses').where({ tenant_id: ctx.a.id, description: 'Fixture rent' })).length).toBeGreaterThan(0);
      await t.trx('expenses').where({ tenant_id: ctx.a.id, description: 'Fixture rent' }).delete();
    });

    it.each(['door-access-retention', 'expense-schedules', 'notifications-sweep', 'night-audit-overdue'])('%s filters on the shared INACTIVE_SWEEP_STATUSES, not a hard-coded status', (job) => {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'jobs', `${job}.js`), 'utf8');
      expect(source).toContain('INACTIVE_SWEEP_STATUSES');
      expect(source).not.toMatch(/whereNot\('tenants\.status', 'offboarding'\)/);
    });

    it('the outbox sweep dispatches for an offboarding tenant (the purge warnings depend on it), but not a purged one', async () => {
      await setStatus('offboarding');
      expect(await runOutboxDispatchSweep()).toBeGreaterThanOrEqual(2); // a (offboarding) and b (active)
      await setStatus('purged');
      const withoutA = await runOutboxDispatchSweep();
      await setStatus('active');
      expect(await runOutboxDispatchSweep()).toBeGreaterThan(withoutA);
    });
  });

  describe('subscription billing', () => {
    beforeEach(async () => {
      await t.trx('subscriptions').where({ tenant_id: ctx.a.id }).update({ status: 'active', current_period_start: '2027-06-01', current_period_end: '2027-07-01' });
      await t.trx('subscription_payments').where({ tenant_id: ctx.a.id }).delete();
      await t.trx('subscription_invoices').where({ tenant_id: ctx.a.id, period_start: '2027-06-01' }).delete();
      gateway.chargeAuthorization.mockResolvedValue({ status: 'success', providerPaymentId: 'PSK_purge', gatewayResponse: 'Successful' });
    });

    it.each(['offboarding', 'purging', 'purged'])('never charges a %s tenant', async (status) => {
      await setStatus(status);
      await runSubscriptionBillingSweep(new Date('2027-06-02T00:00:00Z'));
      expect(gateway.chargeAuthorization).not.toHaveBeenCalled();
    });

    it('processTenantBillingCycle itself refuses a leaving tenant (the sweep filter is not the only guard)', async () => {
      await setStatus('offboarding');
      expect(await billingService.processTenantBillingCycle({ tenantId: ctx.a.id, now: new Date('2027-06-02T00:00:00Z') })).toEqual({ action: 'skip_tenant_leaving' });
      expect(gateway.chargeAuthorization).not.toHaveBeenCalled();
    });

    it('billing resumes when the tenant is reactivated (an offboarding tenant’s subscription is not cancelled)', async () => {
      await setStatus('offboarding');
      await runSubscriptionBillingSweep(new Date('2027-06-02T00:00:00Z'));
      expect(gateway.chargeAuthorization).not.toHaveBeenCalled();
      await setStatus('active');
      await runSubscriptionBillingSweep(new Date('2027-06-02T00:00:00Z'));
      expect(gateway.chargeAuthorization).toHaveBeenCalledTimes(1);
      const subscription = await t.trx('subscriptions').where({ tenant_id: ctx.a.id }).first();
      expect(subscription.status).toBe('active');
    });

    it('a late charge outcome does NOT revive a cancelled subscription or touch a purged tenant', async () => {
      const subscription = await t.trx('subscriptions').where({ tenant_id: ctx.a.id }).first();
      const [invoiceId] = await t.trx('subscription_invoices').insert({
        tenant_id: ctx.a.id,
        subscription_id: subscription.id,
        amount: '50000.00',
        currency: 'NGN',
        status: 'open',
        period_start: '2033-01-01',
        period_end: '2033-02-01',
        due_at: '2033-01-01',
      });
      const [paymentId] = await t.trx('subscription_payments').insert({
        tenant_id: ctx.a.id,
        subscription_invoice_id: invoiceId,
        idempotency_key: 'late-after-purge',
        provider: 'paystack',
        provider_reference: 'late-after-purge-ref',
        amount: '50000.00',
        currency: 'NGN',
        status: 'INITIATED',
      });
      await t.trx('subscriptions').where({ id: subscription.id }).update({ status: 'canceled' });
      await setStatus('purged');
      const outboxBefore = await t.trx('outbox_events').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first();

      const result = await billingService.applyChargeOutcome({ tenantId: ctx.a.id, paymentId, success: true, providerPaymentId: 'late' });

      expect(result.action).toBe('captured_subscription_inactive');
      expect((await t.trx('subscription_payments').where({ id: paymentId }).first()).status).toBe('CAPTURED'); // the money really moved: recorded
      expect((await t.trx('subscription_invoices').where({ id: invoiceId }).first()).status).toBe('paid');
      expect((await t.trx('subscriptions').where({ id: subscription.id }).first()).status).toBe('canceled'); // never revived
      expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).status).toBe('purged');
      expect(await t.trx('outbox_events').where({ tenant_id: ctx.a.id }).count({ n: '*' }).first()).toEqual(outboxBefore); // nobody is emailed
      await t.trx('subscription_payments').where({ id: paymentId }).delete();
      await t.trx('subscription_invoices').where({ id: invoiceId }).delete();
    });
  });

  describe('webhooks for a leaving tenant', () => {
    async function registerPayment() {
      const [id] = await t.trx('payments').insert({
        tenant_id: ctx.a.id,
        property_id: ctx.a.properties[0].id,
        folio_id: null,
        idempotency_key: `purge-consumer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        provider: 'paystack',
        provider_reference: `purge-consumer-ref-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
        amount: '20.00',
        currency: 'NGN',
        status: 'PENDING',
        settlement_target: 'pos_register',
      });
      return t.trx('payments').where({ id }).first();
    }

    it.each(['purging', 'purged'])('a signed guest webhook for a %s tenant is recorded and dropped, never verified or applied', async (status) => {
      const payment = await registerPayment();
      await setStatus(status);
      guestPaystack.verifyWebhookSignature.mockReturnValue(true);
      guestPaystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      const body = { event: 'charge.success', data: { id: 990001 + Math.floor(Math.random() * 1000), reference: payment.provider_reference, status: 'success' } };

      await cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'x', parsedBody: body });

      expect(guestPaystack.verifyTransaction).not.toHaveBeenCalled();
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('PENDING');
      const row = await t.trx('payment_webhook_events').where({ provider_event_id: String(body.data.id) }).first();
      expect(row.outcome).toBe('ignored');
      expect((typeof row.outcome_detail === 'string' ? JSON.parse(row.outcome_detail) : row.outcome_detail).reason).toBe('tenant_purging');
    });

    it('the same webhook for an ACTIVE tenant is applied (the guard is not blocking everything)', async () => {
      const payment = await registerPayment();
      guestPaystack.verifyWebhookSignature.mockReturnValue(true);
      guestPaystack.verifyTransaction.mockResolvedValue(gatewayRecordFor(payment));
      const body = { event: 'charge.success', data: { id: 991001 + Math.floor(Math.random() * 1000), reference: payment.provider_reference, status: 'success' } };
      await cashieringService.handlePaystackWebhook({ rawBody: JSON.stringify(body), signatureHeader: 'x', parsedBody: body });
      expect((await t.trx('payments').where({ id: payment.id }).first()).status).toBe('CAPTURED');
    });
  });

  describe('the export job', () => {
    it('refuses to export a tenant whose purge has started, fails the row, and writes no file', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-consumer-exports-'));
      process.env.EXPORT_STORAGE_DIR = dir;
      try {
        const [exportId] = await t.trx('tenant_data_exports').insert({ tenant_id: ctx.a.id, status: 'pending' });
        await setStatus('purging');

        await runExportJob({ tenantId: ctx.a.id, exportId });

        const row = await t.trx('tenant_data_exports').where({ id: exportId }).first();
        expect(row.status).toBe('failed');
        expect(row.failed_reason).toBe('Tenant purge started');
        expect(fs.readdirSync(dir)).toEqual([]);
      } finally {
        delete process.env.EXPORT_STORAGE_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('the platform console: purging and purged are one-way doors', () => {
    let platformUserId;

    beforeAll(async () => {
      [platformUserId] = await t.trx('platform_users').insert({ email: `purge-console-${Date.now()}@example.com`, password_hash: 'x', first_name: 'P', last_name: 'C', status: 'active', role: 'admin' });
    });

    const context = () => platformContext({ platformUserId });
    const rejects = async (promise, code) => {
      const error = await promise.then(() => null, (e) => e);
      expect(error).toBeTruthy();
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(409);
    };

    it.each([
      ['purging', 'CONFLICT_TENANT_PURGING'],
      ['purged', 'CONFLICT_TENANT_PURGED'],
    ])('a %s tenant cannot be reactivated, suspended, offboarded or impersonated', async (status, code) => {
      await setStatus(status);
      await rejects(platformService.reactivateTenant({ context: context(), tenantId: ctx.a.id, reason: 'x' }), code);
      await rejects(platformService.suspendTenant({ context: context(), tenantId: ctx.a.id, reason: 'x' }), code);
      await rejects(platformService.offboardTenant({ context: context(), tenantId: ctx.a.id, reason: 'x' }), code);
      await rejects(platformService.startImpersonation({ context: context(), tenantId: ctx.a.id, propertyId: ctx.a.properties[0].id, reason: 'x' }), code);
      expect((await t.trx('tenants').where({ id: ctx.a.id }).first()).status).toBe(status); // nothing changed
    });

    it('an ordinary invalid transition keeps its own generic 422', async () => {
      await setStatus('suspended');
      const error = await platformService.offboardTenant({ context: context(), tenantId: ctx.a.id, reason: 'x' }).then(() => null, (e) => e);
      expect(error).toBeNull(); // suspended tenants CAN offboard
      const again = await platformService.offboardTenant({ context: context(), tenantId: ctx.a.id, reason: 'x' }).then(() => null, (e) => e);
      expect(again.code).toBe('VALIDATION_INVALID_TENANT_TRANSITION');
      expect(again.httpStatus).toBe(422);
    });

    it('the roster and the detail view show the purge state, the blocked reason and the latest export status', async () => {
      await setStatus('offboarding', { offboarding_requested_at: new Date(), retention_expires_at: new Date(Date.now() - DAY) });
      await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).delete();
      await t.trx('tenant_purges').insert({ tenant_id: ctx.a.id, state: 'blocked', blocked_reason: 'no_export', blocked_at: new Date(), offboarding_requested_at: new Date() });
      await t.trx('tenant_data_exports').insert({ tenant_id: ctx.a.id, status: 'failed', failed_reason: 'disk full' });

      const detail = await platformService.getTenantWithProperties({ context: context(), tenantId: ctx.a.id });
      expect(detail.purge_blocked).toBe(true);
      expect(detail.purge).toMatchObject({ state: 'blocked', blocked_reason: 'no_export', rows_deleted: 0 });
      expect(detail.latest_export).toMatchObject({ status: 'failed', failed_reason: 'disk full' });
      expect(detail.latest_export).not.toHaveProperty('file_path');

      const roster = await platformService.listTenants({ context: context() });
      expect(roster.find((row) => String(row.id) === String(ctx.a.id)).purge_blocked).toBe(true);
      expect(roster.find((row) => String(row.id) === String(ctx.b.id)).purge).toBeNull();

      // A reactivated tenant with a stale blocked row is not flagged.
      await setStatus('active');
      expect((await platformService.getTenantWithProperties({ context: context(), tenantId: ctx.a.id })).purge_blocked).toBe(false);
    });

    it('an offboarding tenant can still be reactivated (until the claim)', async () => {
      await setStatus('offboarding', { offboarding_requested_at: new Date(), retention_expires_at: new Date(Date.now() + 30 * DAY) });
      await platformService.reactivateTenant({ context: context(), tenantId: ctx.a.id, reason: 'changed mind' });
      const tenant = await t.trx('tenants').where({ id: ctx.a.id }).first();
      expect(tenant.status).toBe('active');
      expect(tenant.retention_expires_at).toBeNull();
    });
  });

  describe('the T-7d and T-1d warnings', () => {
    const now = new Date('2027-06-10T12:00:00Z');
    let adminEmail;

    beforeAll(async () => {
      // tenant a: users[1] becomes an admin; users[0] stays a manager (must NOT be warned).
      await t.trx('user_property_access').where({ user_id: ctx.a.users[1].id, property_id: ctx.a.properties[0].id }).update({ role: 'admin' });
      adminEmail = ctx.a.users[1].email;
    });

    async function offboardingWithDeadline(daysFromNow) {
      await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).update({ warned_7d_at: null, warned_1d_at: null, offboarding_requested_at: null });
      await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id }).delete();
      await t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'offboarding.purge_warning' }).delete();
      await setStatus('offboarding', {
        offboarding_requested_at: new Date(now.getTime() - 25 * DAY),
        retention_expires_at: new Date(now.getTime() + daysFromNow * DAY),
      });
    }

    // Results carry the id as MySQL returned it (a string); compare and normalise.
    const forA = (results) => results.filter((r) => String(r.tenantId) === String(ctx.a.id)).map((r) => ({ ...r, tenantId: String(r.tenantId) }));

    // The outer afterEach flips the tenant back to active; the tests in this block build on each other's state.
    beforeEach(async () => {
      await setStatus('offboarding');
    });

    const warnings = () => t.trx('outbox_events').where({ tenant_id: ctx.a.id, event_type: 'offboarding.purge_warning' });
    const payloadOf = (row) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);

    it('warns each active admin once at T-7d — not the manager — and makes a fresh export', async () => {
      await offboardingWithDeadline(5);
      const results = await purge.runPurgeWarnings({ now });

      expect(forA(results)).toEqual([{ tenantId: String(ctx.a.id), warned: '7d' }]);
      const rows = await warnings();
      expect(rows).toHaveLength(1);
      const payload = payloadOf(rows[0]);
      expect(payload.recipientEmail).toBe(adminEmail);
      expect(payload.tenantName).toBe('Fixture tenant A');
      expect(payload.deletionDate).toBe(new Date(now.getTime() + 5 * DAY).toISOString().slice(0, 10));
      expect(payload.daysRemaining).toBe('5 days');

      expect((await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first()).warned_7d_at).not.toBeNull();
      const fresh = await t.trx('tenant_data_exports').where({ tenant_id: ctx.a.id, status: 'pending' }).first();
      expect(fresh).toBeTruthy();
      expect(fresh.requested_by_user_id).toBeNull();
      expect(enqueueTenantDataExportJob).toHaveBeenCalledTimes(1);
      expect(enqueueOutboxDispatch).toHaveBeenCalledTimes(1); // dispatched at once, not left to the 60s sweep
      expect(await t.trx('audit_log').where({ tenant_id: ctx.a.id, action: 'purge_warning_7d' })).toHaveLength(1);
    });

    it('does not warn again on the next tick (once, not every 5 minutes)', async () => {
      await purge.runPurgeWarnings({ now });
      await purge.runPurgeWarnings({ now: new Date(now.getTime() + 5 * 60_000) });
      expect(await warnings()).toHaveLength(1);
      expect(enqueueTenantDataExportJob).not.toHaveBeenCalled(); // the fresh export is made once, not on every tick
    });

    it('sends the T-1d warning once, when under a day remains', async () => {
      const later = new Date(now.getTime() + 4.5 * DAY); // 12 hours left
      const results = await purge.runPurgeWarnings({ now: later });
      expect(forA(results)).toEqual([{ tenantId: String(ctx.a.id), warned: '1d' }]);
      const rows = await warnings();
      expect(rows).toHaveLength(2);
      expect(payloadOf(rows[1]).daysRemaining).toBe('1 day');
      await purge.runPurgeWarnings({ now: later });
      expect(await warnings()).toHaveLength(2);
    });

    it('sends nothing for a tenant more than 7 days from its deadline', async () => {
      await offboardingWithDeadline(20);
      expect(forA(await purge.runPurgeWarnings({ now }))).toEqual([]);
      expect(await warnings()).toHaveLength(0);
    });

    it('a tenant already PAST its deadline (offboarded before the purge was enabled) is still warned — and told deletion is a day away', async () => {
      await offboardingWithDeadline(-3);
      expect(forA(await purge.runPurgeWarnings({ now })).map((r) => r.warned)).toEqual(['7d', '1d']);
      const rows = await warnings();
      expect(rows.length).toBe(2);
      for (const row of rows) expect(payloadOf(row).deletionDate).toBe(new Date(now.getTime() + DAY).toISOString().slice(0, 10));
      expect(enqueueTenantDataExportJob).toHaveBeenCalledTimes(1); // and a fresh export was requested
    });

    it('a tenant that is reactivated and offboards AGAIN gets a fresh set of warnings', async () => {
      await offboardingWithDeadline(5);
      await purge.runPurgeWarnings({ now });
      expect(await warnings()).toHaveLength(1);

      // Reactivated, then a NEW offboarding request: a new cycle.
      await t.trx('tenants').where({ id: ctx.a.id }).update({
        offboarding_requested_at: new Date(now.getTime() - 1 * DAY),
        retention_expires_at: new Date(now.getTime() + 6 * DAY),
      });
      await purge.runPurgeWarnings({ now });
      expect(await warnings()).toHaveLength(2);
    });

    it('warns nobody, but still records that it did, when the tenant has no active admin', async () => {
      await offboardingWithDeadline(5);
      await t.trx('users').where({ id: ctx.a.users[1].id }).update({ status: 'inactive' });
      await purge.runPurgeWarnings({ now });
      expect(await warnings()).toHaveLength(0);
      expect((await t.trx('tenant_purges').where({ tenant_id: ctx.a.id }).first()).warned_7d_at).not.toBeNull();
      await t.trx('users').where({ id: ctx.a.users[1].id }).update({ status: 'active' });
    });
  });
});
