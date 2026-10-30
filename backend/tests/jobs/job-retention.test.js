'use strict';

/**
 * Every BullMQ queue carries explicit retention (production incident: unbounded completed-job history filled
 * Redis). Real Redis, real BullMQ. Also pins the dedupe finding: nothing relies on retained jobs.
 */

const fs = require('fs');
const path = require('path');
const queues = require('../../src/jobs/queues');
const { DEFAULT_RETENTION, PAYMENT_WEBHOOKS_RETENTION, retentionFor } = require('../../src/jobs/job-retention');
const { schedulePaymentWebhookSweep, SWEEP_SCHEDULER_ID } = require('../../src/jobs/payment-webhooks');
const { scheduleTrialExpirySweep, SWEEP_SCHEDULER_ID: TRIAL_ID } = require('../../src/jobs/trial-expiry');
const { destroyRedisConnection } = require('../../src/jobs/redis-connection');

const getters = Object.entries(queues).filter(([name, value]) => typeof value === 'function' && /Queue$/.test(name));

describe('queue retention', () => {
  afterAll(async () => {
    await queues.__closeQueuesForTesting();
    await destroyRedisConnection();
  });

  it('there is a getter for every queue name', () => {
    expect(getters).toHaveLength(queues.ALL_QUEUE_NAMES.length);
  });

  it.each(getters)('%s has bounded removeOnComplete and removeOnFail defaults', (_name, getter) => {
    const opts = getter().defaultJobOptions;
    expect(opts.removeOnComplete).toEqual({ age: expect.any(Number), count: expect.any(Number) });
    expect(opts.removeOnFail).toEqual({ age: expect.any(Number), count: expect.any(Number) });
    expect(opts.removeOnComplete.age).toBeLessThanOrEqual(3600);
    expect(opts.removeOnComplete.count).toBeLessThanOrEqual(1000);
    expect(opts.removeOnFail.age).toBeGreaterThan(opts.removeOnComplete.age);
    expect(opts.removeOnFail.count).toBeLessThanOrEqual(10000);
  });

  it('payment-webhooks keeps failed jobs the longest', () => {
    for (const name of queues.ALL_QUEUE_NAMES) {
      expect(retentionFor(name).removeOnFail.age).toBeLessThanOrEqual(PAYMENT_WEBHOOKS_RETENTION.removeOnFail.age);
    }
    expect(PAYMENT_WEBHOOKS_RETENTION.removeOnFail.age).toBeGreaterThan(DEFAULT_RETENTION.removeOnFail.age);
    expect(queues.paymentWebhooksQueue().defaultJobOptions.removeOnFail).toEqual(PAYMENT_WEBHOOKS_RETENTION.removeOnFail);
  });

  it('jobs created by a repeatable scheduler inherit the retention (the four queues that leaked used none)', async () => {
    await schedulePaymentWebhookSweep();
    await scheduleTrialExpirySweep();
    try {
      const pw = await queues.paymentWebhooksQueue().getJobScheduler(SWEEP_SCHEDULER_ID);
      expect(pw.template.opts.removeOnComplete).toEqual(DEFAULT_RETENTION.removeOnComplete);
      expect(pw.template.opts.removeOnFail).toEqual(PAYMENT_WEBHOOKS_RETENTION.removeOnFail);
      const te = await queues.trialExpiryQueue().getJobScheduler(TRIAL_ID);
      expect(te.template.opts.removeOnComplete).toEqual(DEFAULT_RETENTION.removeOnComplete);
    } finally {
      await queues.paymentWebhooksQueue().removeJobScheduler(SWEEP_SCHEDULER_ID);
      await queues.trialExpiryQueue().removeJobScheduler(TRIAL_ID);
    }
  });

  it('nothing relies on retained jobs: no deterministic jobId in any job file, and no per-call retention override', () => {
    const dir = path.join(__dirname, '../../src/jobs');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      if (file === 'job-retention.js') continue;
      const code = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(`${file}: ${/\bjobId\s*:/.test(code)}`).toBe(`${file}: false`);
      expect(`${file}: ${/removeOn(Complete|Fail)/.test(code)}`).toBe(`${file}: false`);
    }
  });

  it('webhook dedupe lives in MySQL: both event tables have UNIQUE(provider, provider_event_id)', async () => {
    const { knex } = require('../../src/db');
    for (const table of ['payment_webhook_events', 'subscription_webhook_events']) {
      const [rows] = await knex().raw(`SHOW INDEX FROM ${table} WHERE Non_unique = 0`);
      const cols = rows.filter((r) => r.Key_name !== 'PRIMARY').sort((a, b) => a.Seq_in_index - b.Seq_in_index).map((r) => r.Column_name);
      expect(cols).toEqual(expect.arrayContaining(['provider', 'provider_event_id']));
    }
  });
});
