'use strict';

/** scripts/trim-bullmq-jobs.js against real Redis, on throwaway queue names. */

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { main } = require('../../scripts/trim-bullmq-jobs');

const NAME = `trimtest-${Date.now().toString(36)}`;
const RETENTION = { removeOnComplete: { age: 1, count: 1000 }, removeOnFail: { age: 2, count: 5000 } };

function connection() {
  return new IORedis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD || undefined, maxRetriesPerRequest: null });
}

describe('scripts/trim-bullmq-jobs', () => {
  let redis;
  let queue;

  async function run(argv) {
    const lines = [];
    const code = await main({ redis, argv, out: (l) => lines.push(l), queueNames: [NAME], retentionFor: () => RETENTION });
    return { code, text: lines.join('\n') };
  }

  async function counts() {
    return queue.getJobCounts('completed', 'failed', 'waiting', 'active', 'delayed', 'paused', 'prioritized');
  }

  beforeAll(async () => {
    redis = connection();
    queue = new Queue(NAME, { connection: redis });
    // completed (2) and failed (1) via a real worker
    await queue.add('ok', {});
    await queue.add('ok', {});
    await queue.add('bad', {}, { attempts: 1 });
    const worker = new Worker(NAME, async (job) => { if (job.name === 'bad') throw new Error('boom'); }, { connection: connection() });
    await new Promise((resolve) => {
      const check = async () => { const c = await counts(); if (c.completed === 2 && c.failed === 1) resolve(); else setTimeout(check, 50); };
      check();
    });
    await worker.close();
    // left alone by the script: waiting, delayed, prioritized, and a repeatable scheduler
    await queue.add('waiting', {});
    await queue.add('later', {}, { delay: 3_600_000 });
    await queue.add('prio', {}, { priority: 5 });
    await queue.upsertJobScheduler('sched', { every: 3_600_000 }, { name: 'sweep', data: {} });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  });

  it('does not count completed/failed jobs that are still inside the retention window', async () => {
    const { text } = await run([]);
    expect(text).toMatch(new RegExp(`${NAME}: 0 completed older than 1s, 0 failed older than 2s`));
    await new Promise((r) => setTimeout(r, 2200));
  });

  it('dry run reports what would go and removes nothing', async () => {
    const before = await counts();
    const { code, text } = await run([]);
    expect(code).toBe(0);
    expect(text).toMatch(/DRY RUN/);
    expect(text).toMatch(/used_memory before/);
    expect(text).toMatch(new RegExp(`${NAME}: 2 completed older than 1s, 1 failed older than 2s`));
    expect(await counts()).toEqual(before);
  });

  it('rejects unknown flags without touching anything', async () => {
    const before = await counts();
    expect((await run(['--aply'])).code).toBe(1);
    expect(await counts()).toEqual(before);
  });

  it('--apply removes only old completed and failed jobs; waiting, delayed, prioritized and the scheduler survive', async () => {
    const before = await counts();
    const { code, text } = await run(['--apply']);
    expect(code).toBe(0);
    expect(text).toMatch(/removed completed 2, failed 1/);
    expect(text).toMatch(/used_memory after/);
    expect(text).not.toMatch(/password/i);
    const after = await counts();
    expect(after.completed).toBe(0);
    expect(after.failed).toBe(0);
    for (const state of ['waiting', 'active', 'delayed', 'paused', 'prioritized']) expect(after[state]).toBe(before[state]);
    expect(after.waiting + after.delayed + after.prioritized).toBeGreaterThanOrEqual(3);
    expect((await queue.getJobSchedulers()).map((s) => s.key)).toContain('sched');
  });
});
