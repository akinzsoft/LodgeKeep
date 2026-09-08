'use strict';

/**
 * Real, live-Redis coverage for `scheduleOutboxSweep` — the exact BullMQ
 * transport class of bug `outbox-dispatcher.js`'s own header already
 * flagged as untested ("No live BullMQ integration test exists in this
 * codebase for ANY job yet"). Found live, not hypothetically: the
 * previous implementation called `Queue#add(name, data, {repeat, jobId})`
 * — BullMQ v4-era API. This codebase's installed BullMQ (v6) renamed
 * repeatable jobs to "Job Schedulers"; the old call completed with no
 * error but registered nothing a running Worker would ever fire, so
 * every outbox event relying purely on the periodic sweep for delivery
 * (`inviteUser`'s own documented precedent, followed by this session's
 * own guest-password-reset and MFA-code passes) was never actually
 * dispatched outside a manual sweep, in any environment, including
 * production. This test exists specifically so that class of bug cannot
 * silently recur — it inspects the real Redis-backed queue state
 * directly, not just that `scheduleOutboxSweep()` resolves without
 * throwing (which the old, broken version also did).
 *
 * Requires the real Redis instance docker-compose already provides for
 * this stack (ARCHITECTURE.md §14) — no mock, the same "real MySQL, no
 * mocks" discipline this codebase's own test suite already applies to
 * the database layer, applied here to the one piece of infrastructure
 * that isn't MySQL.
 */

const { scheduleOutboxSweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/outbox-dispatcher');
const { outboxDispatchQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('scheduleOutboxSweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    // Never leave a real scheduler registered beyond this test's own
    // assertions — this suite's own real dev-environment sweep, started
    // separately by `src/server.js`, must not be duplicated or disturbed.
    const queue = outboxDispatchQueue();
    await queue.removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable job scheduler — not silently a no-op', async () => {
    await scheduleOutboxSweep();

    const queue = outboxDispatchQueue();
    const schedulers = await queue.getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);

    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(60000);
  });

  it('is idempotent — calling it twice (e.g. two process restarts) still leaves exactly one scheduler', async () => {
    await scheduleOutboxSweep();
    await scheduleOutboxSweep();

    const queue = outboxDispatchQueue();
    const schedulers = await queue.getJobSchedulers();
    const ours = schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID);

    expect(ours).toHaveLength(1);
  });
});
