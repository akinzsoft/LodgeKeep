'use strict';

/**
 * Real, live-Redis coverage for `scheduleNotificationsSweep` — the same proof
 * `trial-expiry.test.js` and `outbox-dispatcher.test.js` give their
 * schedulers, since BullMQ v6 silently ignores the older
 * `Queue#add({repeat})` API. The sweep's own logic is covered against real
 * MySQL in `tests/notifications/staff-notifications.test.js`.
 */

const { scheduleNotificationsSweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/notifications-sweep');
const { notificationsSweepQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('scheduleNotificationsSweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    await notificationsSweepQueue().removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable five-minute scheduler', async () => {
    await scheduleNotificationsSweep();
    const schedulers = await notificationsSweepQueue().getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);
    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(5 * 60_000);
  });

  it('is idempotent across restarts — still exactly one scheduler', async () => {
    await scheduleNotificationsSweep();
    await scheduleNotificationsSweep();
    const schedulers = await notificationsSweepQueue().getJobSchedulers();
    expect(schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID)).toHaveLength(1);
  });
});
