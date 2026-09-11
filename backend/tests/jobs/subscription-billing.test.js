'use strict';

/**
 * Real, live-Redis coverage for `scheduleSubscriptionBillingSweep` — the
 * identical class of proof `tests/jobs/trial-expiry.test.js`/
 * `tests/jobs/outbox-dispatcher.test.js` already established for their own
 * schedulers, applied here so the same "the old v4-era `Queue#add({repeat})`
 * call is a silent v6 no-op" bug class cannot recur for a third scheduler
 * built after that one was already fixed twice.
 */

const { scheduleSubscriptionBillingSweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/subscription-billing');
const { subscriptionBillingQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('scheduleSubscriptionBillingSweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    const queue = subscriptionBillingQueue();
    await queue.removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable job scheduler — not silently a no-op', async () => {
    await scheduleSubscriptionBillingSweep();

    const queue = subscriptionBillingQueue();
    const schedulers = await queue.getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);

    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(60000);
  });

  it('is idempotent — calling it twice (e.g. two process restarts) still leaves exactly one scheduler', async () => {
    await scheduleSubscriptionBillingSweep();
    await scheduleSubscriptionBillingSweep();

    const queue = subscriptionBillingQueue();
    const schedulers = await queue.getJobSchedulers();
    const ours = schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID);

    expect(ours).toHaveLength(1);
  });
});
