'use strict';

/**
 * Real, live-Redis coverage for `schedulePaymentWebhookSweep` — the same class
 * of proof `subscription-billing.test.js`/`trial-expiry.test.js` established
 * for their own schedulers, so the "v4-era `Queue#add({repeat})` is a silent
 * v6 no-op" bug cannot recur for this one.
 */

const { schedulePaymentWebhookSweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/payment-webhooks');
const { paymentWebhooksQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('schedulePaymentWebhookSweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    await paymentWebhooksQueue().removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable job scheduler — not silently a no-op', async () => {
    await schedulePaymentWebhookSweep();
    const schedulers = await paymentWebhooksQueue().getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);
    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(60000);
  });

  it('is idempotent — calling it twice (two process restarts) leaves exactly one scheduler', async () => {
    await schedulePaymentWebhookSweep();
    await schedulePaymentWebhookSweep();
    const schedulers = await paymentWebhooksQueue().getJobSchedulers();
    expect(schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID)).toHaveLength(1);
  });
});
