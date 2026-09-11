'use strict';

// Real pooled connections, not the shared-transaction-per-file harness —
// the same distinction every other atomicity/concurrency suite in this
// codebase already draws (tests/reservations/concurrency.test.js,
// tests/platform/atomicity.test.js, tests/signup/atomicity.test.js).
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { runTrialExpirySweep } = require('../../src/jobs/trial-expiry');

describe('runTrialExpirySweep (PLAN.md Phase 5, real MySQL)', () => {
  const tenantIds = [];

  beforeAll(() => {
    dbModule.__setConnectionForTesting(db());
  });

  afterEach(async () => {
    while (tenantIds.length) {
      const id = tenantIds.pop();
      await db()('audit_log').where({ tenant_id: id }).delete();
      await db()('tenants').where({ id }).delete();
    }
  });

  afterAll(() => {
    dbModule.__resetForTesting();
  });

  async function makeTenant({ status, trialEndsAt }) {
    const [id] = await db()('tenants').insert({
      name: 'Sweep Test Hotels',
      slug: `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      status,
      trial_ends_at: trialEndsAt,
    });
    tenantIds.push(id);
    return id;
  }

  it('transitions a lapsed trial to suspended, with a real audit_log row', async () => {
    const id = await makeTenant({ status: 'trial', trialEndsAt: new Date(Date.now() - 60_000) });

    const transitioned = await runTrialExpirySweep();

    expect(transitioned).toBeGreaterThanOrEqual(1);
    const tenant = await db()('tenants').where({ id }).first();
    expect(tenant.status).toBe('suspended');
    const entry = await db()('audit_log').where({ tenant_id: id, action: 'trial_expired' }).first();
    expect(entry).toBeTruthy();
    expect(entry.source).toBe('job');
    expect(entry.before_state).toEqual({ status: 'trial' });
    expect(entry.after_state).toEqual({ status: 'suspended' });
  });

  it('leaves a trial with no expiry set alone', async () => {
    const id = await makeTenant({ status: 'trial', trialEndsAt: null });
    await runTrialExpirySweep();
    const tenant = await db()('tenants').where({ id }).first();
    expect(tenant.status).toBe('trial');
  });

  it('leaves a trial that has not yet expired alone', async () => {
    const id = await makeTenant({ status: 'trial', trialEndsAt: new Date(Date.now() + 60_000 * 60 * 24) });
    await runTrialExpirySweep();
    const tenant = await db()('tenants').where({ id }).first();
    expect(tenant.status).toBe('trial');
  });

  it('leaves an already-active or already-suspended tenant alone, even with a lapsed trial_ends_at', async () => {
    const activeId = await makeTenant({ status: 'active', trialEndsAt: new Date(Date.now() - 60_000) });
    const suspendedId = await makeTenant({ status: 'suspended', trialEndsAt: new Date(Date.now() - 60_000) });
    await runTrialExpirySweep();
    expect((await db()('tenants').where({ id: activeId }).first()).status).toBe('active');
    expect((await db()('tenants').where({ id: suspendedId }).first()).status).toBe('suspended');
  });

  it('repeated execution is idempotent — a second sweep transitions nothing further and creates no duplicate audit row', async () => {
    const id = await makeTenant({ status: 'trial', trialEndsAt: new Date(Date.now() - 60_000) });

    const first = await runTrialExpirySweep();
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await runTrialExpirySweep();

    // The second sweep transitions nothing for THIS tenant (already
    // suspended) — other lapsed tenants left by a prior test in this same
    // real schema are a real possibility (no shared-transaction rollback
    // here), so this only asserts on this tenant's own row, not on the
    // sweep's aggregate return value.
    expect((await db()('tenants').where({ id }).first()).status).toBe('suspended');
    expect(await db()('audit_log').where({ tenant_id: id, action: 'trial_expired' })).toHaveLength(1);
  });

  it('mutation test: two genuinely concurrent sweeps against the same lapsed trial produce exactly one transition and one audit row', async () => {
    const id = await makeTenant({ status: 'trial', trialEndsAt: new Date(Date.now() - 60_000) });

    // Two overlapping sweep RUNS (not two tenants) racing the same lapsed
    // tenant — the scenario a real deploy with more than one process, or a
    // slow sweep overlapping the next scheduled tick, produces.
    await Promise.all([runTrialExpirySweep(), runTrialExpirySweep()]);

    const tenant = await db()('tenants').where({ id }).first();
    expect(tenant.status).toBe('suspended');
    const entries = await db()('audit_log').where({ tenant_id: id, action: 'trial_expired' });
    expect(entries).toHaveLength(1);
  });
});
