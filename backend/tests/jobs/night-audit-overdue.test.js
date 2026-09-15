'use strict';

/**
 * Real, live-Redis coverage for `scheduleNightAuditOverdueSweep` — the
 * same proof `trial-expiry.test.js`/`door-access-retention.test.js` give
 * their own schedulers, since BullMQ v6 silently ignores the older
 * `Queue#add({repeat})` API. The sweep's own logic is covered against real
 * MySQL in `tests/jobs/night-audit-overdue-sweep.test.js`.
 */

const { scheduleNightAuditOverdueSweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/night-audit-overdue');
const { nightAuditOverdueQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('scheduleNightAuditOverdueSweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    await nightAuditOverdueQueue().removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable hourly scheduler', async () => {
    await scheduleNightAuditOverdueSweep();
    const schedulers = await nightAuditOverdueQueue().getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);
    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(60 * 60_000);
  });

  it('is idempotent across restarts — still exactly one scheduler', async () => {
    await scheduleNightAuditOverdueSweep();
    await scheduleNightAuditOverdueSweep();
    const schedulers = await nightAuditOverdueQueue().getJobSchedulers();
    expect(schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID)).toHaveLength(1);
  });
});
