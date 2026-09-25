'use strict';

/**
 * Real pooled connections, not the shared-transaction harness — a nested
 * transaction there is inline, so it can prove neither a real lock nor a real race
 * (the `tests/jobs/trial-expiry-sweep.test.js` / `tests/reservations/concurrency.test.js`
 * distinction). Proves, on genuinely concurrent connections:
 *
 *  1. PURGE CLAIM vs REACTIVATION. Both are conditional UPDATEs on the same
 *     `tenants` row. A third connection holds that row's lock, both requests are
 *     started and shown NOT to have answered (so both are queued), then the lock is
 *     released. Exactly one wins, whichever the engine grants first: the claim wins
 *     and reactivation is refused with a 409, or reactivation wins and the claim
 *     reports it claimed nothing and changed NOTHING. Never both.
 *  2. Two ticks on one tenant cannot both delete (the lease).
 *  3. A tick with almost no time budget still makes progress, and the purge
 *     resumes across ticks to completion.
 *  4. A foreign-key refusal is recorded and retried, not fatal, and the purge
 *     completes once it clears.
 *  5. The per-sweep cap and dry-run mode.
 */

// The enqueue helpers write real jobs to the shared Redis; a running dev backend's
// worker could pick those up against the DEV database. Mocked: the tests assert the
// calls, never the queue.
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
const { db } = require('../helpers/db');
const dbModule = require('../../src/db');
const { platformContext } = require('../../src/modules/tenancy');
const purge = require('../../src/modules/offboarding/purge');
const { reactivateTenant } = require('../../src/modules/platform/service');

const DAY = 24 * 60 * 60 * 1000;

describe('tenant retention purge under real concurrent connections', () => {
  let exportsDir;
  let platformUserId;
  const tenantIds = [];
  let counter = 0;

  beforeAll(async () => {
    dbModule.__setConnectionForTesting(db());
    exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-race-exports-'));
    process.env.EXPORT_STORAGE_DIR = exportsDir;
    process.env.IMPORT_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-race-imports-'));
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    [platformUserId] = await db()('platform_users').insert({ email: `purge-race-${suffix}@example.com`, password_hash: 'x', first_name: 'Race', last_name: 'Admin', status: 'active', role: 'admin' });
  });

  afterEach(() => {
    delete process.env.TENANT_PURGE_DRY_RUN;
    delete process.env.TENANT_PURGE_MAX_PER_TICK;
  });

  /** Any tenant this file left in a due or purging state — so a sweep test sees only its own. */
  async function settleLeftovers() {
    // Tenants an earlier test left waiting (a cap of 1 starts only one per sweep) would take this test's slot.
    const previous = process.env.TENANT_PURGE_MAX_PER_TICK;
    process.env.TENANT_PURGE_MAX_PER_TICK = '100';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await purge.runPurgeSweep({ now: new Date() });
    } finally {
      spy.mockRestore();
      if (previous === undefined) delete process.env.TENANT_PURGE_MAX_PER_TICK;
      else process.env.TENANT_PURGE_MAX_PER_TICK = previous;
    }
    const leftovers = await db()('tenants').whereIn('id', tenantIds).whereIn('status', ['purging']).select('id');
    for (const { id } of leftovers) await runToCompletion(id);
  }

  afterAll(async () => {
    for (const id of tenantIds) await cleanupTenant(id);
    await db()('platform_users').where({ id: platformUserId }).delete();
    fs.rmSync(exportsDir, { recursive: true, force: true });
    delete process.env.EXPORT_STORAGE_DIR;
    delete process.env.IMPORT_STORAGE_DIR;
    dbModule.__resetForTesting();
  });

  /** A committed, offboarding, past-deadline tenant with a little data, and a usable export. */
  async function makeTenant({ withExport = true } = {}) {
    counter += 1;
    const suffix = `${Date.now().toString(36)}${counter}${Math.floor(Math.random() * 1000)}`;
    const now = new Date();
    const [tenantId] = await db()('tenants').insert({
      name: 'Purge Race Tenant',
      slug: `purge-race-${suffix}`,
      status: 'offboarding',
      offboarding_requested_at: new Date(now.getTime() - 40 * DAY),
      retention_expires_at: new Date(now.getTime() - 10 * DAY),
    });
    tenantIds.push(tenantId);
    // Already warned (7 days and 1 day ahead, both long past): the gate requires it.
    await db()('tenant_purges').insert({
      tenant_id: tenantId,
      state: 'scheduled',
      offboarding_requested_at: new Date(now.getTime() - 40 * DAY),
      warned_7d_at: new Date(now.getTime() - 9 * DAY),
      warned_1d_at: new Date(now.getTime() - 2 * DAY),
    });
    const [propertyId] = await db()('properties').insert({ tenant_id: tenantId, slug: `purge-race-prop-${suffix}`, name: 'Race Property', timezone: 'Africa/Lagos', base_currency: 'NGN', current_business_date: '2027-06-01' });
    const [userId] = await db()('users').insert({ tenant_id: tenantId, email: `race-${suffix}@example.com`, password_hash: `$2b$12$${'x'.repeat(53)}`, first_name: 'Race', last_name: 'User', status: 'active' });
    await db()('guests').insert({ tenant_id: tenantId, first_name: 'Race', last_name: 'Guest', email: `guest-${suffix}@example.com` });
    await db()('market_segments').insert({ tenant_id: tenantId, property_id: propertyId, code: 'RACE', name: 'Race segment' });
    await db()('audit_log').insert({ tenant_id: tenantId, property_id: propertyId, entity_type: 'guests', action: 'create', source: 'api', user_id: userId });

    let exportId = null;
    if (withExport) {
      const file = path.join(exportsDir, `tenant-${tenantId}-export-1.json`);
      fs.writeFileSync(file, '{"race":true}');
      [exportId] = await db()('tenant_data_exports').insert({
        tenant_id: tenantId,
        status: 'completed',
        file_path: file,
        file_size_bytes: fs.statSync(file).size,
        completed_at: new Date(now.getTime() - 8 * DAY), // after the 7-day warning, as the gate requires
      });
    }
    return { tenantId, propertyId, userId, exportId, now };
  }

  async function cleanupTenant(tenantId) {
    await db()('tenant_purges').where({ tenant_id: tenantId }).delete();
    await db()('tenant_data_exports').where({ tenant_id: tenantId }).delete();
    for (const table of ['audit_log', 'market_segments', 'guests', 'users', 'properties']) await db()(table).where({ tenant_id: tenantId }).delete();
    await db()('subscriptions').where({ tenant_id: tenantId }).delete();
    await db()('tenants').where({ id: tenantId }).delete();
  }

  const statusOf = async (tenantId) => (await db()('tenants').where({ id: tenantId }).first()).status;
  const settled = (promise) => {
    const state = { done: false };
    promise.then(() => (state.done = true), () => (state.done = true));
    return state;
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function runToCompletion(tenantId, { now = new Date(), budgetMs, maxTicks = 200 } = {}) {
    let ticks = 0;
    for (; ticks < maxTicks; ticks += 1) {
      const result = await purge.runPurgeTick({ tenantId, now, budgetMs });
      if (result.status === 'complete') return { ticks: ticks + 1 };
    }
    throw new Error(`purge of tenant ${tenantId} did not complete in ${maxTicks} ticks`);
  }

  it('claim vs reactivation: exactly one wins, on either ordering, over many rounds', async () => {
    const outcomes = { claimWon: 0, reactivateWon: 0 };

    for (let round = 0; round < 6; round += 1) {
      const { tenantId, exportId, now } = await makeTenant();
      const holder = await db().transaction(); // a THIRD connection holding the tenants row
      await holder('tenants').where({ id: tenantId }).forUpdate().first();

      const claim = purge.claimTenantForPurge({ tenantId, exportId, now });
      const reactivate = reactivateTenant({ context: platformContext({ platformUserId }), tenantId, reason: 'race' });
      const claimState = settled(claim);
      const reactivateState = settled(reactivate);

      await pause(400);
      expect(claimState.done).toBe(false); // both are queued on the lock, neither has answered
      expect(reactivateState.done).toBe(false);
      await holder.commit();

      const [claimResult, reactivateResult] = await Promise.allSettled([claim, reactivate]);
      const finalStatus = await statusOf(tenantId);

      if (finalStatus === 'purging') {
        outcomes.claimWon += 1;
        expect(claimResult.status).toBe('fulfilled');
        expect(claimResult.value).toEqual({ claimed: true });
        expect(reactivateResult.status).toBe('rejected');
        expect(reactivateResult.reason.code).toBe('CONFLICT_TENANT_PURGING');
        expect(reactivateResult.reason.httpStatus).toBe(409);
        expect(await db()('users').where({ tenant_id: tenantId, status: 'active' })).toHaveLength(0); // access ended at the claim
      } else {
        outcomes.reactivateWon += 1;
        expect(finalStatus).toBe('active');
        expect(reactivateResult.status).toBe('fulfilled');
        expect(claimResult.status).toBe('fulfilled');
        expect(claimResult.value).toEqual({ claimed: false });
        // The losing claim changed NOTHING: the tenant's users, sessions and data are intact.
        expect(await db()('users').where({ tenant_id: tenantId, status: 'active' })).toHaveLength(1);
        expect(await db()('guests').where({ tenant_id: tenantId })).toHaveLength(1);
        const tenant = await db()('tenants').where({ id: tenantId }).first();
        expect(tenant.retention_expires_at).toBeNull(); // reactivation cleared the deadline
        expect(tenant.offboarding_requested_at).toBeNull();
      }
    }
    expect(outcomes.claimWon + outcomes.reactivateWon).toBe(6);
  }, 60_000);

  it('a reactivate-then-re-offboard between the gate and the claim cannot be purged (the new deadline is in the future)', async () => {
    const { tenantId, exportId, now } = await makeTenant();
    // The gate passed on the old deadline; before the claim the tenant is reactivated and offboards again.
    await db()('tenants').where({ id: tenantId }).update({ status: 'offboarding', offboarding_requested_at: now, retention_expires_at: new Date(now.getTime() + 30 * DAY) });
    expect(await purge.claimTenantForPurge({ tenantId, exportId, now })).toEqual({ claimed: false });
    expect(await statusOf(tenantId)).toBe('offboarding');
  });

  it('two ticks on one tenant never both delete (the lease), and the purge still completes', async () => {
    const { tenantId, exportId, now } = await makeTenant();
    await purge.ensurePurgeRow(await db()('tenants').where({ id: tenantId }).first());
    await purge.claimTenantForPurge({ tenantId, exportId, now });

    const results = await Promise.all([purge.runPurgeTick({ tenantId, now }), purge.runPurgeTick({ tenantId, now })]);
    for (const result of results) expect(['progress', 'skipped', 'complete']).toContain(result.status);
    await runToCompletion(tenantId, { now });

    expect(await statusOf(tenantId)).toBe('purged');
    expect(await db()('guests').where({ tenant_id: tenantId })).toHaveLength(0);
    const finals = await db()('audit_log').where({ tenant_id: tenantId });
    expect(finals).toHaveLength(1); // exactly one tenant_purged row, however the ticks interleaved
    expect(finals[0].action).toBe('tenant_purged');
  }, 60_000);

  it('a lease held by another instance makes a tick skip; an expired lease is taken over', async () => {
    const { tenantId, exportId, now } = await makeTenant();
    await purge.claimTenantForPurge({ tenantId, exportId, now });
    await db()('tenant_purges').where({ tenant_id: tenantId }).update({ lease_owner: 'another-instance', lease_expires_at: new Date(now.getTime() + 60_000) });
    expect(await purge.runPurgeTick({ tenantId, now })).toEqual({ status: 'skipped', reason: 'leased' });
    expect(await db()('guests').where({ tenant_id: tenantId })).toHaveLength(1); // nothing deleted while leased

    await db()('tenant_purges').where({ tenant_id: tenantId }).update({ lease_expires_at: new Date(now.getTime() - 1000) });
    expect((await purge.runPurgeTick({ tenantId, now })).status).toBe('progress');
    expect(await db()('guests').where({ tenant_id: tenantId })).toHaveLength(0);
    await runToCompletion(tenantId, { now });
  }, 60_000);

  it('resumes across ticks: with almost no time budget each tick makes some progress and the purge still completes', async () => {
    const { tenantId, exportId, now } = await makeTenant();
    await purge.claimTenantForPurge({ tenantId, exportId, now });

    const first = await purge.runPurgeTick({ tenantId, now, budgetMs: 0 });
    expect(first).toMatchObject({ status: 'progress', reason: 'budget', deletedThisTick: 1 });
    expect(await statusOf(tenantId)).toBe('purging'); // not finished, not lost

    const { ticks } = await runToCompletion(tenantId, { now, budgetMs: 0 });
    expect(ticks).toBeGreaterThan(1);
    expect(await statusOf(tenantId)).toBe('purged');
    expect(await db()('users').where({ tenant_id: tenantId })).toHaveLength(0);
  }, 60_000);

  it('a foreign-key refusal is recorded and does not abort the tick; the purge completes once it clears', async () => {
    const { tenantId, exportId, userId, now } = await makeTenant();
    await db().raw('DROP TABLE IF EXISTS zz_purge_blocker');
    await db().raw(
      `CREATE TABLE zz_purge_blocker (id INT PRIMARY KEY AUTO_INCREMENT, tenant_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
         CONSTRAINT zz_blocker_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE RESTRICT)`
    );
    await db()('zz_purge_blocker').insert({ tenant_id: tenantId, user_id: userId });

    try {
      await purge.claimTenantForPurge({ tenantId, exportId, now });
      const tick = await purge.runPurgeTick({ tenantId, now });

      expect(tick.status).toBe('progress'); // the tick survived the ER_ROW_IS_REFERENCED_2
      expect(await statusOf(tenantId)).toBe('purging'); // and the tenant is NOT marked purged
      const row = await db()('tenant_purges').where({ tenant_id: tenantId }).first();
      expect(row.last_error).toMatch(/users/);
      expect(await db()('guests').where({ tenant_id: tenantId })).toHaveLength(0); // everything else was still deleted
      expect(await db()('users').where({ tenant_id: tenantId })).toHaveLength(1); // only the blocked table remains
    } finally {
      await db().raw('DROP TABLE IF EXISTS zz_purge_blocker');
    }
    await runToCompletion(tenantId, { now });
    expect(await statusOf(tenantId)).toBe('purged');
  }, 60_000);

  it('a purge stuck on a foreign key does not use up the per-tick slot other tenants are waiting for', async () => {
    process.env.TENANT_PURGE_MAX_PER_TICK = '1';
    await settleLeftovers();
    const stuck = await makeTenant();
    await db().raw('DROP TABLE IF EXISTS zz_purge_blocker');
    await db().raw(
      `CREATE TABLE zz_purge_blocker (id INT PRIMARY KEY AUTO_INCREMENT, tenant_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
         CONSTRAINT zz_blocker_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE RESTRICT)`
    );
    await db()('zz_purge_blocker').insert({ tenant_id: stuck.tenantId, user_id: stuck.userId });
    let waiting;
    try {
      await purge.claimTenantForPurge({ tenantId: stuck.tenantId, exportId: stuck.exportId, now: stuck.now });
      await purge.runPurgeTick({ tenantId: stuck.tenantId, now: stuck.now }); // deletes everything it can, then is stuck
      const idle = await purge.runPurgeTick({ tenantId: stuck.tenantId, now: stuck.now });
      expect(idle).toMatchObject({ status: 'progress', reason: 'not_empty', deletedThisTick: 0 });

      waiting = await makeTenant();
      const results = await purge.runPurgeSweep({ now: new Date() });
      expect(results.find((r) => String(r.tenantId) === String(stuck.tenantId))).toMatchObject({ status: 'progress', counted: false });
      expect(results.find((r) => String(r.tenantId) === String(waiting.tenantId))).toMatchObject({ claimed: true, counted: true });
    } finally {
      await db().raw('DROP TABLE IF EXISTS zz_purge_blocker');
    }
    await runToCompletion(stuck.tenantId);
    await runToCompletion(waiting.tenantId);
    expect(await statusOf(waiting.tenantId)).toBe('purged');
  }, 120_000);

  it('the retained subscription webhook payloads (card token, payer email) are redacted at the claim and again at finalize', async () => {
    const { tenantId, exportId, now } = await makeTenant();
    const insert = () =>
      db()('subscription_webhook_events').insert({
        tenant_id: tenantId,
        provider: 'paystack',
        provider_event_id: `redact-${tenantId}-${Math.random().toString(36).slice(2, 6)}`,
        payload: JSON.stringify({ data: { authorization: { authorization_code: 'AUTH_secret' }, customer: { email: 'payer@example.com' } } }),
        verified: true,
      });
    await insert();
    await purge.claimTenantForPurge({ tenantId, exportId, now });
    let payloads = await db()('subscription_webhook_events').where({ tenant_id: tenantId }).pluck('payload');
    expect(JSON.stringify(payloads)).not.toMatch(/AUTH_secret|payer@example\.com/);

    await insert(); // a signed event persisted between the claim and the finalize
    await runToCompletion(tenantId, { now });
    payloads = await db()('subscription_webhook_events').where({ tenant_id: tenantId }).pluck('payload');
    expect(payloads).toHaveLength(2); // the billing record itself is kept
    expect(JSON.stringify(payloads)).not.toMatch(/AUTH_secret|payer@example\.com/);
    await db()('subscription_webhook_events').where({ tenant_id: tenantId }).delete();
  }, 60_000);

  it.each(['abc', '0', '-3', '1.5'])('a garbage safeguard setting (%s) falls back to the default instead of switching the safeguard off', async (value) => {
    process.env.TENANT_PURGE_MAX_PER_TICK = value;
    process.env.TENANT_PURGE_MIN_RETENTION_DAYS = value;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await settleLeftovers();
    const [a, b] = [await makeTenant(), await makeTenant()];
    const results = await purge.runPurgeSweep({ now: new Date() });
    spy.mockRestore();
    delete process.env.TENANT_PURGE_MIN_RETENTION_DAYS;
    const started = results.filter((r) => [a.tenantId, b.tenantId].map(String).includes(String(r.tenantId)) && r.claimed);
    expect(started).toHaveLength(1); // the default cap of 1 held
    await settleLeftovers();
  }, 120_000);

  it('a sweep starts at most TENANT_PURGE_MAX_PER_TICK purges, and a blocked tenant does not use up the slot', async () => {
    process.env.TENANT_PURGE_MAX_PER_TICK = '1';
    await settleLeftovers();
    const blocked = await makeTenant({ withExport: false });
    const ready = await makeTenant();
    const second = await makeTenant();
    const now = new Date();

    const results = await purge.runPurgeSweep({ now });
    const mine = results.filter((r) => [blocked.tenantId, ready.tenantId, second.tenantId].map(String).includes(String(r.tenantId)));

    expect(mine.find((r) => String(r.tenantId) === String(blocked.tenantId))).toMatchObject({ status: 'blocked', counted: false });
    const started = mine.filter((r) => r.counted && r.status !== 'blocked');
    expect(started).toHaveLength(1); // the cap
    expect((await db()('tenants').whereIn('id', [ready.tenantId, second.tenantId]).where({ status: 'offboarding' })).length).toBe(1); // exactly one was left waiting
    for (const id of [ready.tenantId, second.tenantId]) {
      if ((await statusOf(id)) === 'purging') await runToCompletion(id, { now });
    }
  }, 120_000);

  it('dry-run mode evaluates and writes nothing', async () => {
    process.env.TENANT_PURGE_DRY_RUN = 'true';
    process.env.TENANT_PURGE_MAX_PER_TICK = '100'; // dry-run counts every due tenant; do not let another one hide this test's
    const { tenantId } = await makeTenant();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const results = await purge.runPurgeSweep({ now: new Date() });
    spy.mockRestore();

    expect(results.find((r) => String(r.tenantId) === String(tenantId))).toMatchObject({ status: 'dry_run' });
    expect(await statusOf(tenantId)).toBe('offboarding');
    expect(await db()('guests').where({ tenant_id: tenantId })).toHaveLength(1);
    expect(await db()('users').where({ tenant_id: tenantId, status: 'active' })).toHaveLength(1);
    expect((await db()('tenant_purges').where({ tenant_id: tenantId }).first()).state).toBe('scheduled'); // untouched
    const preview = await purge.previewPurge({ tenantId });
    expect(preview.tables.guests).toBe(1);
    expect(preview.totalRows).toBeGreaterThan(3);
  });
});
