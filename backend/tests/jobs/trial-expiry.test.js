'use strict';

/**
 * Real, live-Redis coverage for `scheduleTrialExpirySweep` — the identical
 * class of proof `tests/jobs/outbox-dispatcher.test.js` already established
 * for `scheduleOutboxSweep`, applied here so the same "the old v4-era
 * `Queue#add({repeat})` call is a silent v6 no-op" bug class cannot recur
 * for a second scheduler built after that one was already fixed.
 */

const { scheduleTrialExpirySweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/trial-expiry');
const { trialExpiryQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('scheduleTrialExpirySweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    const queue = trialExpiryQueue();
    await queue.removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable job scheduler — not silently a no-op', async () => {
    await scheduleTrialExpirySweep();

    const queue = trialExpiryQueue();
    const schedulers = await queue.getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);

    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(60000);
  });

  it('is idempotent — calling it twice (e.g. two process restarts) still leaves exactly one scheduler', async () => {
    await scheduleTrialExpirySweep();
    await scheduleTrialExpirySweep();

    const queue = trialExpiryQueue();
    const schedulers = await queue.getJobSchedulers();
    const ours = schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID);

    expect(ours).toHaveLength(1);
  });
});
