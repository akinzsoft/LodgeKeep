'use strict';

/**
 * `src/modules/cashiering/paystack-adapter.js` — PLAN.md Phase 2.5's real
 * Paystack sandbox integration, and its gap-closure rebuild into a
 * multi-currency-capable factory (`buildAdapter(secretKey)` +
 * `resolveAdapterForCurrency`) once guest card payments stopped settling
 * into one shared platform account.
 *
 * `buildAdapter`'s `verifyWebhookSignature` is pure crypto (HMAC-SHA512)
 * and is tested here directly against a known secret/body/signature triple
 * — no network. The other adapter functions make REAL calls to
 * `https://api.paystack.co`; those tests are gated on `PAYSTACK_SECRET_KEY`
 * actually being configured in this environment (`.env`) and are skipped,
 * not failed, when it is absent — this codebase's environment does not
 * always carry sandbox credentials (CI, a contributor's own machine), and
 * a missing-credential skip is meaningfully different from a real
 * regression. See `service.js`'s tests (`tests/cashiering/cashiering.test.js`)
 * for the deterministic, mocked-adapter coverage of the payment state
 * machine itself, and `tests/setup/payment-subaccount.test.js` for
 * `resolveAdapterForCurrency`'s real database resolution.
 */

const crypto = require('crypto');
const { buildAdapter, GatewayNotConfiguredError } = require('../../src/modules/cashiering/paystack-adapter');

describe('paystack-adapter: buildAdapter throws without a secret key', () => {
  it('throws GatewayNotConfiguredError immediately, rather than deferring to the first call', () => {
    expect(() => buildAdapter(undefined)).toThrow(GatewayNotConfiguredError);
    expect(() => buildAdapter('')).toThrow(GatewayNotConfiguredError);
  });
});

describe('paystack-adapter: verifyWebhookSignature (pure crypto, no network)', () => {
  const secretKey = 'sk_test_fixture_secret_for_signature_tests';
  const adapter = buildAdapter(secretKey);

  it('accepts a signature that is the real HMAC-SHA512 of the raw body under the secret key', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: signature })).toBe(true);
  });

  it('rejects a signature computed under the wrong secret', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const wrongSignature = crypto.createHmac('sha512', 'not-the-real-secret').update(rawBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: wrongSignature })).toBe(false);
  });

  it('rejects a signature computed over a DIFFERENT body than the one supplied (the exact tamper case API.md §7 exists to catch)', () => {
    const originalBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1', amount: 10000 } }));
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1', amount: 999999 } }));
    const signatureForOriginal = crypto.createHmac('sha512', secretKey).update(originalBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody: tamperedBody, signatureHeader: signatureForOriginal })).toBe(false);
  });

  it('rejects a missing signature header outright', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success' }));
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: undefined })).toBe(false);
  });

  it('two adapters built from two DIFFERENT secrets disagree on the same signature — the exact property multi-currency verification depends on', () => {
    const otherAdapter = buildAdapter('sk_test_a_completely_different_secret');
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }));
    const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    expect(adapter.verifyWebhookSignature({ rawBody, signatureHeader: signature })).toBe(true);
    expect(otherAdapter.verifyWebhookSignature({ rawBody, signatureHeader: signature })).toBe(false);
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
    const adapter = buildAdapter(process.env.PAYSTACK_SECRET_KEY);
    const reference = `lodgekeep-test-${Date.now()}`;
    const result = await adapter.initializeTransaction({
      email: 'lodgekeep-test@example.com',
      amount: '100.00',
      currency: 'NGN',
      reference,
    });
    expect(result.authorizationUrl).toMatch(/^https:\/\//);
    expect(result.reference).toBe(reference);
  });

  maybeIt('verifying a reference that was never charged reports a non-success status, not an error', async () => {
    const adapter = buildAdapter(process.env.PAYSTACK_SECRET_KEY);
    const reference = `lodgekeep-test-unpaid-${Date.now()}`;
    await adapter.initializeTransaction({ email: 'lodgekeep-test@example.com', amount: '50.00', currency: 'NGN', reference });

    const result = await adapter.verifyTransaction({ reference });
    expect(result.status).not.toBe('success');
    expect(result.reference).toBe(reference);
  });
});
