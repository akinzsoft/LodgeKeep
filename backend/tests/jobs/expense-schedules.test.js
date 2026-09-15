'use strict';

/**
 * Real, live-Redis coverage for `scheduleExpenseSchedulesSweep` — the same
 * proof `door-access-retention.test.js`/`trial-expiry.test.js` give their
 * own schedulers, since BullMQ v6 silently ignores the older
 * `Queue#add({repeat})` API. The sweep's own logic is covered against real
 * MySQL in `tests/jobs/expense-schedules-sweep.test.js`.
 */

const { scheduleExpenseSchedulesSweep, SWEEP_SCHEDULER_ID, SWEEP_JOB_NAME } = require('../../src/jobs/expense-schedules');
const { expenseSchedulesQueue, __closeQueuesForTesting } = require('../../src/jobs/queues');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

describe('scheduleExpenseSchedulesSweep (real Redis, real BullMQ)', () => {
  afterEach(async () => {
    await expenseSchedulesQueue().removeJobScheduler(SWEEP_SCHEDULER_ID);
  });

  afterAll(async () => {
    await __closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('registers a real, repeatable once-daily scheduler', async () => {
    await scheduleExpenseSchedulesSweep();
    const schedulers = await expenseSchedulesQueue().getJobSchedulers();
    const ours = schedulers.find((s) => s.key === SWEEP_SCHEDULER_ID);
    expect(ours).toBeDefined();
    expect(ours.name).toBe(SWEEP_JOB_NAME);
    expect(ours.every).toBe(24 * 60 * 60_000);
  });

  it('is idempotent across restarts — still exactly one scheduler', async () => {
    await scheduleExpenseSchedulesSweep();
    await scheduleExpenseSchedulesSweep();
    const schedulers = await expenseSchedulesQueue().getJobSchedulers();
    expect(schedulers.filter((s) => s.key === SWEEP_SCHEDULER_ID)).toHaveLength(1);
  });
});
