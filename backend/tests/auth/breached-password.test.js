'use strict';

/**
 * Real-network round-trip test for `isPasswordBreached` — security-review
 * finding, `src/auth/breached-password.js`'s own header. Same "test the
 * real infrastructure, not a mock" discipline this codebase already
 * applies to Redis/BullMQ and (when credentials exist) Paystack — the
 * HaveIBeenPwned range API is a stable, free, public, no-auth endpoint,
 * safe to hit directly from a small, dedicated test file. Every OTHER
 * test in this suite that exercises a real password-setting flow mocks
 * this module instead (`jest.mock('../../src/auth/breached-password')`)
 * so the bulk of the suite stays fast and immune to network flakiness or
 * a coincidentally-breached test fixture password.
 */

const { isPasswordBreached } = require('../../src/auth/breached-password');

describe('isPasswordBreached — real HaveIBeenPwned range API', () => {
  it('reports a genuinely, famously breached password as breached', async () => {
    await expect(isPasswordBreached('password123')).resolves.toBe(true);
  });

  it('reports a genuinely random, never-breached passphrase as not breached', async () => {
    const random = `xk4-${require('crypto').randomBytes(24).toString('hex')}`;
    await expect(isPasswordBreached(random)).resolves.toBe(false);
  });

  it('fails OPEN (reports not breached) on a network error, never throwing', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      await expect(isPasswordBreached('anything')).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails OPEN on a non-200 response from the API', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    try {
      await expect(isPasswordBreached('anything')).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails OPEN on a request that takes too long (real timeout, not a happy-path mock)', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    try {
      await expect(isPasswordBreached('anything')).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  }, 10_000);
});
