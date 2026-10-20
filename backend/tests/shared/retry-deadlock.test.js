'use strict';

const { retryOnDeadlock } = require('../../src/shared/retry-deadlock');

const deadlock = () => Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });

describe('retryOnDeadlock', () => {
  it('returns the result of a first try that works', async () => {
    const attempt = jest.fn().mockResolvedValue('ok');
    await expect(retryOnDeadlock(attempt)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('tries again after a deadlock and returns the later success', async () => {
    const attempt = jest.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockResolvedValue('ok');
    await expect(retryOnDeadlock(attempt)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last attempt and throws the deadlock itself', async () => {
    const attempt = jest.fn().mockRejectedValue(deadlock());
    await expect(retryOnDeadlock(attempt, { attempts: 3 })).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('never retries any other error', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(retryOnDeadlock(attempt)).rejects.toThrow('boom');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
