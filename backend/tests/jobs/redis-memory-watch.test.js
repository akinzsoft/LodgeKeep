'use strict';

jest.mock('../../src/db', () => {
  const rows = [{ tenant_id: 1, property_id: 10 }, { tenant_id: 2, property_id: 20 }];
  const chain = { join: () => chain, where: () => chain, select: async () => rows };
  return { knex: () => () => chain, scopedDb: () => ({ for: () => ({ transaction: (fn) => fn('trx') }) }) };
});
jest.mock('../../src/modules/notifications/staff-notifications', () => ({ notifyStaff: jest.fn(async () => 1) }));

const { notifyStaff } = require('../../src/modules/notifications/staff-notifications');
const { runRedisMemoryCheck, isOverThreshold, parseInfo } = require('../../src/jobs/redis-memory-watch');

const MB = 1048576;
const fakeRedis = (used, max) => ({ info: async () => `# Memory\r\nused_memory:${used}\r\nmaxmemory:${max}\r\n` });

describe('redis memory early warning', () => {
  let warn;
  beforeEach(() => {
    notifyStaff.mockClear();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('parses INFO and applies the 80% threshold exactly', () => {
    expect(parseInfo('# Memory\r\nused_memory:5\r\n')).toEqual({ used_memory: '5' });
    expect(isOverThreshold({ usedBytes: 80, maxBytes: 100 })).toBe(true);
    expect(isOverThreshold({ usedBytes: 79, maxBytes: 100 })).toBe(false);
    expect(isOverThreshold({ usedBytes: 500, maxBytes: 0 })).toBe(false); // no limit configured
  });

  it('is silent below 80%', async () => {
    const r = await runRedisMemoryCheck({ redis: fakeRedis(300 * MB, 512 * MB) });
    expect(r).toEqual({ checked: true, over: false, alerted: 0 });
    expect(warn).not.toHaveBeenCalled();
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('warns and bells super admins of every active property above 80%, with a per-day dedupe key', async () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const r = await runRedisMemoryCheck({ redis: fakeRedis(420 * MB, 512 * MB), now });
    expect(r.over).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/82%/));
    expect(notifyStaff).toHaveBeenCalledTimes(2);
    expect(notifyStaff).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'platform.redis_memory_high',
      dedupKey: 'redis-memory-high:2026-10-30',
      payload: { usedMb: 420, maxMb: 512, percent: 82 },
    }));
  });

  it('the event goes to super_admin by default', () => {
    const { NOTIFICATION_EVENTS } = require('../../src/modules/notifications/staff-notifications');
    const jestActual = jest.requireActual('../../src/modules/notifications/staff-notifications');
    expect((jestActual.NOTIFICATION_EVENTS ?? NOTIFICATION_EVENTS).find((e) => e.eventType === 'platform.redis_memory_high').defaultRoles).toEqual(['super_admin']);
  });

  it('never throws when Redis cannot be read', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runRedisMemoryCheck({ redis: { info: async () => { throw new Error('down'); } } });
    expect(r.checked).toBe(false);
    spy.mockRestore();
  });
});
