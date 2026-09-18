'use strict';

/**
 * Real-network round-trip test for `verifyTurnstileToken` — security-
 * review finding, `captcha-verify.js`'s own header. Same "test the real
 * infrastructure, not a mock" discipline this codebase already applies to
 * Redis/BullMQ and `isPasswordBreached`'s own real HaveIBeenPwned test —
 * Cloudflare's `siteverify` endpoint is a stable, free, public API that
 * accepts its own OFFICIAL dummy site/secret keys and dummy response
 * token (developers.cloudflare.com/turnstile/troubleshooting/testing/),
 * so a real round trip here needs no live Cloudflare account. Every OTHER
 * test that exercises signup mocks this module instead
 * (`jest.mock('../../src/shared/captcha-verify')` in
 * `tests/signup/signup.test.js`) so the bulk of the suite stays fast and
 * deterministic.
 */

const { verifyTurnstileToken } = require('../../src/shared/captcha-verify');

// Cloudflare's own documented dummy response token — any of the official
// test sitekeys produce exactly this literal string client-side.
const DUMMY_RESPONSE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

describe('verifyTurnstileToken — real Cloudflare Turnstile siteverify API', () => {
  const originalSecret = process.env.TURNSTILE_SECRET_KEY;

  afterEach(() => {
    process.env.TURNSTILE_SECRET_KEY = originalSecret;
  });

  it('reports success for the official "always passes" dummy secret key', async () => {
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    await expect(verifyTurnstileToken(DUMMY_RESPONSE_TOKEN)).resolves.toBe(true);
  });

  it('reports failure for the official "always fails" dummy secret key', async () => {
    process.env.TURNSTILE_SECRET_KEY = '2x0000000000000000000000000000000AA';
    await expect(verifyTurnstileToken(DUMMY_RESPONSE_TOKEN)).resolves.toBe(false);
  });

  it('fails CLOSED (rejects) on a network error, never throwing', async () => {
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      await expect(verifyTurnstileToken(DUMMY_RESPONSE_TOKEN)).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails CLOSED on a non-200 response from the API', async () => {
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    try {
      await expect(verifyTurnstileToken(DUMMY_RESPONSE_TOKEN)).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails CLOSED on a request that takes too long (real timeout, not a happy-path mock)', async () => {
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    const originalFetch = global.fetch;
    global.fetch = jest.fn(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    try {
      await expect(verifyTurnstileToken(DUMMY_RESPONSE_TOKEN)).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  }, 10_000);

  it('returns false when TURNSTILE_SECRET_KEY is unset — defensive only, startup-checks.js should prevent reaching this in a real deployment', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    await expect(verifyTurnstileToken(DUMMY_RESPONSE_TOKEN)).resolves.toBe(false);
  });
});
