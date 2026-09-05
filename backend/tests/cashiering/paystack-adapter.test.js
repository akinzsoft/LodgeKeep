'use strict';

/**
 * `src/modules/cashiering/paystack-adapter.js` — PLAN.md Phase 2.5's real
 * Paystack sandbox integration.
 *
 * `verifyWebhookSignature` is pure crypto (HMAC-SHA512) and is tested here
 * directly against a known secret/body/signature triple — no network, no
 * dependency on real sandbox credentials being present. `initializeTransaction`/
 * `verifyTransaction` make REAL calls to `https://api.paystack.co`; those
 * tests are gated on `PAYSTACK_SECRET_KEY` actually being configured in this
 * environment (`.env`) and are skipped, not failed, when it is absent —
 * this codebase's environment does not always carry sandbox credentials
 * (CI, a contributor's own machine), and a missing-credential skip is
 * meaningfully different from a real regression. See `service.js`'s tests
 * (`tests/cashiering/cashiering.test.js`) for the deterministic, mocked-adapter
 * coverage of the payment state machine itself.
 */

const crypto = require('crypto');

describe('paystack-adapter: verifyWebhookSignature (pure crypto, no network)', () => {
  const ORIGINAL_SECRET = process.env.PAYSTACK_SECRET_KEY;

  beforeAll(() => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_secret_for_signature_tests';
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = ORIGINAL_SECRET;
  });

  // Re-required after PAYSTACK_SECRET_KEY is set — the module reads it lazily
  // per-call (`secretKey()`), so a plain top-level require would work too,
  // but isolating the module registry keeps this test file independent of
  // require-order relative to other test files in the same run.
  let verifyWebhookSignature;
  beforeEach(() => {
    jest.resetModules();
    ({ verifyWebhookSignature } = require('../../src/modules/cashiering/paystack-adapter'));
  });

  it('accepts a signature that is the real HMAC-SHA512 of the raw body under the secret key', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const signature = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    expect(verifyWebhookSignature({ rawBody, signatureHeader: signature })).toBe(true);
  });

  it('rejects a signature computed under the wrong secret', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const wrongSignature = crypto.createHmac('sha512', 'not-the-real-secret').update(rawBody).digest('hex');
    expect(verifyWebhookSignature({ rawBody, signatureHeader: wrongSignature })).toBe(false);
  });

  it('rejects a signature computed over a DIFFERENT body than the one supplied (the exact tamper case API.md §7 exists to catch)', () => {
    const originalBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1', amount: 10000 } }));
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1', amount: 999999 } }));
    const signatureForOriginal = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(originalBody).digest('hex');
    expect(verifyWebhookSignature({ rawBody: tamperedBody, signatureHeader: signatureForOriginal })).toBe(false);
  });

  it('rejects a missing signature header outright', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success' }));
    expect(verifyWebhookSignature({ rawBody, signatureHeader: undefined })).toBe(false);
  });
});

describe('paystack-adapter: real sandbox calls', () => {
  const hasRealCredentials = Boolean(process.env.PAYSTACK_SECRET_KEY);
  const maybeIt = hasRealCredentials ? it : it.skip;

  if (!hasRealCredentials) {
    it('is skipped: no PAYSTACK_SECRET_KEY configured in this environment', () => {
      expect(hasRealCredentials).toBe(false);
    });
  }

  maybeIt('initializes a real transaction against the Paystack sandbox and gets back a usable authorization_url', async () => {
    const { initializeTransaction } = require('../../src/modules/cashiering/paystack-adapter');
    const reference = `lodgekeep-test-${Date.now()}`;
    const result = await initializeTransaction({
      email: 'lodgekeep-test@example.com',
      amount: '100.00',
      currency: 'NGN',
      reference,
    });
    expect(result.authorizationUrl).toMatch(/^https:\/\//);
    expect(result.reference).toBe(reference);
  });

  maybeIt('verifying a reference that was never charged reports a non-success status, not an error', async () => {
    const { initializeTransaction, verifyTransaction } = require('../../src/modules/cashiering/paystack-adapter');
    const reference = `lodgekeep-test-unpaid-${Date.now()}`;
    await initializeTransaction({ email: 'lodgekeep-test@example.com', amount: '50.00', currency: 'NGN', reference });

    const result = await verifyTransaction({ reference });
    expect(result.status).not.toBe('success');
    expect(result.reference).toBe(reference);
  });

  // Not gated on hasRealCredentials — this test explicitly removes the key
  // itself, so it is meaningful (and should run) with or without a real one
  // configured in the ambient environment.
  it('throws GatewayNotConfiguredError when the secret key is absent, rather than silently no-opping', async () => {
    jest.resetModules();
    const original = process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SECRET_KEY;
    try {
      const { initializeTransaction, GatewayNotConfiguredError } = require('../../src/modules/cashiering/paystack-adapter');
      await expect(initializeTransaction({ email: 'x@example.com', amount: '10.00', currency: 'NGN', reference: 'r' })).rejects.toBeInstanceOf(
        GatewayNotConfiguredError
      );
    } finally {
      process.env.PAYSTACK_SECRET_KEY = original;
    }
  });
});
