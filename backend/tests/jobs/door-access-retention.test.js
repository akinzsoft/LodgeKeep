'use strict';

/**
 * Real, live-Redis coverage for `scheduleDoorAccessRetentionSweep` — the
 * same proof `trial-expiry.test.js`/`notifications-sweep.test.js` give
 * their own schedulers, since BullMQ v6 silently ignores the older
 * `Queue#add({repeat})` API. The sweep's own logic is covered against real
 * MySQL in `tests/jobs/door-access-retention-sweep.test.js`.
 */

const { scheduleDoorAccessRetentionSweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/door-access-retention');
const { doorAccessRetentionQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('scheduleDoorAccessRetentionSweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    await doorAccessRetentionQueue().removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable once-daily scheduler', async () => {
    await scheduleDoorAccessRetentionSweep();
    const schedulers = await doorAccessRetentionQueue().getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);
    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(24 * 60 * 60_000);
  });

  it('is idempotent across restarts — still exactly one scheduler', async () => {
    await scheduleDoorAccessRetentionSweep();
    await scheduleDoorAccessRetentionSweep();
    const schedulers = await doorAccessRetentionQueue().getJobSchedulers();
    expect(schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID)).toHaveLength(1);
  });
});
